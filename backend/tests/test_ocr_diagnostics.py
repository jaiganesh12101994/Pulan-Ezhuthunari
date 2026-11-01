"""
Tests for the OCR diagnostics, quality-control and retry system.

Two clearly separated groups:

* **deterministic** tests that use mocked/known inputs and never call Tesseract
  (crop geometry, quality rules, retry selection, diagnostics store, hashes,
  aggregation, corrections, Unicode preservation, export).
* **integration** tests that run the real Tesseract binary on synthetic and
  scanned pages. They are skipped when Tesseract is unavailable.

Run:

    python -m pytest backend/tests -v

Accuracy statements are only made against a verified reference: the synthetic
pages have a known reference string, and the character/word error rates are
computed with measure_cer_wer(). Scanned-page tests assert structural
invariants (settings recorded, Tamil preserved, artifacts hashed) and print the
measured engine confidence instead of claiming accuracy.
"""

import importlib.util
import json
import os
import re
import sys
import threading

import pytest
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(HERE)
PROJECT_DIR = os.path.dirname(BACKEND_DIR)
SAMPLES_DIR = os.path.join(PROJECT_DIR, "public", "samples")

sys.path.insert(0, BACKEND_DIR)
import ocr_diagnostics  # noqa: E402
import ocr_quality  # noqa: E402


