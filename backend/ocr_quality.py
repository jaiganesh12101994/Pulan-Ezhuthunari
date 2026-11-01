#!/usr/bin/env python3
"""
OCR quality checks and retry strategies for Pulan Ezhuthunari.

These checks are diagnostic signals, not proof that text is wrong. Historical
Tamil spelling, valid combining sequences and rare Siddha terminology are never
flagged merely because they are uncommon, and engine confidence is used only
when the engine actually reports it.

Status vocabulary (shared with the UI):
    provisional      OCR completed, not verified
    review_required  quality checks indicate a possible problem
    verified         explicitly verified by the user
    failed           processing could not complete
"""

import re

TAMIL_BLOCK = "\u0b80-\u0bff"
TAMIL_COMBINING = "\u0bbe-\u0bcd\u0bd7"
LATIN = "A-Za-z"

# Calibrated on the project's scanned Tamil journal pages (see tests)
MIN_LINE_HEIGHT = 12.0  # px of text-line height before resolution is a concern
MIN_SHARPNESS = 45.0  # variance of Laplacian
MIN_CONTRAST = 28.0  # standard deviation of grey levels
SKEW_WARN_DEGREES = 2.0
LINE_GAP_FACTOR = 3.0  # gap vs median line pitch that suggests missing lines
DISAGREEMENT_THRESHOLD = 0.55  # normalised similarity between engine outputs

SEVERITY_ORDER = {"info": 0, "warning": 1, "error": 2}


def finding(code, severity, message, **detail):
    return {"code": code, "severity": severity, "message": message, "detail": detail}


def _grey_stats(image):
    """(mean, standard deviation, sharpness) of a greyscale image."""
    try:
        from PIL import ImageOps

        grey = ImageOps.grayscale(image)
        histogram = grey.histogram()
        total = max(1, grey.width * grey.height)
        mean = sum(i * count for i, count in enumerate(histogram)) / total
        variance = sum(count * (i - mean) ** 2 for i, count in enumerate(histogram)) / total
        std = variance ** 0.5
    except Exception:
        return 0.0, 0.0, 0.0

    sharpness = 0.0
    try:
        import cv2
        import numpy as np

        sharpness = float(cv2.Laplacian(np.array(grey), cv2.CV_64F).var())
    except Exception:
        # Fallback: edge energy via a PIL difference of Gaussians
        try:
            from PIL import ImageFilter

            edges = grey.filter(ImageFilter.FIND_EDGES)
            data = list(edges.getdata())
            sharpness = sum(data) / max(1, len(data))
        except Exception:
            sharpness = 0.0
    return mean, std, sharpness


def check_resolution(crop, line_height):
    """Text too small to recognise reliably."""
    if crop is None:
        return []
    if line_height and line_height < MIN_LINE_HEIGHT:
        return [
            finding(
                "low_resolution",
                "warning",
                f"Text line height is only {round(line_height, 1)}px; recognition may be unreliable.",
                lineHeight=round(line_height, 1),
                minLineHeight=MIN_LINE_HEIGHT,
                cropWidth=crop.width,
                cropHeight=crop.height,
            )
        ]
    return []


def check_image_quality(crop):
    """Blur and contrast, measured on the crop handed to the engine."""
    if crop is None:
        return []
    mean, std, sharpness = _grey_stats(crop)
    findings = []
    # 0 is a real measurement (a perfectly flat crop), not "unknown"
    if sharpness < MIN_SHARPNESS:
        findings.append(
            finding(
                "blur",
                "warning",
                f"Low image sharpness ({round(sharpness, 1)}); strokes may be smeared.",
                sharpness=round(sharpness, 1),
                threshold=MIN_SHARPNESS,
            )
        )
    if std < MIN_CONTRAST:
        findings.append(
            finding(
                "low_contrast",
                "warning",
                f"Low contrast ({round(std, 1)}); faint text may be dropped.",
                contrast=round(std, 1),
                threshold=MIN_CONTRAST,
                mean=round(mean, 1),
            )
        )
    return findings


