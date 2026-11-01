#!/usr/bin/env python3
"""
The app's OCR tools, re-exposed to Claude through the Agent SDK's in-process MCP
server.

There is no second copy of the OCR business logic here. The document is described
by a *context bundle* that the server writes for each request (page images, zone
boxes, the current selection), and the tools read the same ``DiagnosticsStore``
records and ``ocr_quality`` checks that the rest of the app uses.

Every tool returns MCP content blocks: text for anything Claude reads, and a real
image block for the two image tools, so the model genuinely sees the page.
Failures are returned as ``is_error`` results the model can read and report, never
as exceptions that would end the session.

``OcrToolContext.dispatch`` is the single shared entry point and the ``@tool``
wrappers are one-liners over it. The SDK is imported lazily, so the logic can be
tested (and the sidecar can report a missing SDK) without it installed.
"""

from __future__ import annotations

import base64
import io
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(HERE)
for _path in (BACKEND_DIR, HERE):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import ocr_diagnostics  # noqa: E402
import ocr_quality  # noqa: E402
from permissions import SERVER_NAME  # noqa: E402

#: The tools this app exposes. Nothing else is ever offered to the model.
TOOL_NAMES = (
    "get_document_info",
    "get_page_text",
    "get_page_image",
    "get_line_image",
    "get_low_confidence",
    "compare_engines",
    "get_selection",
    "propose_edit",
)

#: Images larger than this are refused with an explanation rather than sent.
MAX_IMAGE_BYTES = 8 * 1024 * 1024

#: Long edge a page image is scaled to before it is handed to the model. A page
#: rendered at 200 DPI is several megabytes of PNG, which base64-inflates past the
#: Agent SDK's message limit, and the vision model works to roughly this resolution
#: anyway. The caller sets it (see `maxEdge` in the context bundle) so that it can
#: rescale the coordinates it gets back.
DEFAULT_MAX_IMAGE_EDGE = int(os.environ.get("PULAN_AGENT_MAX_IMAGE_EDGE") or 1600)


def text_result(text, is_error=False):
    """A plain MCP text result, optionally flagged as an error."""
    payload = {"content": [{"type": "text", "text": str(text)}]}
    if is_error:
        payload["is_error"] = True
    return payload


def image_result(png_bytes, caption):
    """An MCP result carrying a real image block plus a short text caption."""
    return {
        "content": [
            {"type": "text", "text": caption},
            {
                "type": "image",
                "data": base64.b64encode(png_bytes).decode("ascii"),
                "mimeType": "image/png",
            },
        ]
    }


def latest_of(region):
    """The newest attempt inside an aggregated diagnostics region."""
    return (region or {}).get("latest") or {}


