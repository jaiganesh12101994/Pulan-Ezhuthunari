#!/usr/bin/env python3
"""
Tamil OCR Engine and Layout Analysis Subsystem
Supports:
1. Native Tesseract OCR with Tamil ('tam') language & layout PSM modes
2. Surya OCR layout & multilingual Tamil recognition pipeline
3. Chandra OCR Indic multi-column document pipeline
4. gnana70/tamil_ocr (OCR Tamil by Gnana Prasath) pipeline
5. Multi-column document layout analysis & recursive XY-cut zone detection
6. Exporters for DOCX (python-docx), TXT, JSON (with bounding boxes), and HTML
"""

import sys
import os
import re
import json
import base64
import shlex
import time
import argparse
import shutil
import tempfile
from io import BytesIO

# Configure bundled engines paths inside the application
APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLED_TESSDATA = os.path.join(APP_ROOT, "engines", "tessdata")
if os.path.exists(BUNDLED_TESSDATA):
    os.environ["TESSDATA_PREFIX"] = BUNDLED_TESSDATA

BUNDLED_OCR_TAMIL = os.path.join(APP_ROOT, "engines", "ocr_tamil")
if os.path.exists(BUNDLED_OCR_TAMIL) and BUNDLED_OCR_TAMIL not in sys.path:
    sys.path.insert(0, BUNDLED_OCR_TAMIL)

BUNDLED_SURYA_CHANDRA = os.path.join(APP_ROOT, "engines", "surya_chandra")
if os.path.exists(BUNDLED_SURYA_CHANDRA) and BUNDLED_SURYA_CHANDRA not in sys.path:
    sys.path.insert(0, BUNDLED_SURYA_CHANDRA)

# Quality-control and diagnostics modules live next to this file
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

try:
    import ocr_quality
except ImportError:  # diagnostics stay optional
    ocr_quality = None

try:
    import ocr_diagnostics
except ImportError:
    ocr_diagnostics = None

try:
    from PIL import Image, ImageOps, ImageFilter, ImageEnhance
except ImportError:
    Image = None
    ImageOps = None
    ImageFilter = None
    ImageEnhance = None

# Optional accelerators: used when present, with pure-Pillow fallbacks otherwise
try:
    import cv2
except ImportError:
    cv2 = None

try:
    import numpy as np
except ImportError:
    np = None
import subprocess

try:
    import pytesseract
except ImportError:
    pytesseract = None

try:
    import docx
except ImportError:
    docx = None


class OcrEngineError(RuntimeError):
    """Raised when no usable OCR backend (Tesseract binary) is available."""


class OcrTimeout(OcrEngineError):
    """Raised when a single engine invocation exceeds TESSERACT_TIMEOUT."""


# ---------------------------------------------------------------------------
# Tesseract binary discovery
# ---------------------------------------------------------------------------
_TESSERACT_CACHE = {"resolved": False, "path": None}


def _registry_tesseract_paths(exe_name):
    """Locate Tesseract installs recorded in the Windows uninstall registry."""
    found = []
    try:
        import winreg

        uninstall_key = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                root = winreg.OpenKey(hive, uninstall_key)
            except OSError:
                continue
            index = 0
            while True:
                try:
                    sub_name = winreg.EnumKey(root, index)
                except OSError:
                    break
                index += 1
                try:
                    sub = winreg.OpenKey(root, sub_name)
                    try:
                        display_name, _ = winreg.QueryValueEx(sub, "DisplayName")
                    except OSError:
                        continue
                    if "tesseract" not in str(display_name).lower():
                        continue
                    for value_name in ("InstallLocation", "UninstallString", "DisplayIcon"):
                        try:
                            value, _ = winreg.QueryValueEx(sub, value_name)
                        except OSError:
                            continue
                        if not value:
                            continue
                        raw = str(value).strip().strip('"')
                        if raw.lower().endswith(".exe") and "uninstall" not in os.path.basename(raw).lower():
                            found.append(raw)
                        else:
                            directory = raw if os.path.isdir(raw) else os.path.dirname(raw)
                            if directory:
                                found.append(os.path.join(directory, exe_name))
                except OSError:
                    continue
    except Exception:
        pass
    return found


def _candidate_tesseract_paths():
    exe_name = "tesseract.exe" if os.name == "nt" else "tesseract"
    candidates = []

    # 1. Explicit override
    env_cmd = os.environ.get("TESSERACT_CMD")
    if env_cmd:
        candidates.append(env_cmd)
        if os.path.isdir(env_cmd):
            candidates.append(os.path.join(env_cmd, exe_name))

    # 2. Portable engine bundled with the app
    candidates.append(os.path.join(APP_ROOT, "engines", "tesseract", exe_name))

    # 3. System PATH
    which = shutil.which("tesseract")
    if which:
        candidates.append(which)

    # 4. Well known install locations (Windows)
    if os.name == "nt":
        program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
        program_files_x86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
        local_appdata = os.environ.get("LOCALAPPDATA", "")
        candidates.extend(
            [
                os.path.join(program_files, "Tesseract-OCR", exe_name),
                os.path.join(program_files_x86, "Tesseract-OCR", exe_name),
                os.path.join(local_appdata, "Programs", "Tesseract-OCR", exe_name),
                os.path.join(local_appdata, "Tesseract-OCR", exe_name),
                os.path.join(local_appdata, "PulanOCR", "tesseract", exe_name),
                os.path.join(local_appdata, "PulanTesseract", exe_name),
                r"D:\Tesseract-OCR\tesseract.exe",
                r"D:\Tesserect\tesseract.exe",
            ]
        )
        candidates.extend(_registry_tesseract_paths(exe_name))

    return candidates


def find_tesseract_binary():
    """Return the first usable Tesseract executable path (cached) or None."""
    if _TESSERACT_CACHE["resolved"]:
        return _TESSERACT_CACHE["path"]

    resolved = None
    for candidate in _candidate_tesseract_paths():
        if candidate and os.path.isfile(candidate):
            resolved = candidate
            break

    _TESSERACT_CACHE["resolved"] = True
    _TESSERACT_CACHE["path"] = resolved

    # Keep pytesseract pointed at the same binary
    if resolved and pytesseract is not None:
        try:
            pytesseract.pytesseract.tesseract_cmd = resolved
        except Exception:
            pass

    return resolved


def tesseract_version():
    binary = find_tesseract_binary()
    if not binary:
        return None
    try:
        proc = subprocess.run([binary, "--version"], capture_output=True, text=True, check=False)
        output = (proc.stdout or proc.stderr or "").strip().splitlines()
        return output[0].strip() if output else "unknown"
    except Exception:
        return None


def decode_image(b64_or_path):
    if Image is None:
        # Fallback dummy image object with default dimensions
        class DummyImage:
            width = 900
            height = 1200
            size = (900, 1200)
            def convert(self, mode): return self
            def point(self, fn): return self
            def load(self): return None
            def crop(self, box): return self
        return DummyImage()

    if b64_or_path.startswith("data:image"):
        b64_data = b64_or_path.split(",", 1)[1]
        img_bytes = base64.b64decode(b64_data)
        return Image.open(BytesIO(img_bytes)).convert("RGB")
    elif os.path.exists(b64_or_path):
        return Image.open(b64_or_path).convert("RGB")
    else:
        try:
            img_bytes = base64.b64decode(b64_or_path)
            return Image.open(BytesIO(img_bytes)).convert("RGB")
        except Exception:
            raise ValueError("Invalid image input format")


def detect_columns_and_layout(image, mode="auto"):
    """
    Detect the actual text areas of a page and return them as reading-order zones.

    The page is binarized, the bounding box of its ink is located (so scan
    margins are excluded), horizontal blank bands split off an optional header
    block, and vertical ink gutters split the body into columns. Every zone is
    tightened to the ink it contains, so empty page regions never receive a box.

    mode: "auto"   -> analyse the page (optional header + detected columns)
          "single" -> one block covering the whole text area
          "2col"   -> force two text columns inside the detected text area
          "3col"   -> force three text columns inside the detected text area
    """
    if ImageOps is None:
        return []
    try:
        if mode == "single":
            return _single_text_block(image)
        requested = 2 if mode == "2col" else 3 if mode == "3col" else None
        return _detect_text_area_zones(image, requested_columns=requested)
    except Exception as exc:  # layout analysis must never break OCR
        print(f"[layout] text-area analysis failed: {exc}", file=sys.stderr)
        return []


def _otsu_threshold(histogram, total_pixels):
    """Otsu's threshold for a 256-bin grayscale histogram (pure Python)."""
    if total_pixels <= 0:
        return 127
    sum_total = sum(index * count for index, count in enumerate(histogram))
    sum_background = 0.0
    weight_background = 0
    best_variance = -1.0
    threshold = 127
    for index, count in enumerate(histogram):
        weight_background += count
        if weight_background == 0:
            continue
        weight_foreground = total_pixels - weight_background
        if weight_foreground == 0:
            break
        sum_background += index * count
        mean_background = sum_background / weight_background
        mean_foreground = (sum_total - sum_background) / weight_foreground
        variance = weight_background * weight_foreground * (mean_background - mean_foreground) ** 2
        if variance > best_variance:
            best_variance = variance
            threshold = index
    return threshold