def check_skew(angle):
    """Rotation applied by preprocessing (informational, explains retries)."""
    if angle and abs(angle) >= SKEW_WARN_DEGREES:
        return [
            finding(
                "skew",
                "info",
                f"Page is skewed by {round(angle, 1)}°; deskewing was applied.",
                angle=round(angle, 2),
            )
        ]
    return []


def check_clipping(mask, margin_ratio=0.004):
    """
    Ink touching the crop border suggests characters were cut off by the zone.
    """
    if mask is None or mask.width < 8 or mask.height < 8:
        return []
    try:
        profile_rows = _row_profile(mask)
        profile_cols = _col_profile(mask)
        margin_y = max(1, int(mask.height * margin_ratio))
        margin_x = max(1, int(mask.width * margin_ratio))
        sides = []
        if any(value > 0.02 for value in profile_rows[:margin_y]):
            sides.append("top")
        if any(value > 0.02 for value in profile_rows[-margin_y:]):
            sides.append("bottom")
        if any(value > 0.02 for value in profile_cols[:margin_x]):
            sides.append("left")
        if any(value > 0.02 for value in profile_cols[-margin_x:]):
            sides.append("right")
        if sides:
            return [
                finding(
                    "clipped_characters",
                    "warning",
                    f"Ink touches the {', '.join(sides)} edge of the region; characters may be cut off.",
                    sides=sides,
                )
            ]
    except Exception:
        return []
    return []


def _row_profile(mask):
    from PIL import Image

    strip = mask.resize((1, mask.height), Image.BOX)
    return [1.0 - (value / 255.0) for value in strip.getdata()]


def _col_profile(mask):
    from PIL import Image

    strip = mask.resize((mask.width, 1), Image.BOX)
    return [1.0 - (value / 255.0) for value in strip.getdata()]