def _load_engine():
    spec = importlib.util.spec_from_file_location(
        "tamil_ocr_engine", os.path.join(BACKEND_DIR, "tamil_ocr_engine.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


engine = _load_engine()

TESSERACT = engine.find_tesseract_binary()
requires_tesseract = pytest.mark.skipif(TESSERACT is None, reason="Tesseract binary not installed")

TAMIL = re.compile(r"[\u0b80-\u0bff]")

LEFT_COLUMN = [
    "The Siddha system describes the Tatwas",
    "from the lowest to the greatest,",
    "which is the earth.",
    "Both Vedantists and Siddhantists",
    "accept the number 96 on the ground",
]
RIGHT_COLUMN = [
    "The eighteen Siddhars prepared",
    "medicines from herbs and minerals.",
    "Their verses describe diagnosis",
    "and treatment of chronic illness.",
    "Palm leaf manuscripts preserve them.",
]


def _font(size=24):
    for candidate in ("arial.ttf", "segoeui.ttf", "calibri.ttf"):
        path = os.path.join("C:\\Windows\\Fonts", candidate)
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def make_two_column_page(width=1000, height=620, line_height=30):
    """Synthetic two-column page with a known Latin reference."""
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    font = _font(22)
    for index, line in enumerate(LEFT_COLUMN):
        draw.text((40, 40 + index * line_height), line, fill="black", font=font)
    for index, line in enumerate(RIGHT_COLUMN):
        draw.text((540, 40 + index * line_height), line, fill="black", font=font)
    return image


def make_single_column_page(width=520, height=620, line_height=30):
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    font = _font(22)
    for index, line in enumerate(LEFT_COLUMN):
        draw.text((40, 40 + index * line_height), line, fill="black", font=font)
    return image


def make_tamil_crop(text_lines, width=560, height=200):
    """Render Tamil text without shaping, used only for Unicode round-trip checks."""
    image = Image.new("L", (width, height), "white")
    draw = ImageDraw.Draw(image)
    for index, line in enumerate(text_lines):
        draw.text((20, 20 + index * 40), line, fill="black", font=_font(26))
    return image


def measure_cer_wer(reference, hypothesis):
    """
    Character and word error rates of `hypothesis` against a verified `reference`
    (Levenshtein distance over characters and over words).
    """
    def levenshtein(source, target):
        previous = list(range(len(target) + 1))
        for i, source_item in enumerate(source, start=1):
            current = [i]
            for j, target_item in enumerate(target, start=1):
                current.append(
                    min(
                        previous[j] + 1,
                        current[j - 1] + 1,
                        previous[j - 1] + (source_item != target_item),
                    )
                )
            previous = current
        return previous[-1]

    reference_chars = re.sub(r"\s+", " ", reference or "").strip()
    hypothesis_chars = re.sub(r"\s+", " ", hypothesis or "").strip()
    reference_words = reference_chars.split()
    hypothesis_words = hypothesis_chars.split()
    cer = levenshtein(reference_chars, hypothesis_chars) / max(1, len(reference_chars))
    wer = levenshtein(reference_words, hypothesis_words) / max(1, len(reference_words))
    return round(cer, 4), round(wer, 4)


@pytest.fixture()
def store(tmp_path):
    return ocr_diagnostics.DiagnosticsStore(str(tmp_path / "diagnostics"))


# ---------------------------------------------------------------------------
# Crop geometry — the cause of the manual/automatic inconsistency
# ---------------------------------------------------------------------------
def test_split_crop_columns_finds_both_columns():
    page = make_two_column_page()
    boxes = engine.split_crop_columns(page)
    assert len(boxes) == 2, boxes
    # reading order: left column first, and the boxes must not overlap
    assert boxes[0][0] < boxes[1][0]
    assert boxes[0][2] <= boxes[1][0] + 4


def test_split_crop_columns_leaves_single_column_alone():
    page = make_single_column_page()
    assert engine.split_crop_columns(page) == []


def test_single_block_layout_zone_covers_two_real_columns():
    """Reproduces the reported failure mode: a forced layout mode spans columns."""
    page = make_two_column_page()
    zones = engine.detect_columns_and_layout(page, mode="single")
    assert len(zones) == 1
    zone = zones[0]
    crop = page.crop((zone["x"], zone["y"], zone["x"] + zone["width"], zone["y"] + zone["height"]))
    inner = engine.detect_columns_and_layout(crop, mode="auto")
    assert len(inner) >= 2, "the forced single-block zone should span two real columns"


def test_recognize_region_reads_columns_in_order(monkeypatch):
    """
    A multi-column region must be recognised column by column, in reading order.
    The OCR engine is mocked so the assertion is deterministic.
    """
    calls = []

    def fake_recognize_crop(crop, engine_name, options, psm, lang, trace=None, force_profile=None):
        calls.append(crop.size)
        return f"block{crop.width}", []

    monkeypatch.setattr(engine, "recognize_crop", fake_recognize_crop)
    page = make_two_column_page()
    text, words, boxes = engine.recognize_region(page, "tesseract", {}, 6, "eng")
    assert len(calls) == 2
    assert len(boxes) == 2
    assert text.split("\n\n")[0].startswith("block")
    assert words == []


# ---------------------------------------------------------------------------
# Quality checks — diagnostic signals, never proof of wrong text
# ---------------------------------------------------------------------------
def test_low_resolution_is_reported():
    crop = Image.new("L", (200, 40), "white")
    findings = ocr_quality.check_resolution(crop, 8.0)
    assert [item["code"] for item in findings] == ["low_resolution"]
    assert findings[0]["severity"] == "warning"


def test_blur_and_contrast_are_measured():
    flat = Image.new("L", (200, 200), 128)  # no edges, no contrast
    codes = {item["code"] for item in ocr_quality.check_image_quality(flat)}
    assert "blur" in codes and "low_contrast" in codes

    detailed = Image.new("L", (200, 200), 0)
    for x in range(0, 200, 4):
        for y in range(0, 200, 2):
            detailed.putpixel((x, y), 255)
    assert ocr_quality.check_image_quality(detailed) == []


def test_clipping_detects_ink_on_the_border():
    crop = Image.new("L", (100, 100), "white")
    for y in range(100):
        crop.putpixel((0, y), 0)  # ink touching the left edge
    findings = ocr_quality.check_clipping(crop)
    assert findings and findings[0]["code"] == "clipped_characters"
    assert "left" in findings[0]["detail"]["sides"]

    clean = Image.new("L", (100, 100), "white")
    for y in range(30, 70):
        for x in range(30, 70):
            clean.putpixel((x, y), 0)
    assert ocr_quality.check_clipping(clean) == []


def test_line_gap_and_duplicate_line_findings():
    gaps = ocr_quality.check_line_gaps([(0, 20), (30, 50), (200, 220)])
    assert [item["code"] for item in gaps] == ["possible_missing_lines"]

    duplicated = "ஒரு வரி முழுவதும்\nஒரு வரி முழுவதும்\n"
    codes = {item["code"] for item in ocr_quality.check_text_patterns(duplicated)}
    assert "duplicated_lines" in codes


def test_orphan_combining_mark_is_flagged():
    codes = {item["code"] for item in ocr_quality.check_text_patterns("அ \u0bbe வணக்கம்")}
    assert "orphan_combining_mark" in codes


def test_valid_tamil_and_rare_terms_are_not_flagged():
    """
    Historical spelling, pulli/kombu marks and rare Siddha vocabulary must not be
    reported merely for being uncommon.
    """
    text = "சித்தர்கள் வைத்தியம் குணபாடு அகத்தியர் தீரன் தேரையர் திருமூலர்\nஸ்ரீ சித்தா வைத்திய சூத்திரம்"
    findings = ocr_quality.check_text_patterns(text)
    assert [item for item in findings if item["severity"] in ("warning", "error")] == []


def test_confidence_is_only_reported_when_provided():
    assert ocr_quality.check_confidence(95.0) == []
    assert ocr_quality.check_confidence(90.0, provided=False) == []
    assert ocr_quality.check_confidence(30.0)[0]["code"] == "low_confidence"
    assert ocr_quality.check_confidence(60.0)[0]["code"] == "moderate_confidence"


def test_engine_disagreement_uses_similarity():
    assert ocr_quality.check_engine_disagreement("தமிழ் மொழி", "தமிழ் மொழி") == []
    findings = ocr_quality.check_engine_disagreement("தமிழ் மொழி", "xyz abc")
    assert findings and findings[0]["code"] == "engine_disagreement"


def test_status_vocabulary():
    assert ocr_quality.summarise([]) == "provisional"
    assert ocr_quality.summarise([ocr_quality.finding("blur", "warning", "blurred")]) == "review_required"
    assert ocr_quality.summarise([], failed=True) == "failed"


def test_retry_strategy_matches_the_problem_and_respects_the_budget():
    clipped = [ocr_quality.finding("clipped_characters", "warning", "cut off")]
    assert ocr_quality.choose_retry(clipped, 0, budget=2) == "expand_crop"
    assert ocr_quality.choose_retry(clipped, 2, budget=2) is None  # budget spent
    assert ocr_quality.choose_retry(clipped, 1, budget=2, tried={"expand_crop"}) is None
    low_contrast = [ocr_quality.finding("low_contrast", "warning", "faint")]
    assert ocr_quality.choose_retry(low_contrast, 0, budget=2) == "contrast"
    assert ocr_quality.choose_retry([], 0, budget=2) is None
    # an engine failure is retried with the alternative preprocessing profile
    failure = [ocr_quality.finding("engine_failure", "error", "engine stopped")]
    assert ocr_quality.choose_retry(failure, 0, budget=2) == "alt_profile"


# ---------------------------------------------------------------------------
# Persistent diagnostics store
# ---------------------------------------------------------------------------
def _attempt(region="zone-1", attempt=0, raw="raw text", normalized="normalized text", status="provisional", **extra):
    return {
        "attempt": attempt,
        "rawText": raw,
        "normalizedText": normalized,
        "confidence": 80.0 - attempt,
        "status": status,
        "durationMs": 100 + attempt,
        "engine": "tesseract",
        "engineVersion": "tesseract v5.4.0",
        "model": "eng+tam",
        "settings": {"psm": 6, "oem": 1, "dpi": 200, "language": "tam+eng"},
        "regionBox": {"x": 10, "y": 20, "width": 100, "height": 200},
        "crop": {"width": 100, "height": 200},
        "quality": {"status": status, "findings": [], "warningCodes": []},
        "artifacts": {},
        "warnings": [],
        "error": None,
        "pageNumber": 1,
        "pageWidth": 1000,
        "pageHeight": 800,
        "renderDpi": 200,
        "regionType": "column",
        **extra,
    }


def test_document_id_is_stable_and_filesystem_safe():
    name = "Siddha மருத்துவம் Vol-III (1972).pdf"
    identifier = ocr_diagnostics.document_id_for(name)
    assert identifier == ocr_diagnostics.document_id_for(name)
    assert re.fullmatch(r"[A-Za-z0-9._-]+", identifier)
    assert identifier != ocr_diagnostics.document_id_for("other.pdf")


def test_artifact_is_content_addressed_and_deduplicated(store):
    import hashlib

    image = make_single_column_page()
    first = store.save_artifact(image, "doc-1")
    second = store.save_artifact(image.copy(), "doc-1")
    assert first["hash"] == second["hash"]
    assert os.listdir(store.artifacts_dir("doc-1")) == [first["name"]]
    with open(os.path.join(store.artifacts_dir("doc-1"), first["name"]), "rb") as stream:
        assert hashlib.sha256(stream.read()).hexdigest() == first["hash"]


def test_attempts_and_retries_aggregate(store):
    store.record_attempt("doc-1", "page-1", "zone-1", _attempt(attempt=0, status="review_required"))
    store.record_attempt(
        "doc-1", "page-1", "zone-1", _attempt(attempt=1, normalized="second pass", status="provisional")
    )
    document = store.build_document("doc-1")
    assert document["pageCount"] == 1 and document["regionCount"] == 1
    region = document["pages"][0]["regions"][0]
    assert region["retryCount"] == 1
    assert len(region["attempts"]) == 2
    assert region["latest"]["normalizedText"] == "second pass"
    assert region["status"] == "provisional"
    assert region["attempts"][0]["rawText"] == "raw text"  # earlier attempt kept


def test_concurrent_writers_do_not_overwrite(store):
    def writer(index):
        store.record_attempt("doc-1", "page-1", f"zone-{index}", _attempt(region=f"zone-{index}"))

    threads = [threading.Thread(target=writer, args=(index,)) for index in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert store.build_document("doc-1")["regionCount"] == 8


def test_correction_history_and_verified_protection(store):
    store.record_attempt("doc-1", "page-1", "zone-1", _attempt())
    store.set_correction("doc-1", "page-1", "zone-1", corrected_text="first correction")
    store.set_correction("doc-1", "page-1", "zone-1", corrected_text="second correction", note="fixed term")
    store.set_correction("doc-1", "page-1", "zone-1", verified=True)

    region = store.build_document("doc-1")["pages"][0]["regions"][0]
    assert region["status"] == "verified"
    assert region["finalText"] == "second correction"
    assert [entry["to"] for entry in region["correctionHistory"]] == ["first correction", "second correction"]
    assert region["latest"]["rawText"] == "raw text"  # raw output untouched by corrections

    # a later automatic retry must not silently replace the verified correction
    store.record_attempt("doc-1", "page-1", "zone-1", _attempt(attempt=1, normalized="retry output"))
    region = store.build_document("doc-1")["pages"][0]["regions"][0]
    assert region["status"] == "verified"
    assert region["finalText"] == "second correction"
    assert region["latest"]["normalizedText"] == "retry output"


def test_unresolved_flag_marks_the_region_for_review(store):
    store.record_attempt("doc-1", "page-1", "zone-1", _attempt())
    store.set_correction("doc-1", "page-1", "zone-1", unresolved=True)
    region = store.build_document("doc-1")["pages"][0]["regions"][0]
    assert region["unresolved"] is True
    assert region["status"] == "review_required"


def test_cancellation_keeps_completed_regions(store):
    store.record_attempt("doc-1", "page-1", "zone-1", _attempt(region="zone-1"))
    # a cancelled run simply stops writing; completed records stay readable
    document = store.build_document("doc-1")
    assert document["regionCount"] == 1
    assert document["pages"][0]["regions"][0]["finalText"] == "normalized text"


def test_failed_attempt_is_recorded_with_its_error(store):
    store.record_attempt(
        "doc-1",
        "page-1",
        "zone-1",
        _attempt(status="failed", error="Tesseract did not finish within 60s on this region"),
    )
    region = store.build_document("doc-1")["pages"][0]["regions"][0]
    assert region["status"] == "failed"
    assert "did not finish" in region["latest"]["error"]



# ---------------------------------------------------------------------------
# Tamil Unicode preservation and export
# ---------------------------------------------------------------------------
def test_normalize_preserves_tamil_unicode():
    raw = "  தமிழ்  மொழி \n\n அ \u0bbe வணக்கம்  \n"
    normalized = engine.normalize_tamil_text(raw)
    assert "தமிழ்" in normalized
    assert "வணக்கம்" in normalized
    # every Tamil codepoint of the input survives: nothing is invented or dropped
    assert set(TAMIL.findall(raw)) <= set(TAMIL.findall(normalized))
    # the orphan mark is attached to a base letter instead of being deleted
    assert "\u0bbe" in normalized


def test_export_formats_still_work(tmp_path):
    blocks = [{"page": 1, "type": "column", "text": "தமிழ் மொழி சித்தா"}]
    assert "தமிழ்" in engine.export_document(blocks, "txt")

    payload = json.loads(engine.export_document(blocks, "json"))
    assert payload["blocks"][0]["text"] == "தமிழ் மொழி சித்தா"

    html = engine.export_document(blocks, "html")
    assert html.startswith("<!DOCTYPE html>") and "தமிழ்" in html

    if engine.docx is None:
        # the Python DOCX exporter needs python-docx; the app's DOCX export runs
        # through the server instead. The failure must still be explicit.
        with pytest.raises(RuntimeError, match="python-docx"):
            engine.export_document(blocks, "docx", output_path=str(tmp_path / "out.docx"))
    else:
        docx_path = engine.export_document(blocks, "docx", output_path=str(tmp_path / "out.docx"))
        assert os.path.exists(docx_path) and os.path.getsize(docx_path) > 0


# ---------------------------------------------------------------------------
# Error handling, timeouts and cancellation
# ---------------------------------------------------------------------------
def test_cli_timeout_is_reported_as_ocr_timeout(monkeypatch):
    def fake_run(*args, **kwargs):
        raise engine.subprocess.TimeoutExpired(cmd="tesseract", timeout=engine.TESSERACT_TIMEOUT)

    monkeypatch.setattr(engine.subprocess, "run", fake_run)
    with pytest.raises(engine.OcrTimeout):
        engine._run_tesseract_cli(make_single_column_page(), "tesseract", 6, "eng")


def test_engine_failure_is_recorded_and_retried(monkeypatch):
    calls = []

    def failing_region(crop, engine_name, options, psm, lang, trace=None, force_profile=None):
        calls.append(force_profile)
        if len(calls) == 1:
            raise engine.OcrEngineError("Tesseract recognised no text in this region")
        return "recovered text", [], []

    monkeypatch.setattr(engine, "recognize_region", failing_region)
    result = engine.recognize_with_quality(
        make_single_column_page(), (0, 0, 400, 200), "tesseract", {}, 6, "eng", {"retryBudget": 1}
    )
    assert result["attempts"][0]["error"]
    assert result["attempts"][0]["status"] == "failed"
    assert result["retryCount"] == 1
    assert calls[0] is None  # the first attempt uses the standard settings
    assert result["attempts"][1]["retry"]["strategy"] in ocr_quality.RETRY_DESCRIPTIONS
    assert result["text"] == "recovered text"


def test_retry_never_compounds_the_crop(monkeypatch):
    """
    Every attempt is derived from the original region: an expanding retry is
    applied once, and a later different retry starts from the base crop again.
    """
    crops = []
    findings = [
        ocr_quality.finding("clipped_characters", "warning", "cut off"),
        ocr_quality.finding("low_contrast", "warning", "faint"),
    ]

    def capturing_region(crop, engine_name, options, psm, lang, trace=None, force_profile=None):
        crops.append(crop.size)
        return "", [], []

    monkeypatch.setattr(engine, "recognize_region", capturing_region)
    monkeypatch.setattr(engine, "collect_quality_findings", lambda *a, **k: list(findings))
    engine.recognize_with_quality(
        make_single_column_page(), (50, 50, 300, 200), "tesseract", {}, 6, "eng", {"retryBudget": 2}
    )
    assert len(crops) == 3
    assert crops[0] == (300, 200)  # base crop
    assert crops[1] == (330, 220)  # expanded once
    assert crops[2] == (300, 200)  # contrast retry starts from the base crop again


# ---------------------------------------------------------------------------
# Integration: real Tesseract
# ---------------------------------------------------------------------------
@requires_tesseract
def test_manual_and_zone_crops_agree_on_the_same_paragraph():
    """
    The reported failure: a paragraph read through a multi-column layout zone came
    out wrong while the same paragraph in a hand-drawn box was correct.

    The zone must be read column by column, so the paragraph inside it is
    recognised with the same accuracy as the manual box, and the columns must not
    interleave.
    """
    page = make_two_column_page()
    zone = engine.detect_columns_and_layout(page, mode="single")[0]
    zone_crop = page.crop((zone["x"], zone["y"], zone["x"] + zone["width"], zone["y"] + zone["height"]))
    manual_crop = page.crop((30, 30, 525, 132))  # hand-drawn box over exactly those lines
    reference = " ".join(LEFT_COLUMN[:3])

    zone_text, _, zone_boxes = engine.recognize_region(zone_crop, "tesseract", {}, 6, "eng")
    manual_text, _, _ = engine.recognize_region(manual_crop, "tesseract", {}, 6, "eng")

    # compare like for like: the paragraph's own lines from the zone's first column
    zone_paragraph = " ".join(
        [line for line in zone_text.split("\n") if line.strip()][: len(LEFT_COLUMN[:3])]
    )
    zone_cer, _ = measure_cer_wer(reference, zone_paragraph)
    manual_cer, _ = measure_cer_wer(reference, manual_text)

    def words(value):
        return {word.strip(".,;:!?").lower() for word in value.split() if word.strip(".,;:!?")}

    manual_words, zone_words = words(manual_text), words(zone_text)
    overlap = len(manual_words & zone_words) / max(1, len(manual_words))
    print(
        f"\nmeasured CER: zone paragraph={zone_cer} manual box={manual_cer}"
        f" | paragraph word overlap={round(overlap, 3)}"
    )

    assert len(zone_boxes) == 2, "the zone must be split into its two real columns"
    # reading order: the left column's text comes before the right column's
    assert zone_text.lower().index("siddha") < zone_text.lower().index("eighteen")
    # the paragraph inside the zone matches the hand-drawn box word for word
    assert overlap >= 0.9, f"only {round(overlap * 100)}% of the paragraph's words matched"
    assert zone_cer < 0.15 and manual_cer < 0.15


@requires_tesseract
def test_multi_column_zone_is_better_than_one_block_measurement():
    """
    Measurement (not a claim of a fixed gain): the same page recognised as a
    single block versus split into columns, compared against the reference text.
    """
    page = make_two_column_page()
    reference = " ".join(LEFT_COLUMN + RIGHT_COLUMN)

    whole_text, _ = engine.run_tesseract_tamil(page, psm=6, lang="eng")
    split_text, _, _ = engine.recognize_region(page, "tesseract", {}, 6, "eng")

    whole_cer, whole_wer = measure_cer_wer(reference, whole_text)
    split_cer, split_wer = measure_cer_wer(reference, split_text)
    print(
        f"\nmeasured single block: CER={whole_cer} WER={whole_wer}"
        f" | column split: CER={split_cer} WER={split_wer}"
    )

@requires_tesseract
def test_real_engine_records_settings_artifacts_and_tamil(tmp_path):
    """A real scanned Tamil page must produce complete, hashed diagnostics."""
    sample = os.path.join(SAMPLES_DIR, "11.jpg")
    if not os.path.exists(sample):
        pytest.skip("sample scan not available")

    image = Image.open(sample).convert("RGB")
    crop = image.crop((0, 0, min(image.width, 900), min(image.height, 500)))
    document_id = "sample-11"
    store = ocr_diagnostics.DiagnosticsStore(str(tmp_path))

    result = engine.recognize_with_quality(
        crop,
        None,
        "tesseract",
        {},
        6,
        "tam+eng",
        {
            "dir": str(tmp_path),
            "documentId": document_id,
            "pageId": "page-1",
            "pageNumber": 1,
            "regionId": "zone-1",
            "regionType": "column",
            "retryBudget": 1,
        },
    )
    print(f"\nmeasured mean confidence on the scanned sample: {result['confidence']}")
    attempt = result["attempts"][-1]

    assert attempt["settings"]["psm"] == 6
    assert attempt["settings"]["oem"] == 1
    assert attempt["engineVersion"]
    assert "tam" in attempt["model"]
    assert attempt["transformations"], "preprocessing profile must be recorded"
    assert attempt["quality"]["status"] in {"provisional", "review_required", "failed"}

    for key in ("pageCrop", "ocrCrop"):
        artifact = attempt["artifacts"][key]
        assert artifact and os.path.exists(os.path.join(store.artifacts_dir(document_id), artifact["name"]))

    # Tamil text is preserved end to end (no character substitution)
    if result["text"].strip():
        assert TAMIL.search(result["text"]), "expected Tamil characters in the recognised text"

    document = store.build_document(document_id)
    assert document["regionCount"] == 1


@requires_tesseract
def test_raw_and_normalized_outputs_are_both_recorded(tmp_path):
    sample = os.path.join(SAMPLES_DIR, "english_tamil.jpg")
    if not os.path.exists(sample):
        pytest.skip("sample scan not available")

    image = Image.open(sample).convert("RGB").crop((0, 0, 800, 400))
    result = engine.recognize_with_quality(
        image,
        None,
        "tesseract",
        {},
        6,
        "tam+eng",
        {
            "dir": str(tmp_path),
            "documentId": "sample-en-ta",
            "pageId": "page-1",
            "regionId": "zone-1",
            "retryBudget": 0,
        },
    )
    attempt = result["attempts"][-1]
    assert attempt["rawText"] is not None
    assert attempt["normalizedText"] is not None
    # the normalized text is the cleaned form of the raw engine output
    assert attempt["normalizedText"] == result["text"]


def test_multipage_reading_order_across_a_spread():
    """
    A two-page spread must yield its zones in reading order (left page before the
    right page), which is what keeps multipage output from interleaving pages.
    """
    left = make_single_column_page(width=520, height=620)
    right = make_single_column_page(width=520, height=620)
    spread = Image.new("RGB", (1040, 620), "white")
    spread.paste(left, (0, 0))
    spread.paste(right, (520, 0))

    zones = engine.detect_columns_and_layout(spread, mode="auto")
    assert len(zones) == 2
    assert zones[0]["x"] + zones[0]["width"] <= zones[1]["x"]
    assert [zone["order"] for zone in zones] == [1, 2]


def test_reference_based_accuracy_when_available():
    """
    Accuracy is only asserted against a verified reference. Add a file
    backend/tests/reference/<sample-name>.txt next to a sample image to enable the
    measurement; without one the test reports how to enable it.
    """
    reference_dir = os.path.join(HERE, "reference")
    if not os.path.isdir(reference_dir):
        pytest.skip("no verified reference text committed (see backend/tests/reference/README.md)")
    if TESSERACT is None:
        pytest.skip("Tesseract binary not installed")

    pairs = [
        (name[:-4], os.path.join(reference_dir, name))
        for name in sorted(os.listdir(reference_dir))
        if name.endswith(".txt")
    ]
    if not pairs:
        pytest.skip("reference directory holds no .txt transcription yet (see its README.md)")
    measured = []
    for sample_name, reference_path in pairs:
        image_path = os.path.join(SAMPLES_DIR, f"{sample_name}.jpg")
        if not os.path.exists(image_path):
            continue
        with open(reference_path, "r", encoding="utf-8") as stream:
            reference = stream.read()
        image = Image.open(image_path).convert("RGB")
        result = engine.recognize_with_quality(
            image, None, "tesseract", {}, 6, "tam+eng", {"retryBudget": 0}
        )
        cer, wer = measure_cer_wer(reference, result["text"])
        measured.append((sample_name, cer, wer, result["confidence"]))
        print(f"\n{sample_name}: measured CER={cer} WER={wer} confidence={result['confidence']}")
    assert measured, "no reference file matched a sample image"
    for sample_name, cer, _, _ in measured:
        assert cer < 0.60, f"CER {cer} above the documented acceptance threshold for {sample_name}"

    assert split_cer <= whole_cer