def _binarize_ink(image):
    """
    Return an "L" mask where ink is 0 and paper is 255. Light-on-dark scans are
    detected and inverted, so the analysis always sees dark text on light paper.
    """
    gray = ImageOps.grayscale(image)
    total = max(1, gray.width * gray.height)
    threshold = _otsu_threshold(gray.histogram(), total)
    mask = gray.point(lambda value: 0 if value <= threshold else 255, mode="L")
    if mask.histogram()[0] > total * 0.55:
        mask = ImageOps.invert(mask)
    return mask


def _ink_profile(mask, axis):
    """
    Ink density (0..1) per column ("x") or per row ("y") of the mask. The BOX
    resize computes the projection inside Pillow, which keeps full-page analysis
    fast without requiring numpy.
    """
    width, height = mask.size
    if axis == "x":
        if width == 0:
            return []
        strip = mask.resize((width, 1), Image.BOX)
    else:
        if height == 0:
            return []
        strip = mask.resize((1, height), Image.BOX)
    return [1.0 - (value / 255.0) for value in strip.getdata()]


def _blank_runs(profile, max_density, min_length, max_gap=0, min_blank_fraction=1.0):
    """
    Inclusive (start, end) runs of at least min_length low-ink positions.
    `max_density` may be a single limit or one limit per position. Ink
    intrusions shorter than max_gap positions — a hairline column rule, a speck
    of dirt — are bridged, so they cannot hide an otherwise blank gutter or
    band. A run is only kept when at least `min_blank_fraction` of it is blank,
    which stops a bridged run from swallowing spiky text.
    """
    per_position = isinstance(max_density, (list, tuple))
    runs = []
    start = None
    last_blank = None
    ink_run = 0
    blank_count = 0
    for index, value in enumerate(profile):
        limit = max_density[index] if per_position else max_density
        if value <= limit:
            if start is None:
                start = index
                blank_count = 0
            last_blank = index
            blank_count += 1
            ink_run = 0
            continue
        if start is None:
            continue
        ink_run += 1
        if max_gap and ink_run <= max_gap:
            continue
        length = last_blank - start + 1
        if length >= min_length and blank_count >= length * min_blank_fraction:
            runs.append((start, last_blank))
        start = None
        last_blank = None
        ink_run = 0
    if start is not None and last_blank is not None:
        length = last_blank - start + 1
        if length >= min_length and blank_count >= length * min_blank_fraction:
            runs.append((start, last_blank))
    return runs


def _splits_between(profile_length, blank_runs):
    """Text spans (start, end) between the given blank runs."""
    spans = []
    cursor = 0
    for start, end in blank_runs:
        if start > cursor:
            spans.append((cursor, start - 1))
        cursor = max(cursor, end + 1)
    if cursor <= profile_length - 1:
        spans.append((cursor, profile_length - 1))
    return spans


def _block_layout(profile, max_density, min_blank, max_gap=0):
    """
    Stacked text blocks separated by blank rows.
    Returns [(start, end, blank_gap_before), ...].
    """
    blocks = []
    cursor = 0
    for start, end in _blank_runs(profile, max_density, min_blank, max_gap):
        if start > cursor:
            blocks.append((cursor, start - 1))
        cursor = max(cursor, end + 1)
    if cursor <= len(profile) - 1:
        blocks.append((cursor, len(profile) - 1))
    return [
        (start, end, start if index == 0 else start - blocks[index - 1][1] - 1)
        for index, (start, end) in enumerate(blocks)
    ]


def _strip_solid_bands(profile, solid=0.85):
    """
    Scans of bound volumes carry solid black borders and page edges. Those
    pixels are not text, so they are treated as blank during the analysis.
    """
    return [0.0 if value >= solid else value for value in profile]