def check_line_gaps(bands):
    """
    Unusually large gaps between text lines suggest lines were missed by the
    crop or that the region covers two blocks.
    """
    if not bands or len(bands) < 3:
        return []
    gaps = sorted(bands[i + 1][0] - bands[i][1] - 1 for i in range(len(bands) - 1))
    pitch = sorted(bands[i + 1][0] - bands[i][0] for i in range(len(bands) - 1))
    # lower-middle median: robust for the small band counts a region has
    median_pitch = pitch[(len(pitch) - 1) // 2] if pitch else 0
    largest = gaps[-1] if gaps else 0
    if median_pitch and largest > median_pitch * LINE_GAP_FACTOR:
        return [
            finding(
                "possible_missing_lines",
                "warning",
                f"A gap of {largest}px (median line pitch {median_pitch}px) may contain lines that were not captured.",
                largestGap=largest,
                medianPitch=median_pitch,
            )
        ]
    return []


def check_confidence(mean_confidence, provided=True):
    """Low engine confidence is a signal to review, not proof of wrong text."""
    if not provided or mean_confidence is None:
        return []
    if mean_confidence < 55:
        return [
            finding(
                "low_confidence",
                "warning",
                f"Engine mean word confidence is {round(mean_confidence, 1)}%.",
                confidence=round(mean_confidence, 1),
            )
        ]
    if mean_confidence < 70:
        return [
            finding(
                "moderate_confidence",
                "info",
                f"Engine mean word confidence is {round(mean_confidence, 1)}%.",
                confidence=round(mean_confidence, 1),
            )
        ]
    return []


def check_text_patterns(text):
    """
    Text-level signals. Deliberately conservative: unusual but valid Tamil,
    historical spelling and Siddha terminology are not flagged for being rare.
    """
    findings = []
    if not text or not text.strip():
        return findings

    lines = [line.strip() for line in text.split("\n")]
    non_empty = [line for line in lines if line]

    # Duplicated adjacent lines (the same line recognised twice)
    for index in range(len(non_empty) - 1):
        first, second = non_empty[index], non_empty[index + 1]
        if len(first) > 6 and first == second:
            findings.append(
                finding(
                    "duplicated_lines",
                    "warning",
                    "The same line was recognised twice in a row.",
                    line=first[:60],
                    lineNumber=index + 1,
                )
            )
            break

    control = [ch for ch in text if ord(ch) < 32 and ch not in "\n\r\t"]
    if control:
        findings.append(
            finding(
                "control_characters",
                "warning",
                f"{len(control)} control character(s) present in the recognised text.",
                count=len(control),
            )
        )

    zero_width = len(re.findall(r"[\u200b-\u200f\u202a-\u202e\ufeff]", text))
    if zero_width:
        findings.append(
            finding(
                "zero_width_marks",
                "info",
                f"{zero_width} zero-width or directional mark(s) remain in the raw output.",
                count=zero_width,
            )
        )

    # A combining mark must follow a base letter, never a space or a line start
    orphan = re.findall(rf"(?:^|\s)([{TAMIL_COMBINING}])", text)
    if orphan:
        findings.append(
            finding(
                "orphan_combining_mark",
                "warning",
                f"{len(orphan)} combining mark(s) appear without a base letter.",
                count=len(orphan),
            )
        )

    # Mixed-script tokens are legitimate for transliteration, so informational
    mixed = re.findall(rf"\b(?=[^\s]*[{LATIN}])(?=[^\s]*[{TAMIL_BLOCK}])[^\s]{{2,}}\b", text)
    if mixed:
        findings.append(
            finding(
                "mixed_script_tokens",
                "info",
                f"{len(mixed)} token(s) mix Tamil and Latin characters.",
                samples=[token[:24] for token in mixed[:5]],
            )
        )
    return findings


def text_similarity(text_a, text_b):
    """Character-level Dice coefficient of the two whitespace-stripped texts."""
    import re as _re
    from collections import Counter

    first = _re.sub(r"\s+", "", text_a or "")
    second = _re.sub(r"\s+", "", text_b or "")
    if not first or not second:
        return 0.0
    counts_a, counts_b = Counter(first), Counter(second)
    overlap = sum(min(counts_a[ch], counts_b[ch]) for ch in counts_a.keys() | counts_b.keys())
    return 2.0 * overlap / (len(first) + len(second))


def check_engine_disagreement(text_a, text_b, engine_a="tesseract", engine_b="surya"):
    """
    Compare two independent engine outputs. A large disagreement is a signal to
    review the region; it is never used to overwrite one result with the other.
    """
    if not text_a or not text_b:
        return []
    similarity = text_similarity(text_a, text_b)
    if similarity < DISAGREEMENT_THRESHOLD:
        return [
            finding(
                "engine_disagreement",
                "info",
                f"{engine_a} and {engine_b} agree on only {round(similarity * 100)}% of the text.",
                similarity=round(similarity, 3),
                engineA=engine_a,
                engineB=engine_b,
            )
        ]
    return []


def check_failure(error_message):
    return [finding("engine_failure", "error", error_message or "OCR did not complete.")]


def summarise(findings, failed=False):
    """Map findings onto the shared processing status vocabulary."""
    if failed:
        return "failed"
    if any(item["severity"] in ("warning", "error") for item in findings):
        return "review_required"
    return "provisional"


def warning_codes(findings):
    return sorted({item["code"] for item in findings if item["severity"] in ("warning", "error")})


def choose_retry(findings, attempt, budget=2, tried=None):
    """
    Pick the retry strategy that matches the diagnosed problem, or None when the
    retry budget is spent, nothing actionable was found, or every applicable
    strategy has already been attempted.
    """
    if attempt >= budget:
        return None
    tried = set(tried or ())
    codes = {item["code"] for item in findings}
    candidates = []
    if "clipped_characters" in codes or "possible_missing_lines" in codes:
        candidates.append("expand_crop")
    if "low_contrast" in codes or "blur" in codes:
        candidates.append("contrast")
    if "low_resolution" in codes:
        candidates.append("upscale")
    if codes & {"duplicated_lines", "orphan_combining_mark", "low_confidence", "engine_failure"}:
        candidates.append("alt_profile")
    for name in candidates:
        if name not in tried:
            return name
    return None


RETRY_DESCRIPTIONS = {
    "expand_crop": "expanded the crop inside the page bounds",
    "contrast": "applied conservative contrast enhancement",
    "upscale": "increased the recognition scale",
    "alt_profile": "used the alternative preprocessing profile",
    "deskew": "applied corrected orientation",
}

