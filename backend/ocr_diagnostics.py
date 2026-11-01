#!/usr/bin/env python3
"""
Persistent OCR diagnostics for Pulan Ezhuthunari.

Every OCR attempt is written as its own JSON record, so concurrent workers can
never overwrite each other's data, and image artifacts are stored
content-addressed (one file per unique SHA-256) so identical crops are not
duplicated. Corrections, verification and "unresolved" flags live in their own
records and never touch the raw engine output.

Layout:

    <root>/<documentId>/attempts/<pageId>__<regionId>__<attempt>__<uniq>.json
    <root>/<documentId>/artifacts/<sha256>.png
    <root>/<documentId>/corrections/<pageId>__<regionId>.json
"""

import hashlib
import json
import os
import re
import tempfile
import time

DEFAULT_ROOT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "diagnostics"
)


def store_root():
    return os.environ.get("PULAN_DIAGNOSTICS_DIR") or DEFAULT_ROOT


def document_id_for(name):
    """Stable, filesystem-safe document identifier (so reopening finds its data)."""
    base = os.path.basename(name or "document")
    base = re.sub(r"\.[A-Za-z0-9]{1,6}$", "", base)
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("_")
    slug = slug[:60] or "document"
    digest = hashlib.sha256((name or "document").encode("utf-8")).hexdigest()[:8]
    return f"{slug}-{digest}"