class OcrToolContext:
    """
    Everything the tools may look at, for one request.

    ``bundle`` is the JSON description the server sends: the pages, their rendered
    images, the zones with their pixel boxes, the current selection and the engine
    settings. ``store`` is the shared diagnostics store, so the tools report what
    the app actually recorded rather than re-deriving it.
    """

    def __init__(self, bundle, store=None, proposals_dir=None):
        self.bundle = bundle or {}
        self.store = store or ocr_diagnostics.DiagnosticsStore()
        self.document_id = self.bundle.get("documentId") or ocr_diagnostics.document_id_for(
            self.bundle.get("documentName") or "document"
        )
        self.proposals_dir = proposals_dir or os.path.join(
            self.store.document_dir(self.document_id), "proposals"
        )
        self._diagnostics = None

    # -- shared helpers ---------------------------------------------------
    def dispatch(self, name, arguments):
        """
        The single entry point for every tool. Returns an MCP result dict and
        turns any failure into an ``is_error`` result, so a bad argument can never
        end the session.
        """
        handler = getattr(self, f"tool_{name}", None)
        if handler is None:
            return text_result(f"There is no tool called {name!r}.", is_error=True)
        try:
            return handler(arguments or {})
        except Exception as exc:  # noqa: BLE001 - reported to the model, never raised
            return text_result(f"{name} could not complete: {exc}", is_error=True)

    def pages(self):
        return list(self.bundle.get("pages") or [])

    def page(self, page_id=None):
        pages = self.pages()
        if not pages:
            raise ValueError("This request carried no page information.")
        wanted = str(page_id or self.bundle.get("currentPageId") or pages[0].get("pageId"))
        for page in pages:
            if str(page.get("pageId")) == wanted:
                return page
        known = ", ".join(str(page.get("pageId")) for page in pages)
        raise ValueError(f"There is no page {wanted!r}. Known pages: {known}.")

    def zone(self, page_id, zone_id):
        page = self.page(page_id)
        for zone in page.get("zones") or []:
            if str(zone.get("id")) == str(zone_id):
                return page, zone
        known = ", ".join(str(zone.get("id")) for zone in (page.get("zones") or [])[:20])
        raise ValueError(f"Page {page.get('pageId')} has no zone {zone_id!r}. Known zones: {known}.")

    def diagnostics(self):
        """The aggregated diagnostics document, read once per request."""
        if self._diagnostics is None:
            try:
                self._diagnostics = self.store.build_document(self.document_id)
            except Exception:
                self._diagnostics = {"pages": [], "regionCount": 0, "pageCount": 0}
        return self._diagnostics

    def diagnostic_regions(self, page_id=None):
        """Stored regions for a page, keyed by region id."""
        wanted = None if page_id is None else str(page_id)
        for page in self.diagnostics().get("pages") or []:
            if wanted is None or str(page.get("pageId")) == wanted:
                yield page, {
                    str(region.get("regionId")): region for region in page.get("regions") or []
                }

    # -- tools ------------------------------------------------------------
    @staticmethod
    def _png_bytes(path, max_edge=None):
        """
        Read an image as PNG bytes, scaled so its long edge is at most ``max_edge``.

        Returns ``(data, (width, height))`` so the caller can say what was actually
        sent. Scaling is the caller's decision, because a scaled image means the
        coordinates the model returns are in the scaled space and have to be mapped
        back.
        """
        from PIL import Image

        with Image.open(path) as image:
            if max_edge and max(image.width, image.height) > max_edge:
                factor = max_edge / max(image.width, image.height)
                image = image.resize(
                    (max(1, round(image.width * factor)), max(1, round(image.height * factor))),
                    Image.LANCZOS,
                )
            buffer = io.BytesIO()
            image.convert("RGB").save(buffer, format="PNG")
            return buffer.getvalue(), (image.width, image.height)

    def _max_edge(self, args):
        """The long-edge cap for this request, from the tool call or the bundle."""
        value = args.get("maxEdge") or self.bundle.get("maxEdge") or DEFAULT_MAX_IMAGE_EDGE
        try:
            return int(value)
        except (TypeError, ValueError):
            return DEFAULT_MAX_IMAGE_EDGE

    @staticmethod
    def _box_of(zone):
        """Accept either a nested ``box`` object or flat pixel coordinates."""
        box = zone.get("box")
        if isinstance(box, dict):
            return box
        return zone

    def tool_get_document_info(self, args):
        page = None
        try:
            page = self.page()
        except ValueError:
            page = None
        diagnostics = self.diagnostics()
        lines = [
            f"Document: {self.bundle.get('documentName') or self.document_id}",
            f"Document id: {self.document_id}",
            f"Pages in this request: {len(self.pages())}",
            f"Engines configured: {', '.join(self.bundle.get('engines') or []) or 'none recorded'}",
            f"Languages: {', '.join(self.bundle.get('languages') or []) or 'none recorded'}",
            f"Regions recorded in diagnostics: {diagnostics.get('regionCount', 0)}",
        ]
        if page:
            lines.append(
                f"Current page: {page.get('pageId')} (page {page.get('pageNumber')}), "
                f"{page.get('width')}x{page.get('height')}px at {page.get('renderDpi')} dpi, "
                f"{len(page.get('zones') or [])} zone(s)"
            )
        selection = self.bundle.get("selection")
        lines.append(
            "Current selection: "
            + (json.dumps(selection, ensure_ascii=False) if selection else "none")
        )
        return text_result("\n".join(lines))

    def tool_get_page_text(self, args):
        page = self.page(args.get("pageId"))
        stored = {}
        for _diag_page, regions in self.diagnostic_regions(page.get("pageId")):
            stored = regions
        rows = []
        for zone in page.get("zones") or []:
            region = stored.get(str(zone.get("id"))) or {}
            text = region.get("finalText")
            if text is None:
                text = zone.get("text") or ""
            status = region.get("status") or "not_recorded"
            confidence = latest_of(region).get("confidence")
            suffix = "" if confidence in (None, "") else f", confidence {confidence}"
            rows.append(f"[{zone.get('id')}] {status}{suffix}:\n{text}")
        if not rows:
            fallback = page.get("text") or ""
            if fallback:
                return text_result(
                    f"Page {page.get('pageId')} carries no zones in this request. "
                    f"The page text is:\n{fallback}"
                )
            return text_result(f"No text is recorded for page {page.get('pageId')}.")
        header = (
            f"Page {page.get('pageId')} (page {page.get('pageNumber')}), "
            f"{len(rows)} zone(s), read in reading order:"
        )
        return text_result("\n\n".join([header] + rows))

    def tool_get_page_image(self, args):
        page = self.page(args.get("pageId"))
        path = page.get("imagePath")
        if not path or not os.path.isfile(path):
            return text_result(
                f"The rendered image for page {page.get('pageId')} is not available "
                f"({path or 'no image path was supplied'}).",
                is_error=True,
            )
        data, sent = self._png_bytes(path, self._max_edge(args))
        if len(data) > MAX_IMAGE_BYTES:
            return text_result(
                f"The rendered image for page {page.get('pageId')} is {len(data) // 1024} KB, "
                "larger than this tool will send. Ask for a single region with get_line_image.",
                is_error=True,
            )
        page_size = (page.get("width"), page.get("height"))
        scaled = page_size != sent and all(isinstance(value, int) for value in page_size)
        caption = (
            f"Page {page.get('pageId')} (page {page.get('pageNumber')}): the image you can "
            f"fetch here is {sent[0]}x{sent[1]}px"
            + (
                f", scaled down from {page_size[0]}x{page_size[1]}px. Report coordinates in "
                "the pixels of the image you are shown."
                if scaled
                else f" (rendered at {page.get('renderDpi')} dpi)"
            )
            + f". {len(page.get('zones') or [])} zone(s) were detected on it."
        )
        return image_result(data, caption)

    def tool_get_line_image(self, args):
        selection = self.bundle.get("selection") or {}
        zone_id = args.get("zoneId") or selection.get("zoneId")
        if not zone_id:
            raise ValueError("Give a zoneId, or select a region in the viewer first.")
        page, zone = self.zone(args.get("pageId") or selection.get("pageId"), zone_id)
        path = page.get("imagePath")
        if not path or not os.path.isfile(path):
            return text_result(
                f"The rendered image for page {page.get('pageId')} is not available "
                f"({path or 'no image path was supplied'}).",
                is_error=True,
            )
        box = self._box_of(zone)
        x, y = float(box.get("x") or 0), float(box.get("y") or 0)
        width, height = float(box.get("width") or 0), float(box.get("height") or 0)
        if width <= 0 or height <= 0:
            raise ValueError(f"Zone {zone_id!r} has no usable pixel box in this request.")

        from PIL import Image

        padding = float(args.get("padding") or max(4.0, height * 0.15))
        max_edge = self._max_edge(args)
        with Image.open(path) as image:
            left = max(0, int(x - padding))
            top = max(0, int(y - padding))
            right = min(image.width, int(x + width + padding))
            bottom = min(image.height, int(y + height + padding))
            crop = image.crop((left, top, right, bottom))
            # A crop only has to be legible, so it is capped too: no coordinates come
            # back from it, so scaling it costs nothing.
            if max_edge and max(crop.width, crop.height) > max_edge:
                factor = max_edge / max(crop.width, crop.height)
                crop = crop.resize(
                    (max(1, round(crop.width * factor)), max(1, round(crop.height * factor))),
                    Image.LANCZOS,
                )
            buffer = io.BytesIO()
            crop.save(buffer, format="PNG")
            data = buffer.getvalue()
        caption = (
            f"Zone {zone.get('id')} on page {page.get('pageId')}: "
            f"{zone.get('type') or 'text'} at x={x:.0f} y={y:.0f} w={width:.0f} h={height:.0f}; "
            f"crop {right - left}x{bottom - top}px."
        )
        return image_result(data, caption)

    def tool_get_low_confidence(self, args):
        """
        The regions the app itself flagged for review. The decision is the stored
        one -- the status and warning codes that ``ocr_quality`` produced -- so this
        never invents a threshold of its own; the engine's confidence figure is
        passed on verbatim, with its scale left to the engine that reported it.
        """
        try:
            limit = int(args.get("limit") or 25)
        except (TypeError, ValueError):
            limit = 25
        rows = []
        for _page, regions in self.diagnostic_regions(args.get("pageId")):
            for region_id, region in regions.items():
                latest = latest_of(region)
                quality = latest.get("quality") or {}
                codes = list(quality.get("warningCodes") or [])
                if not codes:
                    codes = ocr_quality.warning_codes(quality.get("findings") or [])
                status = region.get("status")
                if status not in ("review_required", "failed") and not codes:
                    if not region.get("unresolved"):
                        continue
                box = region.get("box") or {}
                rows.append(
                    {
                        "regionId": region_id,
                        "status": status,
                        "engine": latest.get("engine"),
                        "confidence": latest.get("confidence"),
                        "codes": codes,
                        "reasons": [
                            str(item.get("message"))
                            for item in (quality.get("findings") or [])
                            if item.get("severity") in ("warning", "error")
                        ][:4],
                        "retries": region.get("retryCount") or 0,
                        "text": (region.get("finalText") or "")[:400],
                        "y": box.get("y") or 0,
                        "x": box.get("x") or 0,
                    }
                )
        if not rows:
            return text_result(
                "No region is currently flagged for review. Every recorded region is either "
                "verified or carries no warning."
            )
        rows.sort(key=lambda item: (item["y"], item["x"]))
        shown, omitted = rows[:limit], max(0, len(rows) - limit)
        blocks = [f"{len(rows)} region(s) need review; {len(shown)} shown, in reading order."]
        for item in shown:
            confidence = item["confidence"]
            detail = (
                ""
                if confidence in (None, "")
                else f", confidence {confidence} (as the engine reported it)"
            )
            blocks.append(
                f"[{item['regionId']}] {item['status']}{detail}"
                + (f", engine {item['engine']}" if item["engine"] else "")
                + (f", {item['retries']} retr(y/ies)" if item["retries"] else "")
                + (f"\n  reasons: {'; '.join(item['reasons'])}" if item["reasons"] else "")
                + (f"\n  codes: {', '.join(item['codes'])}" if item["codes"] else "")
                + f"\n  text: {item['text']}"
            )
        if omitted:
            blocks.append(f"...and {omitted} more not shown; raise the limit to see them.")
        return text_result("\n\n".join(blocks))

    def tool_compare_engines(self, args):
        """
        Compare what different engines recorded for the same region, using the
        app's own similarity measure. Only engines that actually produced text are
        compared, and a region read by a single engine is reported as uncomparable
        rather than guessed at.
        """
        zone_id = args.get("zoneId")
        try:
            limit = int(args.get("limit") or 10)
        except (TypeError, ValueError):
            limit = 10
        blocks = []
        skipped = 0
        for _page, regions in self.diagnostic_regions(args.get("pageId")):
            for region_id, region in regions.items():
                if zone_id and str(region_id) != str(zone_id):
                    continue
                by_engine = {}
                for attempt in region.get("attempts") or []:
                    text = attempt.get("normalizedText") or attempt.get("rawText") or ""
                    if not text.strip():
                        continue
                    engine = str(attempt.get("engine") or "unknown")
                    by_engine.setdefault(engine, []).append((int(attempt.get("attempt") or 0), text))
                if len(by_engine) < 2:
                    skipped += 1
                    continue
                if len(blocks) >= limit:
                    break
                latest_texts = {engine: sorted(items)[-1][1] for engine, items in by_engine.items()}
                names = sorted(latest_texts)
                pairs = []
                for index, first in enumerate(names):
                    for second in names[index + 1:]:
                        similarity = ocr_quality.text_similarity(
                            latest_texts[first], latest_texts[second]
                        )
                        pairs.append(
                            f"  {first} vs {second}: {round(similarity * 100)}% agreement"
                        )
                listing = "\n".join(f"  {name}: {latest_texts[name][:300]}" for name in names)
                blocks.append(
                    f"[{region_id}] {len(names)} engines: {', '.join(names)}\n"
                    + "\n".join(pairs)
                    + f"\n  latest text per engine:\n{listing}"
                )
        if not blocks:
            if skipped:
                return text_result(
                    f"{skipped} region(s) have been read by only one engine, so there is "
                    "nothing to compare. Run another engine over the page first."
                )
            return text_result("No recorded region matches that request.")
        header = f"{len(blocks)} region(s) read by more than one engine:"
        if skipped:
            header += f" ({skipped} more had a single engine and were not compared)"
        return text_result("\n\n".join([header] + blocks))

    def tool_get_selection(self, args):
        """Whatever the user has selected in the viewer, and what the OCR recorded for it."""
        selection = self.bundle.get("selection") or {}
        if not selection:
            return text_result(
                "Nothing is selected in the viewer at the moment. Ask for a page instead."
            )
        page_id = selection.get("pageId")
        zone_id = selection.get("zoneId")
        lines = [
            f"Selected page: {page_id or 'unknown'}",
            f"Selected zone: {zone_id or 'none'}",
        ]
        if zone_id:
            page, zone = self.zone(page_id, zone_id)
            box = self._box_of(zone)
            lines.append(
                f"Box: x={box.get('x')} y={box.get('y')} "
                f"w={box.get('width')} h={box.get('height')}"
            )
            stored = {}
            for _page, regions in self.diagnostic_regions(page.get("pageId")):
                stored = regions
            region = stored.get(str(zone_id)) or {}
            latest = latest_of(region)
            lines.append(f"Status: {region.get('status') or 'not_recorded'}")
            if latest.get("engine"):
                lines.append(f"Engine: {latest.get('engine')}")
            lines.append(f"Recorded text:\n{region.get('finalText') or zone.get('text') or ''}")
            if region.get("correctedText"):
                lines.append(f"The user has corrected this to:\n{region['correctedText']}")
        elif page_id:
            page = self.page(page_id)
            lines.append(f"Page {page.get('pageId')} carries {len(page.get('zones') or [])} zone(s).")
        return text_result("\n".join(lines))

    def tool_propose_edit(self, args):
        """
        Record a *proposal* for one region. The review flow is untouched: nothing is
        applied, no correction is written, and the user accepts or rejects it in the
        app as they always have.
        """
        selection = self.bundle.get("selection") or {}
        zone_id = args.get("zoneId") or selection.get("zoneId")
        if not zone_id:
            raise ValueError("A proposal needs a zoneId, or a selection in the viewer.")
        if args.get("correctedText") is None:
            raise ValueError("A proposal needs correctedText.")
        page, zone = self.zone(args.get("pageId") or selection.get("pageId"), zone_id)
        stored = {}
        for _page, regions in self.diagnostic_regions(page.get("pageId")):
            stored = regions
        region = stored.get(str(zone_id)) or {}
        proposal = {
            "documentId": self.document_id,
            "pageId": page.get("pageId"),
            "zoneId": str(zone_id),
            "currentText": region.get("finalText") or zone.get("text") or "",
            "proposedText": str(args.get("correctedText")),
            "rationale": str(args.get("rationale") or ""),
            "confidence": args.get("confidence"),
            "source": "claude-subscription",
            "status": "pending",
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        os.makedirs(self.proposals_dir, exist_ok=True)
        name = f"{_safe_name(page.get('pageId'))}__{_safe_name(zone_id)}.json"
        with open(os.path.join(self.proposals_dir, name), "w", encoding="utf-8") as stream:
            json.dump(proposal, stream, ensure_ascii=False, indent=2)
        return text_result(
            f"Proposal recorded for zone {zone_id} on page {page.get('pageId')}, "
            "status pending. The user accepts or rejects it in the app, so do not "
            "describe it as applied.\n\n"
            f"Current text:\n{proposal['currentText']}\n\n"
            f"Proposed text:\n{proposal['proposedText']}"
        )

def _safe_name(value):
    """A filesystem-safe component for a proposal filename."""
    import re

    return re.sub(r"[^A-Za-z0-9._-]+", "_", str(value))[:80] or "item"


def schema(properties, required=()):
    """A complete JSON Schema for a tool's arguments; only ``required`` is enforced."""
    return {"type": "object", "properties": properties, "required": list(required)}


def _arg(description):
    return {"type": "string", "description": description}


#: Every tool: name, description, argument schema, and whether it is read-only.
TOOL_SPECS = (
    (
        "get_document_info",
        "Describe the open document: its name, pages, engines and languages, the page in "
        "view, the current selection, and how many OCR regions have been recorded.",
        schema({}),
        True,
    ),
    (
        "get_page_text",
        "Return the recorded OCR text of a page, region by region in reading order, with "
        "each region's status and the confidence its engine reported.",
        schema({"pageId": _arg("Page id; defaults to the page in view.")}),
        True,
    ),
    (
        "get_page_image",
        "Return the rendered image of a page, so you can look at the page itself.",
        schema({"pageId": _arg("Page id; defaults to the page in view.")}),
        True,
    ),
    (
        "get_line_image",
        "Return a cropped image of one region (a line, paragraph or column) on a page.",
        schema(
            {
                "pageId": _arg("Page id; defaults to the selected page."),
                "zoneId": _arg("Region id; defaults to the selection in the viewer."),
                "padding": {"type": "number", "description": "Extra pixels around the region."},
            }
        ),
        True,
    ),
    (
        "get_low_confidence",
        "List the regions the app flagged for review, with the reasons, the warning codes "
        "and the text that was recorded.",
        schema(
            {
                "pageId": _arg("Limit to one page."),
                "limit": {
                    "type": "integer",
                    "description": "How many regions to list (default 25).",
                },
            }
        ),
        True,
    ),
    (
        "compare_engines",
        "Compare what different OCR engines recorded for the same region, with the app's "
        "own agreement measure.",
        schema(
            {
                "pageId": _arg("Limit to one page."),
                "zoneId": _arg("Limit to one region."),
                "limit": {
                    "type": "integer",
                    "description": "How many regions to compare (default 10).",
                },
            }
        ),
        True,
    ),
    (
        "get_selection",
        "Describe whatever is selected in the viewer, with the text the OCR recorded for it.",
        schema({}),
        True,
    ),
    (
        "propose_edit",
        "Propose corrected text for one region. This records a proposal only; the user "
        "accepts or rejects it, so never describe it as applied.",
        schema(
            {
                "pageId": _arg("Page id; defaults to the selected page."),
                "zoneId": _arg("Region id; defaults to the selection in the viewer."),
                "correctedText": _arg("The corrected Tamil text for that region."),
                "rationale": _arg("Why the text should change, in one or two sentences."),
                "confidence": {"type": "number", "description": "Your confidence, 0 to 1."},
            },
            required=("correctedText",),
        ),
        False,
    ),
)


class ToolBinder:
    """
    Lets one persistent session serve many requests.

    The MCP server (and so the tool closures) is fixed when the session connects,
    but each request describes a different document, page and selection. The tools
    therefore dispatch through this indirection, which always points at the context
    of the request in flight.
    """

    def __init__(self, context=None):
        self.context = context

    def dispatch(self, name, arguments):
        if self.context is None:
            return text_result(
                "No document is attached to this conversation yet.", is_error=True
            )
        return self.context.dispatch(name, arguments)


def build_tools(context):
    """
    Wrap the dispatcher in Agent SDK tools. The SDK is imported here rather than at
    module level, so importing this module never requires the SDK to be installed.
    """
    from claude_agent_sdk import ToolAnnotations, tool

    read_only = ToolAnnotations(readOnlyHint=True, maxResultSizeChars=200000)
    writer = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True)

    def wrapper(name, description, args_schema, annotations):
        @tool(name, description, args_schema, annotations=annotations)
        async def _run(args, _name=name):
            return context.dispatch(_name, args)

        return _run

    return [
        wrapper(name, description, spec, read_only if is_read_only else writer)
        for name, description, spec, is_read_only in TOOL_SPECS
    ]