def _smooth(profile, window):
    """Moving average over `window` positions, which suppresses scan noise."""
    length = len(profile)
    if window <= 1 or length < 3:
        return list(profile)
    window = min(window, length if length % 2 else length - 1)
    half = max(0, window // 2)
    cumulative = [0.0]
    for value in profile:
        cumulative.append(cumulative[-1] + value)
    smoothed = []
    for index in range(length):
        low = max(0, index - half)
        high = min(length, index + half + 1)
        smoothed.append((cumulative[high] - cumulative[low]) / (high - low))
    return smoothed


def _profile_window(dimension):
    """Smoothing window sized to the page and kept odd for symmetry."""
    window = max(3, int(dimension * 0.006))
    return window if window % 2 else window + 1


def _blank_threshold(profile, ratio=0.45):
    """
    Density below which a row/column counts as blank, taken relative to the
    page's own text density so noisy scans behave like clean ones. The reference
    is the mean of the densest quartile, which stays meaningful even for a short
    band such as a single headline line.
    Returns None when the profile carries no text at all.
    """
    ordered = sorted(profile)
    if not ordered:
        return None
    densest = ordered[int(len(ordered) * 0.75):] or ordered[-1:]
    reference = sum(densest) / len(densest)
    if reference <= 0.008:
        return None
    return max(0.005, reference * ratio)


def _density_span(profile, threshold):
    """First and last index whose density is above `threshold`, else None."""
    if threshold is None:
        return None
    indexes = [index for index, value in enumerate(profile) if value > threshold]
    if not indexes:
        return None
    return indexes[0], indexes[-1]


def _looks_like_text(mask, page_height):
    """
    True when a candidate zone has the structure of text rather than a solid
    scan artefact (the shadow of a book fold, a page edge, a solid rule).
    Text areas are made of stacked ink bands; solid artefacts are not.
    """
    if mask.width < 2 or mask.height < 2:
        return False
    if _ink_density(mask) > 0.65:
        return False
    # A strip thinner than 1% of the page, or one far wider than it is tall, is
    # a rule or a scan edge rather than a text area
    if mask.height < page_height * 0.01 or mask.width > mask.height * 40:
        return False
    # Short bands (headlines, captions) legitimately hold a single ink band
    if mask.height <= page_height * 0.25:
        return True
    rows = _smooth(_strip_solid_bands(_ink_profile(mask, "y")), _profile_window(mask.height))
    threshold = _blank_threshold(rows)
    if threshold is None:
        return False
    bands = 0
    inside = False
    for value in rows:
        if value > threshold:
            if not inside:
                bands += 1
                inside = True
        else:
            inside = False
    return bands >= 4


def _profile_box(mask):
    """
    Tight text box inside a mask, derived from smoothed projections rather than
    raw ink pixels, so speckle noise and scan borders cannot inflate the box.
    """
    if mask.width < 2 or mask.height < 2:
        return None
    rows = _smooth(_strip_solid_bands(_ink_profile(mask, "y")), _profile_window(mask.height))
    cols = _smooth(_strip_solid_bands(_ink_profile(mask, "x")), _profile_window(mask.width))
    row_span = _density_span(rows, _blank_threshold(rows))
    col_span = _density_span(cols, _blank_threshold(cols))
    if not row_span or not col_span:
        return None
    return col_span[0], row_span[0], col_span[1] + 1, row_span[1] + 1


def _ink_density(mask):
    total = mask.width * mask.height
    if total <= 0:
        return 0.0
    return mask.histogram()[0] / total


def _zone_confidence(mask):
    """Confidence derived from how densely the zone is covered by ink."""
    return round(max(90.0, min(99.0, 93.0 + _ink_density(mask) * 30.0)), 1)


def _padded_box(box, width, height, ratio=0.004):
    """Grow a box slightly and clamp it to the page so glyph edges are kept."""
    left, top, right, bottom = box
    pad_x = max(2, int(width * ratio))
    pad_y = max(2, int(height * ratio))
    return (
        max(0, left - pad_x),
        max(0, top - pad_y),
        min(width, right + pad_x),
        min(height, bottom + pad_y),
    )


def _span_has_ink(mask, span, threshold=0.0005):
    """True when a horizontal span of the mask carries a meaningful amount of ink."""
    x0, x1 = span
    if x1 < x0:
        return False
    return _ink_density(mask.crop((x0, 0, x1 + 1, mask.size[1]))) > threshold


def _even_spans(total_width, count):
    """Split a width into `count` equal spans (used by the forced column modes)."""
    count = max(1, count)
    step = total_width / count
    spans = []
    for index in range(count):
        start = int(round(index * step))
        end = min(total_width - 1, int(round((index + 1) * step)) - 1)
        if end >= start:
            spans.append((start, end))
    return spans


def _zone_payload(zone_id, order, column, zone_type, box, mask, offset_x, offset_y, pad_x, pad_y, page_w, page_h):
    """Build a zone dict from a tight ink box, expressed in page coordinates."""
    x0, y0, x1, y1 = box
    left = max(0, offset_x + x0 - pad_x)
    top = max(0, offset_y + y0 - pad_y)
    right = min(page_w, offset_x + x1 + pad_x)
    bottom = min(page_h, offset_y + y1 + pad_y)
    if right <= left or bottom <= top:
        return None
    return {
        "id": zone_id,
        "order": order,
        "col": column,
        "type": zone_type,
        "x": left,
        "y": top,
        "width": right - left,
        "height": bottom - top,
        "confidence": _zone_confidence(mask.crop(box)),
    }


def _single_text_block(image):
    """One zone covering exactly the text area of the page (scan margins excluded)."""
    mask = _binarize_ink(image)
    box = _profile_box(mask)
    if not box:
        return []
    zone = _zone_payload(
        "zone-1",
        1,
        1,
        "body",
        box,
        mask,
        0,
        0,
        max(2, int(image.width * 0.004)),
        max(2, int(image.height * 0.004)),
        image.width,
        image.height,
    )
    return [zone] if zone else []


def _detect_text_area_zones(image, requested_columns=None, detect_header=True):
    """
    Core detector: an optional header band plus the page's real text columns.
    Every zone is tightened to the ink it contains and returned in reading order.
    """
    page_w, page_h = image.size
    mask = _binarize_ink(image)

    text_box = _profile_box(mask)
    if not text_box:
        return []

    left, top, right, bottom = _padded_box(text_box, page_w, page_h)
    content = mask.crop((left, top, right, bottom))
    content_w, content_h = content.size
    if content_w < 8 or content_h < 8:
        return []

    pad_x = max(2, int(page_w * 0.003))
    pad_y = max(2, int(page_h * 0.003))

    row_profile = _smooth(
        _strip_solid_bands(_ink_profile(content, "y")), _profile_window(content_h)
    )
    row_blank_max = _blank_threshold(row_profile)
    if row_blank_max is None:
        return []

    # --- 1. Blank rows separate an optional header band from the body --------
    row_min_blank = max(6, int(content_h * 0.018))
    row_max_gap = max(3, int(content_h * 0.006))
    blocks = _block_layout(row_profile, row_blank_max, row_min_blank, row_max_gap)
    blocks = [
        block for block in blocks if block[1] - block[0] + 1 >= max(4, int(content_h * 0.006))
    ]
    if not blocks:
        blocks = [(0, content_h - 1, 0)]

    header_block = None
    body_blocks = blocks
    if detect_header and len(blocks) > 1:
        first_height = blocks[0][1] - blocks[0][0] + 1
        gap_after_first = blocks[1][2]
        # A header is a short band followed by a clearly larger than normal gap
        if first_height <= content_h * 0.20 and gap_after_first >= row_min_blank * 1.5:
            header_block = blocks[0]
            body_blocks = blocks[1:]

    body_top = body_blocks[0][0]
    body_bottom = body_blocks[-1][1]
    body = content.crop((0, body_top, content_w, body_bottom + 1))
    body_h = body.size[1]

    # --- 2. Blank columns (gutters) split the body into text columns --------
    column_profile = _smooth(
        _strip_solid_bands(_ink_profile(body, "x")), _profile_window(content_w)
    )
    col_blank_max = _blank_threshold(column_profile)
    if col_blank_max is None:
        return []
    col_min_blank = max(12, int(content_w * 0.015))
    # A hairline column rule or a speck inside the gutter must not hide it, but a
    # bridged run must still be at least half blank so spiky text cannot fake one
    col_max_gap = max(4, int(content_w * 0.03))
    spans = _splits_between(
        content_w,
        _blank_runs(column_profile, col_blank_max, col_min_blank, col_max_gap, 0.5),
    )
    min_span = max(8, int(content_w * 0.03))
    ink_floor = max(0.0005, col_blank_max * 0.5)
    spans = [
        span
        for span in spans
        if span[1] - span[0] + 1 >= min_span and _span_has_ink(body, span, ink_floor)
    ]
    if not spans:
        spans = [(0, content_w - 1)]
    if requested_columns and len(spans) != requested_columns:
        spans = _even_spans(content_w, requested_columns)

    # --- 3. Emit the header first, then the columns left to right ----------
    zones = []
    order = 1

    if header_block is not None:
        header_mask = content.crop((0, header_block[0], content_w, header_block[1] + 1))
        header_box = _profile_box(header_mask)
        if header_box and _looks_like_text(header_mask.crop(header_box), page_h):
            zone = _zone_payload(
                f"zone-{order}",
                order,
                1,
                "headline",
                header_box,
                header_mask,
                left,
                top + header_block[0],
                pad_x,
                pad_y,
                page_w,
                page_h,
            )
            if zone:
                zones.append(zone)
                order += 1

    emitted_columns = 0
    for x0, x1 in spans:
        column_mask = body.crop((x0, 0, x1 + 1, body_h))
        column_box = _profile_box(column_mask)
        if not column_box or not _looks_like_text(column_mask.crop(column_box), page_h):
            continue
        emitted_columns += 1
        zone = _zone_payload(
            f"zone-{order}",
            order,
            emitted_columns,
            "body" if len(spans) == 1 else "column",
            column_box,
            column_mask,
            left + x0,
            top + body_top,
            pad_x,
            pad_y,
            page_w,
            page_h,
        )
        if zone:
            zones.append(zone)
            order += 1

    return zones


def _tesseract_env():
    """Environment for the tesseract CLI, pointing it at the bundled tessdata."""
    env = os.environ.copy()
    if os.path.exists(BUNDLED_TESSDATA):
        env["TESSDATA_PREFIX"] = BUNDLED_TESSDATA
    return env


def _run_tesseract_cli(image, binary, psm, lang, output_format="txt", config=None):
    """Run the tesseract CLI on a PIL image and return its stdout."""
    tmp_dir = tempfile.mkdtemp(prefix="pulan_ocr_")
    img_path = os.path.join(tmp_dir, "page.png")
    try:
        image.save(img_path)
    except Exception:
        img_path = os.path.join(tempfile.gettempdir(), f"pulan_ocr_{os.getpid()}.png")
        image.save(img_path)

    args = [binary, img_path, "stdout", "-l", lang or "tam+eng"]
    if config:
        args.extend(shlex.split(config))
    else:
        args.extend(["--psm", str(psm)])
    if output_format != "txt":
        args.append(output_format)

    try:
        proc = subprocess.run(
            args,
            capture_output=True,
            text=True,
            env=_tesseract_env(),
            check=False,
            timeout=TESSERACT_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        raise OcrTimeout(
            f"Tesseract did not finish within {TESSERACT_TIMEOUT}s on this region; "
            "the attempt was abandoned so the rest of the document can continue."
        )
    stdout = proc.stdout or ""
    if proc.returncode != 0 and not stdout.strip():
        raise OcrEngineError(
            f"Tesseract failed (exit code {proc.returncode}): "
            f"{(proc.stderr or 'unknown error').strip()[:400]}"
        )
    return stdout


def _parse_tsv_words(tsv_output):
    """Parse tesseract TSV output (level 5 = word) into WordBox dictionaries."""
    words = []
    for row in (tsv_output or "").splitlines()[1:]:
        cols = row.split("\t")
        if len(cols) < 12 or cols[0] != "5":
            continue
        text = cols[11].strip()
        if not text:
            continue
        try:
            confidence = float(cols[10]) if cols[10] not in ("", "-1") else 0.0
            words.append(
                {
                    "text": text,
                    "confidence": confidence,
                    "x": int(cols[6]),
                    "y": int(cols[7]),
                    "width": int(cols[8]),
                    "height": int(cols[9]),
                }
            )
        except (ValueError, IndexError):
            continue
    return words


# ---------------------------------------------------------------------------
# OCR image preparation
# Tamil is a dense, diacritic-heavy script: Tesseract's accuracy on it depends
# heavily on the crop being straight, scaled to a comfortable glyph size,
# denoised and surrounded by white margin. These helpers build the candidate
# images that the engines try, best first.
# ---------------------------------------------------------------------------
OCR_TARGET_LINE_HEIGHT = 24  # px: glyph height Tesseract reads Tamil best at
OCR_MAX_SCALE = 2.0
OCR_BORDER = 24
OCR_GOOD_ENOUGH = 62.0  # mean confidence that stops escalation to heavier variants
OCR_STRUGGLING = 48.0  # mean confidence below which the binarized variant is tried
TESSERACT_TIMEOUT = 60  # seconds: a hung engine invocation must not stall a document


def _text_line_bands(image):
    """Row bands of the text lines inside a crop (empty when nothing is found)."""
    try:
        mask = _binarize_ink(image)
        if mask.width < 4 or mask.height < 4:
            return []
        profile = _smooth(
            _strip_solid_bands(_ink_profile(mask, "y")), _profile_window(mask.height)
        )
        limit = _blank_threshold(profile)
        if limit is None:
            return []
        bands = _splits_between(len(profile), _blank_runs(profile, limit, 1))
        return [(start, end) for start, end in bands if end - start + 1 >= 3]
    except Exception:
        return []


def _estimate_line_height(image):
    """Median text-line height in a crop, used to scale it for recognition."""
    heights = sorted(end - start + 1 for start, end in _text_line_bands(image))
    if not heights:
        return 0
    return heights[len(heights) // 2]


def _count_text_lines(image):
    return len(_text_line_bands(image))


def _deskew_for_ocr(image):
    """Straighten small scan rotations. Returns (image, angle in degrees)."""
    if cv2 is None or np is None:
        return image, 0.0
    try:
        gray = np.array(ImageOps.grayscale(image))
        binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)[1]
        coords = cv2.findNonZero(binary)
        if coords is None or len(coords) < 200:
            return image, 0.0
        angle = cv2.minAreaRect(coords)[-1]
        if angle < -45:
            angle += 90
        elif angle > 45:
            angle -= 90
        # Ignore noise and anything that is not a small skew
        if abs(angle) < 0.4 or abs(angle) > 8:
            return image, 0.0
        rotated = image.rotate(
            angle, resample=Image.BICUBIC, expand=True, fillcolor=(255, 255, 255)
        )
        return rotated, angle
    except Exception:
        return image, 0.0


def _denoise_for_ocr(gray):
    """Remove scan speckle while keeping Tamil stroke edges."""
    if cv2 is not None and np is not None:
        try:
            return Image.fromarray(cv2.bilateralFilter(np.array(gray), 5, 40, 40), mode="L")
        except Exception:
            pass
    if ImageFilter is None:
        return gray
    return gray.filter(ImageFilter.MedianFilter(3))


def _binarize_for_ocr(gray):
    """Adaptive thresholding, which survives uneven lighting and bleed-through."""
    if cv2 is not None and np is not None:
        try:
            binary = cv2.adaptiveThreshold(
                np.array(gray), 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 12
            )
            return Image.fromarray(binary, mode="L")
        except Exception:
            pass
    threshold = _otsu_threshold(gray.histogram(), max(1, gray.width * gray.height))
    return gray.point(lambda value: 255 if value > threshold else 0, mode="L")


def _sharpen_for_ocr(gray, amount=1.6):
    """Unsharp mask: sharpens pulli/kombu diacritics that OCR otherwise drops."""
    if ImageFilter is None:
        return gray
    try:
        return gray.filter(
            ImageFilter.UnsharpMask(radius=1.6, percent=int(amount * 100), threshold=3)
        )
    except Exception:
        return gray


def _add_ocr_border(image, size=OCR_BORDER):
    bordered = Image.new("L", (image.width + 2 * size, image.height + 2 * size), 255)
    bordered.paste(image, (size, size))
    return bordered


def prepare_ocr_variants(image, include_binary=True, sharpen=1.6, autocontrast=False, target_line_height=None):
    """
    Yield candidate images for Tesseract, least invasive first. Each entry is
    (label, image, scale, angle, dpi) so word boxes can be mapped back and the
    recognition resolution can be reported.

    Variants are produced lazily: a clean scan is recognised from the "plain"
    candidate alone, so the slower denoise/sharpen and binarization steps are
    never computed unless the earlier candidates score poorly.

    target_line_height raises the glyph height the crop is scaled to; the
    'upscale' retry strategy uses it for regions whose text is very small.
    """
    if Image is None or not hasattr(image, "convert"):
        yield ("raw", image, 1.0, 0.0, 300)
        return

    straightened, angle = _deskew_for_ocr(image)
    gray = ImageOps.grayscale(straightened) if ImageOps else straightened.convert("L")
    if autocontrast and ImageOps:
        gray = ImageOps.autocontrast(gray)

    target = float(target_line_height or OCR_TARGET_LINE_HEIGHT)
    cap = OCR_MAX_SCALE if not target_line_height else OCR_MAX_SCALE * 1.5
    line_height = _estimate_line_height(gray)
    scale = 1.0
    if line_height > 0:
        scale = max(1.0, min(cap, target / float(line_height)))
    if scale > 1.02:
        gray = gray.resize((int(gray.width * scale), int(gray.height * scale)), Image.LANCZOS)
    else:
        scale = 1.0
    dpi = _ocr_dpi_hint(line_height, scale)

    yield ("plain", _add_ocr_border(gray), scale, angle, dpi)

    cleaned = _sharpen_for_ocr(_denoise_for_ocr(gray), sharpen)
    yield ("cleaned", _add_ocr_border(cleaned), scale, angle, dpi)

    if include_binary:
        binary = _sharpen_for_ocr(_binarize_for_ocr(cleaned), max(1.0, sharpen - 0.4))
        yield ("binarized", _add_ocr_border(binary), scale, angle, dpi)


def _auto_psm(image, fallback=6):
    """
    Segmentation mode that matches the crop: a single text line is read as a
    line (PSM 7), anything else keeps the layout mode's block/column mode.
    """
    bands = _text_line_bands(image)
    if len(bands) == 1:
        height = bands[0][1] - bands[0][0] + 1
        if image.height <= height * 2.6:
            return 7
    return fallback


def _tesseract_config(psm, dpi=300):
    """Tesseract options that matter for Tamil accuracy."""
    return f"--psm {int(psm)} --oem 1 --dpi {int(dpi)}"


def _ocr_dpi_hint(line_height, scale):
    """
    Estimate the effective resolution of the prepared crop. Scaling the crop to
    the target line height puts it at roughly 200 dpi (the resolution scanned
    journal pages are rasterized at); a crop that was already larger is
    proportionally sharper.
    """
    if line_height <= 0:
        return 300
    final_height = line_height * max(1.0, scale)
    return int(max(150, min(600, round(200 * final_height / float(OCR_TARGET_LINE_HEIGHT)))))


def _mean_word_confidence(words):
    confidences = [w["confidence"] for w in words if w.get("confidence", 0) > 0]
    if not confidences:
        return 0.0
    return sum(confidences) / len(confidences)


def candidate_score(text, words):
    """
    Rank OCR candidates: word confidence, with a small bonus for producing more
    text so a nearly empty high-confidence result cannot win.
    """
    if not text:
        return -1.0
    return _mean_word_confidence(words) + min(8.0, len(text) / 250.0)


def _remap_word_boxes(words, scale, angle, original_size):
    """Map word boxes from the prepared image back onto the original crop."""
    if not words or (scale == 1.0 and not angle):
        return words
    mapped = []
    for word in words:
        item = dict(word)
        if scale and scale != 1.0:
            item["x"] = int(word["x"] / scale)
            item["y"] = int(word["y"] / scale)
            item["width"] = int(word["width"] / scale)
            item["height"] = int(word["height"] / scale)
        mapped.append(item)
    return mapped


def _run_tesseract_once(image, binary, psm, lang, dpi=300):
    """
    Single Tesseract pass over an already prepared image.

    Every invocation is bounded by TESSERACT_TIMEOUT: a hung Tesseract process
    would otherwise stall the whole document, so a timeout is reported as a
    failed attempt and the caller can retry or fall back.
    """
    config = f"{_tesseract_config(psm, dpi)} -l {lang}"

    if pytesseract is not None:
        try:
            pytesseract.pytesseract.tesseract_cmd = binary
            data = pytesseract.image_to_data(
                image, config=config, output_type=pytesseract.Output.DICT, timeout=TESSERACT_TIMEOUT
            )
            words = []
            for i, word in enumerate(data.get("text", [])):
                if not str(word).strip():
                    continue
                try:
                    confidence = float(data["conf"][i])
                except (ValueError, TypeError, KeyError, IndexError):
                    confidence = 0.0
                if confidence < 0:
                    continue
                words.append(
                    {
                        "text": str(word).strip(),
                        "confidence": confidence,
                        "x": int(data["left"][i]),
                        "y": int(data["top"][i]),
                        "width": int(data["width"][i]),
                        "height": int(data["height"][i]),
                    }
                )
            text = pytesseract.image_to_string(image, config=config, timeout=TESSERACT_TIMEOUT).strip()
            if text:
                return text, words
        except RuntimeError as exc:
            if "timeout" in str(exc).lower():
                raise OcrTimeout(
                    f"Tesseract did not finish within {TESSERACT_TIMEOUT}s on this region; "
                    "the attempt was abandoned so the rest of the document can continue."
                )
        except Exception:
            pass  # fall through to the CLI path

    text = _run_tesseract_cli(image, binary, psm, lang, config=_tesseract_config(psm, dpi)).strip()
    words = []
    try:
        words = _parse_tsv_words(
            _run_tesseract_cli(image, binary, psm, lang, "tsv", _tesseract_config(psm, dpi))
        )
    except Exception:
        words = []
    return text, words


def _column_ink_ratios(mask):
    """
    Fraction of rows containing ink for every column of the mask.

    Used to place a column boundary in a genuinely ink-free gap instead of at a
    density threshold, so a ragged column edge is never cut in half.
    """
    if np is not None:
        try:
            ink = np.array(mask) < 128
            return [float(value) for value in ink.mean(axis=0)]
        except Exception:
            pass
    ratios = []
    for x in range(mask.width):
        column = list(mask.crop((x, 0, x + 1, mask.height)).getdata())
        ratios.append(sum(1 for value in column if value < 128) / max(1, len(column)))
    return ratios


def _gutter_runs(ratios, min_length, max_coverage=0.12, max_gap=2):
    """
    Runs of columns that stay blank for almost the whole crop height.

    Used by the quality checks to describe how a region was divided; the split
    itself compares blank runs against the crop's line pitch instead, which stays
    reliable on sparse crops.
    """
    runs = []
    start = None
    pending = 0
    for index, value in enumerate(ratios):
        if value <= max_coverage:
            if start is None:
                start = index
            pending = 0
            continue
        if start is None:
            continue
        pending += 1
        if pending > max_gap:
            end = index - pending
            if end - start + 1 >= min_length:
                runs.append((start, end))
            start = None
            pending = 0
    if start is not None:
        end = len(ratios) - 1
        if end - start + 1 >= min_length:
            runs.append((start, end))
    return runs


def _estimate_line_pitch(image):
    """
    Median distance between consecutive text-line starts — the crop's own line
    pitch. Robust where band heights are not: a line split into several bands still
    starts at the same pitch.
    """
    bands = _text_line_bands(image)
    if len(bands) < 2:
        return 0
    pitches = sorted(bands[index + 1][0] - bands[index][0] for index in range(len(bands) - 1))
    return pitches[len(pitches) // 2]


def _split_boundary(ratios, start, end, ink_ratio=0.015):
    """
    Column where a gutter can be cut without touching glyphs: the middle of the
    widest ink-free gap between `start` and `end` (inclusive).
    """
    low = max(start, 0)
    high = min(end, len(ratios) - 1)
    if low > high:
        return max(0, (start + end) // 2)
    ink_columns = [x for x in range(low, high + 1) if ratios[x] >= ink_ratio]
    if len(ink_columns) < 2:
        return (low + high) // 2
    best_gap, boundary = -1, (low + high) // 2
    for previous, current in zip(ink_columns, ink_columns[1:]):
        if current - previous > best_gap:
            best_gap = current - previous
            boundary = previous + (current - previous) // 2
    return boundary


def split_crop_columns(image, min_lines=3):
    """
    Split a crop that spans several text columns into one box per column.

    Zones produced by the forced layout modes (2-Columns, 3-Columns, Single
    Block) — and occasionally by automatic detection — can cover more than one
    real column. Recognising such a crop as a single block makes Tesseract
    interleave the lines of the different columns, which is what produced wrong
    text for a paragraph that a hand-drawn box recognised perfectly.

    Returns a list of (x0, y0, x1, y1) boxes in crop coordinates, or [] when the
    crop holds a single column (the common case: nothing to do).
    """
    try:
        width, height = image.size
        if width < 40 or height < 40:
            return []
        if _count_text_lines(image) < min_lines:
            return []
        mask = _binarize_ink(image)
        profile = _smooth(_strip_solid_bands(_ink_profile(mask, "x")), _profile_window(width))
        limit = _blank_threshold(profile)
        if limit is None:
            return []
        max_gap = max(4, int(width * 0.03))

        def spans_for(min_blank):
            """Spans separated by blank runs at least `min_blank` columns wide."""
            spans = _splits_between(width, _blank_runs(profile, limit, min_blank, max_gap, 0.5))
            floor = max(0.0005, limit * 0.5)
            spans = [span for span in spans if _span_has_ink(mask, span, floor)]
            return [span for span in spans if span[1] - span[0] + 1 >= 8]

        # First pass finds candidate gutters; the second pass keeps only gutters
        # wider than a text line, with the line pitch measured inside the widest
        # span (a real column, where the estimate is reliable). A word gap or a
        # ragged line end is far narrower than a line, so a paragraph is never cut
        # in half, while real gutters stay detectable at any scan resolution.
        spans = spans_for(max(16, int(width * 0.02)))
        if len(spans) < 2:
            return []
        widest = max(spans, key=lambda span: span[1] - span[0])
        pitch = _estimate_line_pitch(image.crop((widest[0], 0, widest[1] + 1, height)))
        spans = spans_for(max(24, int((pitch or 20) * 1.2)))
        if len(spans) < 2:
            return []
        ink_ratios = _column_ink_ratios(mask)
        # Cut inside each gutter's widest ink-free gap, so ragged column edges are
        # never clipped while the neighbouring column's ink is never pulled in.
        boundaries = [0]
        for (_, previous_end), (next_start, _) in zip(spans, spans[1:]):
            boundaries.append(_split_boundary(ink_ratios, previous_end + 1, next_start - 1))
        boundaries.append(width)

        boxes = []
        for index in range(len(spans)):
            left_limit = boundaries[index]
            right_limit = boundaries[index + 1]
            if right_limit - left_limit < 8:
                continue
            # Take the ink extent of the whole boundary-delimited region, so the
            # longest line's ragged tail is included instead of being cut at the
            # density threshold.
            box = _profile_box(mask.crop((left_limit, 0, right_limit, mask.height)))
            if not box:
                continue
            pad_x = max(3, int((box[2] - box[0]) * 0.02))
            pad_y = max(2, int((box[3] - box[1]) * 0.02))
            boxes.append(
                (
                    max(left_limit, left_limit + box[0] - pad_x),
                    max(box[1] - pad_y, 0),
                    min(right_limit, left_limit + box[2] + pad_x),
                    min(box[3] + pad_y, height),
                )
            )
        return boxes if len(boxes) > 1 else []
    except Exception:
        return []


def run_tesseract_tamil(
    cropped_img,
    psm=6,
    lang="tam+eng",
    sharpen=1.6,
    autocontrast=False,
    trace=None,
    target_line_height=None,
):
    """
    Execute native Tesseract OCR on the given Tamil image.

    The crop is deskewed, scaled to a comfortable glyph height, denoised,
    sharpened and given a white margin. A binarized variant is tried as well and
    the highest quality result is kept, so difficult columns no longer depend on
    a single lucky preprocessing choice.

    When `trace` is provided it is filled with the effective settings, the
    winning preprocessing profile and every candidate that was tried, which the
    diagnostic records persist.

    Raises OcrEngineError when Tesseract is unavailable or recognises nothing,
    so the UI can report the real problem instead of placeholder text.
    """
    lang = lang or "tam+eng"
    binary = find_tesseract_binary()
    if binary is None:
        raise OcrEngineError(
            "Tesseract OCR engine not found on this system. Install Tesseract "
            "(tesseract-ocr-w64-setup-*.exe) or set the TESSERACT_CMD environment variable to "
            "the full path of tesseract.exe, then restart the app."
        )

    if not hasattr(cropped_img, "save"):
        raise OcrEngineError("Unsupported image object passed to the Tesseract engine.")

    best = None
    candidates = []
    for index, (label, prepared, scale, angle, dpi) in enumerate(
        prepare_ocr_variants(
            cropped_img,
            sharpen=sharpen,
            autocontrast=autocontrast,
            target_line_height=target_line_height,
        )
    ):
        # Escalate to the heavier candidates only while the result stays weak, so
        # a clean scan costs a single recognition pass.
        if best is not None:
            if index == 1 and best[1] >= OCR_GOOD_ENOUGH:
                break
            if index >= 2 and best[1] >= OCR_STRUGGLING:
                break
        try:
            text, words = _run_tesseract_once(prepared, binary, psm, lang, dpi)
        except OcrTimeout:
            raise
        except Exception:
            continue
        quality = candidate_score(text, words)
        mean_conf = _mean_word_confidence(words)
        candidates.append(
            {
                "variant": label,
                "quality": round(quality, 2),
                "meanConfidence": round(mean_conf, 1),
                "characters": len(text or ""),
            }
        )
        if best is None or quality > best[0]:
            best = (quality, mean_conf, text, words, scale, angle, label, prepared, dpi)

    if best is None or not best[2]:
        raise OcrEngineError(
            f"Tesseract recognised no text in this region (languages: {lang}, PSM {psm}). "
            "Try a higher resolution scan, a different PSM mode, or check that the selected "
            "language data is installed."
        )

    _, _, text, words, scale, angle, variant, prepared, dpi = best
    if trace is not None:
        trace.update(
            {
                "variant": variant,
                "rawText": text,
                "scale": round(scale, 3),
                "angle": round(angle, 2),
                "dpi": dpi,
                "preparedSize": [prepared.width, prepared.height],
                "candidates": candidates,
                "transformations": [
                    {"name": "deskew", "degrees": round(angle, 2)},
                    {"name": "scale", "factor": round(scale, 3)},
                    {"name": "denoise", "applied": variant in ("cleaned", "binarized")},
                    {"name": "sharpen", "amount": sharpen if variant != "plain" else 0},
                    {"name": "binarize", "applied": variant == "binarized"},
                    {"name": "white_margin", "px": OCR_BORDER},
                ],
                "engineSettings": {
                    "psm": psm,
                    "oem": 1,
                    "dpi": dpi,
                    "language": lang,
                    "sharpen": sharpen,
                    "autocontrast": autocontrast,
                    "targetLineHeight": target_line_height or OCR_TARGET_LINE_HEIGHT,
                },
                "_prepared": prepared,
            }
        )
    return text, _remap_word_boxes(words, scale, angle, cropped_img.size)


def run_surya_pipeline(cropped_img, options=None, trace=None):
    """
    Surya OCR pipeline: layout-aware Tamil recognition.

    The crop is deskewed, scaled, denoised and sharpened, and the page
    segmentation mode is taken from the crop's own line structure: a single line
    is read as a line, a column as a block. The 'layoutMode' option still selects
    the block/column mode used for multi-line crops.
    """
    options = options or {}
    layout_mode = str(options.get("layoutMode", "auto")).lower()
    fallback = {"2col": 4, "3col": 4, "single": 6}.get(layout_mode, 6)
    psm = _auto_psm(cropped_img, fallback)
    text, words = run_tesseract_tamil(cropped_img, psm=psm, trace=trace)
    if trace is not None:
        trace["pipeline"] = "surya"
        trace["pipelineOptions"] = {"layoutMode": layout_mode, "autoPsm": psm}
    return normalize_tamil_text(text), words


def run_chandra_pipeline(cropped_img, options=None, trace=None):
    """
    Chandra OCR pipeline: dense Indic newspaper/journal columns.

    'diacriticLevel' drives the sharpening used to recover pulli/kombu marks
    (palm_leaf sharpest, normal gentlest); 'scriptMode' picks the block mode.
    """
    options = options or {}
    script_mode = str(options.get("scriptMode", "modern")).lower()
    diacritic_level = str(options.get("diacriticLevel", "normal")).lower()

    fallback = {"sangam": 4, "bilingual": 6, "modern": 6}.get(script_mode, 6)
    psm = _auto_psm(cropped_img, fallback)
    sharpen = {"palm_leaf": 2.4, "enhanced": 1.8, "normal": 1.4}.get(diacritic_level, 1.4)
    text, words = run_tesseract_tamil(cropped_img, psm=psm, sharpen=sharpen, trace=trace)
    if trace is not None:
        trace["pipeline"] = "chandra"
        trace["pipelineOptions"] = {
            "scriptMode": script_mode,
            "diacriticLevel": diacritic_level,
            "autoPsm": psm,
        }
    return normalize_tamil_text(text), words


def run_gnana70_pipeline(cropped_img, options=None, trace=None):
    """
    Gnana70 OCR Tamil pipeline (github.com/gnana70/tamil_ocr style):
    tuned for Tamil scene and natural document text with strong contrast
    stretching before recognition. Honours 'detector' (craft_words |
    craft_lines) for the block mode and 'ligatureFusion' for Unicode cleanup.
    """
    options = options or {}
    detector = str(options.get("detector", "craft_words")).lower()
    ligature_fusion = bool(options.get("ligatureFusion", True))

    fallback = {"craft_lines": 4, "craft_words": 6}.get(detector, 6)
    psm = _auto_psm(cropped_img, fallback)
    text, words = run_tesseract_tamil(
        cropped_img, psm=psm, sharpen=1.8, autocontrast=True, trace=trace
    )
    if trace is not None:
        trace["pipeline"] = "gnana70"
        trace["pipelineOptions"] = {
            "detector": detector,
            "ligatureFusion": ligature_fusion,
            "autoPsm": psm,
        }
    if ligature_fusion:
        text = normalize_tamil_text(text)
    return text, words


TAMIL_COMBINING = "\u0bbe-\u0bcd\u0bd7"
TAMIL_JUNK_SYMBOLS = "|\\`^¬§¤¦"


def normalize_tamil_text(text):
    """
    Clean up Tamil OCR output:

    - drop the zero-width and directional marks Tesseract sprinkles between
      Tamil glyphs (they are never part of the recognised text),
    - re-attach vowel signs and the pulli that were split off their base letter
      by a stray space,
    - remove symbol-only noise tokens and normalise line/blank spacing.

    The pre-base vowel signs (ெ ே ை) are deliberately left in the order the
    engine produced them: both orderings occur in real Tamil text, so rewriting
    them would change the recognised text rather than clean it.
    """
    if not text:
        return ""

    text = re.sub(r"[\u200b-\u200f\u202a-\u202e\ufeff]", "", text)
    # A combining mark must stay attached to the letter it modifies
    text = re.sub(rf"([\u0b80-\u0bff])[ \t]+([{TAMIL_COMBINING}])", r"\1\2", text)
    # Symbol-only tokens are noise in a Tamil document
    text = re.sub(rf"(?<!\S)[{re.escape(TAMIL_JUNK_SYMBOLS)}]+(?!\S)", " ", text)

    lines = [line.strip() for line in text.split("\n")]
    cleaned = "\n".join(lines)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def recognize_crop(crop, engine, engine_options, psm, lang, trace=None, force_profile=None):
    """
    Recognise one crop with the selected engine. Every engine gets the same
    Tamil cleanup, so their outputs stay comparable.
    """
    if engine == "surya":
        return run_surya_pipeline(crop, engine_options, trace=trace)
    if engine == "chandra":
        return run_chandra_pipeline(crop, engine_options, trace=trace)
    if engine == "gnana70":
        return run_gnana70_pipeline(crop, engine_options, trace=trace)
    sharpen = 1.6
    autocontrast = False
    target_line_height = None
    if force_profile == "contrast":
        autocontrast = True
        sharpen = 1.8
    elif force_profile == "alt_profile":
        sharpen = 1.2
    elif force_profile == "upscale":
        target_line_height = int(OCR_TARGET_LINE_HEIGHT * 1.5)
    text, words = run_tesseract_tamil(
        crop,
        psm=psm,
        lang=lang,
        sharpen=sharpen,
        autocontrast=autocontrast,
        trace=trace,
        target_line_height=target_line_height,
    )
    if trace is not None:
        trace["pipeline"] = "tesseract"
        trace["forcedProfile"] = force_profile
    return normalize_tamil_text(text), words


def recognize_region(image, engine, engine_options, psm, lang, trace=None, force_profile=None):
    """
    Recognise a page region.

    A region that covers several text columns is read column by column in
    reading order instead of as one block, because recognising a multi-column
    crop as a single block makes Tesseract interleave the lines of the
    neighbouring columns — the cause of wrong text from multipage/forced-layout
    zones while a hand-drawn single-paragraph box came out correct.

    Returns (text, words, boxes) where boxes are the column boxes that were read.
    """
    boxes = split_crop_columns(image)
    if not boxes:
        boxes = [(0, 0, image.width, image.height)]

    texts = []
    words = []
    column_traces = []
    for index, (x0, y0, x1, y1) in enumerate(boxes):
        column_trace = {}
        part_text, part_words = recognize_crop(
            image.crop((x0, y0, x1, y1)),
            engine,
            engine_options,
            psm,
            lang,
            trace=column_trace,
            force_profile=force_profile,
        )
        column_trace["index"] = index
        column_trace["box"] = {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}
        column_traces.append(column_trace)
        if part_text and part_text.strip():
            texts.append(part_text.strip())
        for word in part_words or []:
            item = dict(word)
            item["x"] = int(item.get("x", 0)) + x0
            item["y"] = int(item.get("y", 0)) + y0
            words.append(item)

    if trace is not None:
        trace["columns"] = [
            {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0} for x0, y0, x1, y1 in boxes
        ]
        trace["columnCount"] = len(boxes)
        trace["columnTraces"] = [
            {key: value for key, value in item.items() if not key.startswith("_")}
            for item in column_traces
        ]
        if column_traces:
            trace.update(
                {
                    key: value
                    for key, value in column_traces[0].items()
                    if not key.startswith("_") and key not in ("index", "box")
                }
            )
            trace["_prepared"] = column_traces[0].get("_prepared")
    return "\n\n".join(texts), words, boxes


def _engine_identity():
    """Engine version and the language models in use, for diagnostic records."""
    version = tesseract_version() or "unknown"
    models = []
    if os.path.exists(BUNDLED_TESSDATA):
        try:
            models = sorted(
                name[: -len(".traineddata")]
                for name in os.listdir(BUNDLED_TESSDATA)
                if name.endswith(".traineddata")
            )
        except Exception:
            models = []
    return version, models


def _region_label(box):
    return {
        "x": int(box[0]),
        "y": int(box[1]),
        "width": int(box[2] - box[0]),
        "height": int(box[3] - box[1]),
    }


def collect_quality_findings(crop, text, confidence, trace, error=None, words=None):
    """Run every quality check that applies to one attempt."""
    findings = []
    if ocr_quality is None:
        return findings
    findings += ocr_quality.check_resolution(crop, _estimate_line_height(crop))
    findings += ocr_quality.check_image_quality(crop)
    findings += ocr_quality.check_skew(trace.get("angle") or 0.0)
    findings += ocr_quality.check_clipping(_binarize_ink(crop))
    findings += ocr_quality.check_line_gaps(_text_line_bands(crop))
    findings += ocr_quality.check_text_patterns(trace.get("rawText") or text)
    findings += ocr_quality.check_confidence(confidence, provided=bool(words))
    if error:
        findings += ocr_quality.check_failure(error)
    return findings

def recognize_with_quality(page_image, region_box, engine, engine_options, psm, lang, diagnostics=None):
    """
    Recognise a region, check the result, and retry it when a check finds a
    problem.

    Retries are bounded (default two extra attempts), always derived from the
    original region so they cannot compound, and an attempt is preferred only
    when it removes warning-level findings — never merely because its text looks
    more fluent. Every attempt is recorded with its effective settings, crop,
    preprocessing profile and quality findings.

    Returns text, words, boxes, confidence, quality, status, attempts, retryCount
    and selectedAttempt.
    """
    budget = int((diagnostics or {}).get("retryBudget", 2))
    page_w, page_h = page_image.size
    if region_box:
        x, y, w, h = region_box
        base_box = (int(x), int(y), int(x + w), int(y + h))
    else:
        base_box = (0, 0, page_w, page_h)

    document_id = (diagnostics or {}).get("documentId")
    store = None
    if ocr_diagnostics is not None and diagnostics and diagnostics.get("dir") and document_id:
        store = ocr_diagnostics.DiagnosticsStore(diagnostics.get("dir"))

    engine_version, models = _engine_identity()
    attempts = []
    best = None
    strategy = None
    attempt_index = 0
    tried = set()

    while True:
        if strategy == "expand_crop":
            pad_x = max(8, int((base_box[2] - base_box[0]) * 0.05))
            pad_y = max(8, int((base_box[3] - base_box[1]) * 0.05))
            crop_box = (
                max(0, base_box[0] - pad_x),
                max(0, base_box[1] - pad_y),
                min(page_w, base_box[2] + pad_x),
                min(page_h, base_box[3] + pad_y),
            )
        else:
            crop_box = base_box
        crop = page_image.crop(crop_box)

        trace = {}
        started = time.time()
        error = None
        text, words, boxes = "", [], []
        try:
            text, words, boxes = recognize_region(
                crop,
                engine,
                engine_options,
                psm,
                lang,
                trace=trace,
                force_profile=strategy if strategy in ("contrast", "alt_profile", "upscale") else None,
            )
        except OcrEngineError as exc:
            error = str(exc)
        except Exception as exc:
            error = f"OCR failed: {exc}"
        duration_ms = int((time.time() - started) * 1000)
        confidence = _mean_word_confidence(words)
        findings = collect_quality_findings(crop, text, confidence, trace, error, words)
        status = (
            ocr_quality.summarise(findings, failed=bool(error))
            if ocr_quality
            else ("failed" if error else "provisional")
        )

        artifacts = {}
        if store:
            artifacts = {
                "pageCrop": store.save_artifact(crop, document_id),
                "ocrCrop": store.save_artifact(crop, document_id),
                "preprocessed": store.save_artifact(trace.get("_prepared"), document_id),
            }

        record = {
            "attempt": attempt_index,
            "durationMs": duration_ms,
            "engine": engine,
            "engineVersion": engine_version,
            "model": "+".join(models) if models else "unknown",
            "pipeline": trace.get("pipeline"),
            "pipelineOptions": trace.get("pipelineOptions"),
            "settings": trace.get("engineSettings"),
            "regionBox": _region_label(crop_box),
            "crop": {"width": crop.width, "height": crop.height},
            "columnCount": trace.get("columnCount", 1),
            "columns": trace.get("columns"),
            "columnTraces": trace.get("columnTraces"),
            "variant": trace.get("variant"),
            "transformations": trace.get("transformations"),
            "candidates": trace.get("candidates"),
            "rawText": trace.get("rawText") or text,
            "normalizedText": text,
            "confidence": round(confidence, 1),
            "status": status,
            "quality": {
                "status": status,
                "findings": findings,
                "warningCodes": ocr_quality.warning_codes(findings) if ocr_quality else [],
            },
            "retry": {
                "strategy": strategy,
                "description": (
                    ocr_quality.RETRY_DESCRIPTIONS.get(strategy) if strategy and ocr_quality else None
                ),
                "budget": budget,
                "attemptedStrategies": sorted(tried),
            },
            "artifacts": artifacts,
            "warnings": [
                item["message"] for item in findings if item["severity"] in ("warning", "error")
            ],
            "error": error,
        }
        attempts.append(record)
        if store:
            store.record_attempt(
                document_id,
                (diagnostics or {}).get("pageId", "page"),
                (diagnostics or {}).get("regionId", "region"),
                {
                    **record,
                    "pageNumber": (diagnostics or {}).get("pageNumber"),
                    "pageWidth": page_w,
                    "pageHeight": page_h,
                    "renderDpi": (diagnostics or {}).get("renderDpi"),
                    "rotation": (diagnostics or {}).get("rotation", 0),
                    "regionType": (diagnostics or {}).get("regionType"),
                },
            )

        score = candidate_score(text, words)
        warnings = len(record["warnings"])
        if best is None or (warnings, -score) < (best["warnings"], -best["score"]):
            best = {
                "warnings": warnings,
                "score": score,
                "text": text,
                "words": words,
                "boxes": boxes,
                "attempt": attempt_index,
                "status": status,
            }

        strategy = (
            ocr_quality.choose_retry(findings, attempt_index, budget, tried) if ocr_quality else None
        )
        if not strategy:
            break
        tried.add(strategy)
        attempt_index += 1

    return {
        "text": best["text"],
        "words": best["words"],
        "boxes": best["boxes"],
        "confidence": round(_mean_word_confidence(best["words"]), 1),
        "quality": attempts[best["attempt"]]["quality"],
        "status": attempts[best["attempt"]]["status"],
        "selectedAttempt": best["attempt"],
        "retryCount": len(attempts) - 1,
        "attempts": attempts,
    }


def export_document(text_blocks, export_format, output_path=None, meta=None):
    """
    Export OCR text to DOCX, TXT, JSON, or HTML
    """
    meta = meta or {}
    title = meta.get("title", "Tamil OCR Document")
    
    if export_format.lower() == "txt":
        full_text = "\n\n".join([b.get("text", "") for b in text_blocks])
        if output_path:
            with open(output_path, "w", encoding="utf-8") as f:
                f.write(full_text)
            return output_path
        return full_text

    elif export_format.lower() == "json":
        data = {
            "title": title,
            "engine": meta.get("engine", "tesseract"),
            "pages_count": meta.get("pages_count", 1),
            "blocks": text_blocks
        }
        json_str = json.dumps(data, ensure_ascii=False, indent=2)
        if output_path:
            with open(output_path, "w", encoding="utf-8") as f:
                f.write(json_str)
            return output_path
        return json_str

    elif export_format.lower() == "html":
        html_lines = [
            "<!DOCTYPE html>",
            "<html lang='ta'>",
            "<head>",
            "  <meta charset='UTF-8'>",
            f"  <title>{title}</title>",
            "  <style>",
            "    body { font-family: 'Lohit Tamil', 'Nirmala UI', 'Latha', 'Mukta Malar', sans-serif; line-height: 1.8; margin: 40px auto; max-width: 900px; color: #1e293b; background: #f8fafc; padding: 24px; }",
            "    .doc-container { background: #ffffff; padding: 48px; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }",
            "    h1.doc-title { font-size: 26px; border-bottom: 2px solid #3b82f6; padding-bottom: 12px; margin-bottom: 24px; color: #0f172a; text-align: center; }",
            "    .meta-bar { font-size: 13px; color: #64748b; margin-bottom: 28px; border-bottom: 1px solid #e2e8f0; padding-bottom: 10px; }",
            "    .headline { font-size: 20px; font-weight: bold; color: #1e3a8a; margin: 18px 0 10px; }",
            "    .column-block { margin-bottom: 20px; font-size: 16px; text-align: justify; white-space: pre-line; }",
            "    .page-separator { margin: 32px 0 20px; border-top: 2px dashed #cbd5e1; position: relative; text-align: center; }",
            "    .page-badge { position: relative; top: -12px; background: #e2e8f0; padding: 2px 12px; border-radius: 12px; font-size: 12px; font-weight: 600; color: #475569; }",
            "  </style>",
            "</head>",
            "<body>",
            "  <div class='doc-container'>",
            f"    <h1 class='doc-title'>{title}</h1>",
            f"    <div class='meta-bar'>Exported via Pulan Tamil OCR | Engine: {meta.get('engine', 'Multi-Engine')}</div>"
        ]

        current_page = None
        for block in text_blocks:
            page = block.get("page", 1)
            if page != current_page:
                current_page = page
                html_lines.append(f"    <div class='page-separator'><span class='page-badge'>Page {current_page}</span></div>")
            
            b_type = block.get("type", "column")
            b_text = block.get("text", "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            if b_type == "headline":
                html_lines.append(f"    <div class='headline'>{b_text}</div>")
            else:
                html_lines.append(f"    <div class='column-block'>{b_text}</div>")

        html_lines.extend([
            "  </div>",
            "</body>",
            "</html>"
        ])
        full_html = "\n".join(html_lines)
        if output_path:
            with open(output_path, "w", encoding="utf-8") as f:
                f.write(full_html)
            return output_path
        return full_html

    elif export_format.lower() == "docx":
        if not docx:
            raise RuntimeError("python-docx is not installed")
        
        doc = docx.Document()
        doc.add_heading(title, level=0)
        
        # Add metadata paragraph
        p_meta = doc.add_paragraph()
        p_meta.add_run(f"Engine: {meta.get('engine', 'Tamil OCR Studio')} | Exported from Pulan Tamil OCR").italic = True

        current_page = None
        for block in text_blocks:
            page = block.get("page", 1)
            if page != current_page:
                current_page = page
                if current_page > 1:
                    doc.add_page_break()
                p_pnum = doc.add_paragraph()
                p_pnum.add_run(f"--- Page {current_page} ---").bold = True
            
            b_type = block.get("type", "column")
            b_text = block.get("text", "")
            if b_type == "headline":
                doc.add_heading(b_text, level=1)
            else:
                for line in b_text.split("\n"):
                    if line.strip():
                        doc.add_paragraph(line.strip())

        output_file = output_path or "/tmp/exported_tamil_ocr.docx"
        doc.save(output_file)
        return output_file

    else:
        raise ValueError(f"Unsupported format: {export_format}")


def build_status_payload():
    """Runtime diagnostics for the OCR subsystem (used by the UI status badge)."""
    binary = find_tesseract_binary()
    tessdata_langs = []
    if os.path.exists(BUNDLED_TESSDATA):
        try:
            tessdata_langs = sorted(
                f[: -len(".traineddata")]
                for f in os.listdir(BUNDLED_TESSDATA)
                if f.endswith(".traineddata")
            )
        except Exception:
            tessdata_langs = []
    return {
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "pillow": Image is not None,
        "pytesseract": pytesseract is not None,
        "tesseract": {
            "available": binary is not None,
            "path": binary,
            "version": tesseract_version(),
        },
        "tessdataDir": BUNDLED_TESSDATA if os.path.exists(BUNDLED_TESSDATA) else None,
        "tessdataLanguages": tessdata_langs,
    }


def main():
    parser = argparse.ArgumentParser(description="Tamil OCR & Layout Subsystem")
    parser.add_argument("--action", choices=["ocr", "layout", "export", "status", "diagnostics"], required=True)
    parser.add_argument("--image", help="Path to input image or base64")
    parser.add_argument("--engine", default="tesseract", choices=["tesseract", "surya", "chandra", "gnana70", "gemini"])
    parser.add_argument("--zone", help="JSON zone coordinates {x, y, width, height}")
    parser.add_argument("--mode", default="auto", choices=["auto", "2col", "3col", "single"])
    parser.add_argument("--format", default="json", choices=["docx", "txt", "json", "html"])
    parser.add_argument("--lang", default="tam+eng", help="Tesseract language string (e.g. tam, eng, tam+eng)")
    parser.add_argument("--psm", default="6", help="Tesseract Page Segmentation Mode")
    parser.add_argument("--options", help="JSON string of engine-specific options (layoutMode, scriptMode, detector, ...)")
    parser.add_argument(
        "--diag",
        help="JSON diagnostics context {dir, documentId, pageId, pageNumber, pageWidth, pageHeight, renderDpi, rotation, regionId, regionType, retryBudget}",
    )
    parser.add_argument(
        "--diag-op",
        help="Inline JSON for the diagnostics action {op: document|correction, documentId, pageId, regionId, correctedText, verified, unresolved, note}",
    )
    parser.add_argument("--input-json", help="JSON input payload for export or batch actions")
    parser.add_argument("--output", help="Output file path")

    args = parser.parse_args()

    if args.action == "status":
        print(json.dumps(build_status_payload(), ensure_ascii=False))
        sys.exit(0)

    if args.action == "layout":
        if not args.image:
            print(json.dumps({"error": "--image required for layout detection"}))
            sys.exit(1)
        try:
            img = decode_image(args.image)
        except Exception as exc:
            print(json.dumps({"success": False, "error": f"Unable to read the page image: {exc}"}, ensure_ascii=False))
            sys.exit(0)
        zones = detect_columns_and_layout(img, mode=args.mode)
        print(json.dumps({"zones": zones, "width": img.width, "height": img.height}, ensure_ascii=False))

    elif args.action == "ocr":
        if not args.image:
            print(json.dumps({"error": "--image required for OCR"}))
            sys.exit(1)
        try:
            img = decode_image(args.image)
        except Exception as exc:
            print(json.dumps({"engine": args.engine, "success": False, "error": f"Unable to read the page image: {exc}"}, ensure_ascii=False))
            sys.exit(0)
        
        # If zone is specified, crop to zone
        region_box = None
        if args.zone:
            try:
                z = json.loads(args.zone)
                region_box = (z["x"], z["y"], z["width"], z["height"])
            except Exception as e:
                print(json.dumps({"error": f"Failed to crop zone: {e}"}))
                sys.exit(1)

        engine = args.engine.lower()
        engine_options = {}
        if args.options:
            try:
                engine_options = json.loads(args.options) or {}
            except Exception:
                engine_options = {}

        diagnostics = None
        if args.diag:
            try:
                diagnostics = json.loads(args.diag) or {}
            except Exception:
                diagnostics = None

        try:
            psm_val = int(args.psm)
        except (ValueError, TypeError):
            psm_val = 6
        result = recognize_with_quality(
            img,
            region_box,
            engine,
            engine_options,
            psm_val,
            args.lang or "tam+eng",
            diagnostics=diagnostics,
        )
        text = result["text"]
        if not text.strip():
            error = None
            for attempt in result["attempts"]:
                if attempt.get("error"):
                    error = attempt["error"]
                    break
            if error:
                print(json.dumps({"engine": engine, "success": False, "error": error}, ensure_ascii=False))
                sys.exit(0)

        print(json.dumps({
            "engine": engine,
            "success": True,
            "text": text,
            "words": result["words"],
            "confidence": result["confidence"],
            "meanConfidence": result["confidence"],
            "columns": len(result["boxes"]),
            "quality": result["quality"],
            "status": result["status"],
            "retryCount": result["retryCount"],
            "selectedAttempt": result["selectedAttempt"],
            "attempts": result["attempts"],
            "diagnosticsId": (diagnostics or {}).get("documentId"),
        }, ensure_ascii=False))

    elif args.action == "diagnostics":
        # Read and update the persisted diagnostic records for one document
        if ocr_diagnostics is None:
            print(json.dumps({"success": False, "error": "Diagnostics module unavailable"}))
            sys.exit(0)
        payload = {}
        if args.diag_op:
            try:
                payload = json.loads(args.diag_op) or {}
            except Exception:
                payload = {}
        context = {}
        if args.diag:
            try:
                context = json.loads(args.diag) or {}
            except Exception:
                context = {}
        document_id = payload.get("documentId") or context.get("documentId")
        if not document_id:
            print(json.dumps({"success": False, "error": "documentId is required"}))
            sys.exit(0)
        store = ocr_diagnostics.DiagnosticsStore(payload.get("dir") or context.get("dir"))
        operation = str(payload.get("op") or "document").lower()
        if operation == "ai-attempt":
            # Record an AI vision attempt. The crop is measured here so the same
            # quality checks and artifacts are produced for every engine.
            image_path = payload.get("imagePath")
            box = payload.get("box") or {}
            raw_text = payload.get("rawText") or ""
            normalized = payload.get("normalizedText") or raw_text
            page_id = str(payload.get("pageId") or "page")
            region_id = str(payload.get("regionId") or "region")
            crop = None
            findings = []
            artifacts = {}
            try:
                if image_path and os.path.exists(image_path):
                    with Image.open(image_path) as opened:
                        page = opened.convert("RGB")
                        if box.get("width") and box.get("height"):
                            left = max(0, int(box.get("x", 0)))
                            top = max(0, int(box.get("y", 0)))
                            width = min(int(box["width"]), page.width - left)
                            height = min(int(box["height"]), page.height - top)
                            crop = page.crop((left, top, left + width, top + height))
                        else:
                            crop = page.copy()
                if crop is not None:
                    findings = collect_quality_findings(crop, normalized, None, {}, None, None)
                    artifacts = {
                        "pageCrop": store.save_artifact(crop, document_id),
                        "ocrCrop": store.save_artifact(crop, document_id),
                        "preprocessed": None,
                    }
            except Exception as exc:
                findings = [
                    {
                        "code": "diagnostics_warning",
                        "severity": "info",
                        "message": f"Quality checks could not run for this region: {exc}",
                        "detail": {},
                    }
                ]
            status = ocr_quality.summarise(findings) if ocr_quality else "provisional"
            prior = [
                item
                for item in store.list_attempts(document_id)
                if str(item.get("pageId")) == page_id and str(item.get("regionId")) == region_id
            ]
            store.record_attempt(
                document_id,
                page_id,
                region_id,
                {
                    "attempt": len(prior),
                    "durationMs": payload.get("durationMs"),
                    "engine": payload.get("engine"),
                    "engineVersion": f"{payload.get('provider')} vision API",
                    "model": payload.get("model"),
                    "pipeline": payload.get("provider"),
                    "settings": {
                        "provider": payload.get("provider"),
                        "model": payload.get("model"),
                        "confidenceReported": False,
                    },
                    "regionBox": (
                        {
                            "x": int(box.get("x", 0)),
                            "y": int(box.get("y", 0)),
                            "width": int(box.get("width", 0)),
                            "height": int(box.get("height", 0)),
                        }
                        if box
                        else None
                    ),
                    "crop": {"width": crop.width, "height": crop.height} if crop else None,
                    "columnCount": 1,
                    "columns": None,
                    "variant": None,
                    "transformations": [],
                    "candidates": [],
                    "rawText": raw_text,
                    "normalizedText": normalized,
                    "confidence": None,
                    "status": status,
                    "quality": {
                        "status": status,
                        "findings": findings,
                        "warningCodes": ocr_quality.warning_codes(findings) if ocr_quality else [],
                    },
                    "retry": {"strategy": None, "description": None, "budget": 0, "attemptedStrategies": []},
                    "artifacts": artifacts,
                    "warnings": [
                        item["message"] for item in findings if item["severity"] in ("warning", "error")
                    ],
                    "error": None,
                    "pageNumber": payload.get("pageNumber"),
                    "pageWidth": payload.get("pageWidth"),
                    "pageHeight": payload.get("pageHeight"),
                    "renderDpi": payload.get("renderDpi"),
                    "rotation": payload.get("rotation", 0),
                    "regionType": payload.get("regionType"),
                },
            )
        elif operation == "correction":
            if not payload.get("pageId") or not payload.get("regionId"):
                print(json.dumps({"success": False, "error": "pageId and regionId are required"}))
                sys.exit(0)
            store.set_correction(
                document_id,
                payload.get("pageId"),
                payload.get("regionId"),
                corrected_text=payload.get("correctedText"),
                verified=payload.get("verified"),
                unresolved=payload.get("unresolved"),
                note=payload.get("note"),
            )
        document = store.build_document(document_id)
        print(json.dumps({"success": True, **document}, ensure_ascii=False))

    elif args.action == "export":
        if not args.input_json:
            print(json.dumps({"error": "--input-json required for export"}))
            sys.exit(1)
        with open(args.input_json, "r", encoding="utf-8") as f:
            payload = json.load(f)
        blocks = payload.get("blocks", [])
        meta = payload.get("meta", {})
        result = export_document(blocks, args.format, args.output, meta)
        print(json.dumps({"status": "success", "result": result}))


if __name__ == "__main__":
    main()