def _atomic_write_json(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    handle, temp_path = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
        os.replace(temp_path, path)
    except Exception:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def _safe_component(value):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", str(value))[:80] or "item"


class DiagnosticsStore:
    def __init__(self, root=None):
        self.root = root or store_root()

    # -- paths ------------------------------------------------------------
    def document_dir(self, document_id):
        return os.path.join(self.root, _safe_component(document_id))

    def artifacts_dir(self, document_id):
        return os.path.join(self.document_dir(document_id), "artifacts")

    def attempts_dir(self, document_id):
        return os.path.join(self.document_dir(document_id), "attempts")

    def corrections_dir(self, document_id):
        return os.path.join(self.document_dir(document_id), "corrections")

    # -- artifacts --------------------------------------------------------
    def save_artifact(self, image, document_id, suffix=".png"):
        """
        Store an image artifact content-addressed. Returns {name, hash, bytes};
        an identical artifact already on disk is reused instead of rewritten.
        """
        if image is None:
            return None
        directory = self.artifacts_dir(document_id)
        os.makedirs(directory, exist_ok=True)
        try:
            import io

            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            data = buffer.getvalue()
        except Exception:
            return None
        digest = hashlib.sha256(data).hexdigest()
        name = f"{digest}{suffix}"
        path = os.path.join(directory, name)
        if not os.path.exists(path):
            handle, temp_path = tempfile.mkstemp(dir=directory, suffix=".tmp")
            with os.fdopen(handle, "wb") as stream:
                stream.write(data)
            os.replace(temp_path, path)
        return {"name": name, "hash": digest, "bytes": len(data)}


    # -- attempt records --------------------------------------------------
    def record_attempt(self, document_id, page_id, region_id, record):
        payload = dict(record)
        payload.setdefault("recordedAt", time.strftime("%Y-%m-%dT%H:%M:%S"))
        payload["documentId"] = document_id
        payload["pageId"] = str(page_id)
        payload["regionId"] = str(region_id)
        attempt = int(payload.get("attempt", 0))
        name = (
            f"{_safe_component(page_id)}__{_safe_component(region_id)}__{attempt:02d}"
            f"__{os.getpid()}{int(time.time() * 1000) % 100000}.json"
        )
        _atomic_write_json(os.path.join(self.attempts_dir(document_id), name), payload)
        return payload

    def list_attempts(self, document_id):
        directory = self.attempts_dir(document_id)
        if not os.path.isdir(directory):
            return []
        records = []
        for name in sorted(os.listdir(directory)):
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(directory, name), "r", encoding="utf-8") as stream:
                    records.append(json.load(stream))
            except Exception:
                continue
        return records

    # -- corrections / verification ---------------------------------------
    def set_correction(
        self,
        document_id,
        page_id,
        region_id,
        corrected_text=None,
        verified=None,
        unresolved=None,
        note=None,
    ):
        """Record a correction/verification separately from the raw OCR output."""
        path = os.path.join(
            self.corrections_dir(document_id),
            f"{_safe_component(page_id)}__{_safe_component(region_id)}.json",
        )
        current = {}
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as stream:
                    current = json.load(stream)
            except Exception:
                current = {}

        history = list(current.get("history") or [])
        now = time.strftime("%Y-%m-%dT%H:%M:%S")
        if corrected_text is not None and corrected_text != current.get("correctedText"):
            history.append(
                {"at": now, "from": current.get("correctedText"), "to": corrected_text, "note": note}
            )
            current["correctedText"] = corrected_text
        if verified is not None:
            current["verified"] = bool(verified)
            current["verifiedAt"] = now if verified else None
        if unresolved is not None:
            current["unresolved"] = bool(unresolved)
        current["updatedAt"] = now
        current["history"] = history[-50:]
        current["documentId"] = document_id
        current["pageId"] = str(page_id)
        current["regionId"] = str(region_id)
        _atomic_write_json(path, current)
        return current


    # -- aggregation for the diagnostic workspace -------------------------
    def build_document(self, document_id):
        """
        Aggregate attempts and corrections into the structure the workspace
        consumes. The latest attempt per region is authoritative; earlier
        attempts remain available as retry history.
        """
        attempts = self.list_attempts(document_id)
        corrections = self.list_corrections(document_id)
        pages = {}
        for record in attempts:
            page_id = str(record.get("pageId"))
            region_id = str(record.get("regionId"))
            page = pages.setdefault(
                page_id,
                {
                    "pageId": page_id,
                    "pageNumber": record.get("pageNumber"),
                    "width": record.get("pageWidth"),
                    "height": record.get("pageHeight"),
                    "renderDpi": record.get("renderDpi"),
                    "rotation": record.get("rotation", 0),
                    "regions": {},
                },
            )
            region = page["regions"].setdefault(
                region_id,
                {
                    "regionId": region_id,
                    "type": record.get("regionType"),
                    "box": record.get("regionBox"),
                    "attempts": [],
                },
            )
            region["attempts"].append(record)

        for page in pages.values():
            for region in page["regions"].values():
                region["attempts"].sort(key=lambda item: int(item.get("attempt", 0)))
                latest = region["attempts"][-1] if region["attempts"] else {}
                correction = corrections.get(f"{page['pageId']}__{region['regionId']}") or {}
                region["latest"] = {
                    "engine": latest.get("engine"),
                    "engineVersion": latest.get("engineVersion"),
                    "model": latest.get("model"),
                    "pipeline": latest.get("pipeline"),
                    "pipelineOptions": latest.get("pipelineOptions"),
                    "settings": latest.get("settings"),
                    "confidence": latest.get("confidence"),
                    "durationMs": latest.get("durationMs"),
                    "rawText": latest.get("rawText"),
                    "normalizedText": latest.get("normalizedText"),
                    "quality": latest.get("quality"),
                    "artifacts": latest.get("artifacts"),
                    "transformations": latest.get("transformations"),
                    "columns": latest.get("columns"),
                    "error": latest.get("error"),
                    "warnings": latest.get("warnings"),
                }
                region["retryCount"] = max(0, len(region["attempts"]) - 1)
                region["correctedText"] = correction.get("correctedText")
                region["verified"] = bool(correction.get("verified"))
                region["unresolved"] = bool(correction.get("unresolved"))
                region["correctionHistory"] = correction.get("history") or []
                region["finalText"] = (
                    region["correctedText"]
                    if region["correctedText"] not in (None, "")
                    else latest.get("normalizedText") or latest.get("rawText") or ""
                )
                if correction.get("verified"):
                    region["status"] = "verified"
                elif correction.get("unresolved"):
                    region["status"] = "review_required"
                elif latest.get("error"):
                    region["status"] = "failed"
                else:
                    region["status"] = (latest.get("quality") or {}).get("status", "provisional")

        ordered_pages = sorted(
            pages.values(), key=lambda item: (item.get("pageNumber") or 0, item["pageId"])
        )
        for page in ordered_pages:
            page["regions"] = sorted(
                page["regions"].values(), key=lambda item: (item.get("box") or {}).get("y", 0)
            )
        return {
            "documentId": document_id,
            "pageCount": len(ordered_pages),
            "regionCount": sum(len(page["regions"]) for page in ordered_pages),
            "pages": ordered_pages,
            "artifactBaseUrl": f"/api/diagnostics/{document_id}/artifact/",
        }

    def get_correction(self, document_id, page_id, region_id):
        path = os.path.join(
            self.corrections_dir(document_id),
            f"{_safe_component(page_id)}__{_safe_component(region_id)}.json",
        )
        if not os.path.exists(path):
            return None
        try:
            with open(path, "r", encoding="utf-8") as stream:
                return json.load(stream)
        except Exception:
            return None

    def list_corrections(self, document_id):
        directory = self.corrections_dir(document_id)
        if not os.path.isdir(directory):
            return {}
        out = {}
        for name in sorted(os.listdir(directory)):
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(directory, name), "r", encoding="utf-8") as stream:
                    data = json.load(stream)
                out[f"{data.get('pageId')}__{data.get('regionId')}"] = data
            except Exception:
                continue
        return out
