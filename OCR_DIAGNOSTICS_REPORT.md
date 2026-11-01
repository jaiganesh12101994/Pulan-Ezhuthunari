# Pulan Ezhuthunari — OCR Diagnostics & Quality Control: completion report

This report answers the nine completion items of `qc.md`. Every number below was
measured on this machine with the real Tesseract 5.4.0 binary; nothing is
estimated or asserted without a measurement.

---

## 1. Root cause of the inconsistent OCR results

A paragraph drawn by hand was recognised correctly, while the same paragraph
coming from multipage/forced-layout OCR was wrong. The cause was found by tracing
both paths and comparing their crops:

* Both paths already used the **same** page image, the same `/api/ocr` endpoint,
  the same engine settings and the same reading-order assembly, so the difference
  had to be the **crop**.
* The forced layout modes hand OCR **zones that span several real columns**:

  | layout mode | zones returned | real text columns inside each zone |
  |---|---|---|
  | auto | 4 | 1, 1, **2**, 1 |
  | 2-Columns | 2 | **2, 3** |
  | 3-Columns | 3 | **2, 3, 3** |
  | Single Block | 1 | **4** |

* Tesseract reads such a zone as one uniform block, so lines from neighbouring
  columns are interleaved into single output lines. Measured on the synthetic
  two-column page: recognising the page as one block gave **CER 0.5915 / WER
  0.72**, while reading it column by column gave **CER 0.0274 / WER 0.06**
  (reference text known exactly).
* A hand-drawn paragraph box contains exactly one column, which is why it was
  accurate. The problem was never the engine, the DPI or the preprocessing.

A second, independent defect was found while testing: Tesseract invocations were
**unbounded**, so a single hung Tesseract process stalled an entire document
(observed for real during this work).

## 2. Fixes applied

**OCR service (`backend/tamil_ocr_engine.py`)**

* `recognize_region()` now detects the columns inside a region and recognises it
  **column by column in reading order**, instead of as one block. The same
  routine serves manual selections, single-page OCR and batch OCR, so all three
  now share one code path and one set of settings.
* `split_crop_columns()` implements the detection: density profile → blank runs →
  candidate gutters → keep only gutters **wider than the crop's own line pitch**
  (measured inside a real column) → cut inside the gutter's **widest ink-free
  gap**, so a ragged column edge is never clipped and a paragraph is never cut in
  half. Verified against 11 real page/zone crops and synthetic single-, two- and
  three-column pages.
* Every engine invocation is bounded by `TESSERACT_TIMEOUT` (60 s, pytesseract
  `timeout=` and `subprocess` timeout). A timeout raises `OcrTimeout`, is recorded
  as a failed attempt and does not stall the document.
* The effective settings, preprocessing profile, candidate profiles, engine
  version, models, crop geometry, timings and raw output are now traced per
  attempt (`trace`), which is what the diagnostics records persist.
* No DPI increase, no engine change and no new preprocessing was introduced: the
  only behavioural change to recognition is the crop decomposition.

## 3. Files created and modified

Created:

* `backend/ocr_quality.py` — modular quality checks, status vocabulary, retry
  strategy selection.
* `backend/ocr_diagnostics.py` — persistent diagnostics store (attempt records,
  content-addressed artifacts, corrections, aggregation).
* `src/components/DiagnosticsWorkspace.tsx` — the diagnostic workspace UI.
* `backend/tests/test_ocr_diagnostics.py` — 33 tests.
* `backend/tests/reference/README.md` — how to add a verified transcription for
  the CER/WER measurement.
* `pytest.ini` — test configuration.

Modified:

* `backend/tamil_ocr_engine.py` — column-aware recognition, tracing, bounded
  invocations, `diagnostics` CLI action, `--diag` / `--diag-op`.
* `server.ts` — `GET /api/config`, diagnostics context on `/api/ocr`,
  `GET /api/diagnostics/:documentId`,
  `GET /api/diagnostics/:documentId/artifact/:name`,
  `POST /api/diagnostics/:documentId/correction`, stable document ids.
* `src/App.tsx` — sends the diagnostic context with every OCR call, records
  per-zone text, retry-region and apply-correction handlers, renders the
  workspace.
* `src/components/PulanToolBar.tsx` — **Diagnostics** button.
* `src/types.ts` — diagnostics types.
* `package.json` — `npm test` runs the OCR test suite.
* `.gitignore` — ignores generated `diagnostics/`, caches.


## 4. Diagnostic data and image artifacts captured

For every document → page → region → attempt:

* document/page/region identifiers, PDF page number, render DPI, page pixel
  dimensions, rotation, region type and bounding box;
* the exact crop box handed to the engine, its pixel dimensions and how many
  columns were read (plus every column box);
* the **original region crop**, the **crop supplied to the engine** and the
  **preprocessed crop** as PNG artifacts, stored **content-addressed** by
  SHA-256 (identical images are stored once — verified by test);
* the applied transformations with parameters (deskew angle, scale factor,
  denoise/sharpen/binarize flags, white margin) and the winning profile;
* engine, engine version, models and effective settings (`psm`, `oem`, `dpi`,
  language, sharpen, autocontrast, target line height);
* raw engine output (immutable) and the normalized text as **separate** stages,
  the engine confidence when reported, recognition duration, warnings, errors and
  status;
* quality findings with their measurements, the retry strategy used per attempt
  and the list of strategies already tried;
* corrections, verification, the "unresolved" flag and the correction history,
  stored apart from the raw output.

Attempts are written as one JSON file each, so concurrent workers cannot
overwrite each other (verified by test), and the aggregate is rebuilt on read, so
diagnostics survive reopening the document.

## 5. Quality-check rules and retry behaviour

Implemented checks (all in `backend/ocr_quality.py`, each returning structured
findings with the measured value):

| code | severity | rule |
|---|---|---|
| `low_resolution` | warning | text line height below 12 px |
| `blur` | warning | variance of Laplacian below 45 |
| `low_contrast` | warning | grey standard deviation below 28 |
| `skew` | info | rotation applied by preprocessing >= 2 degrees |
| `clipped_characters` | warning | ink touching a crop edge (names the sides) |
| `possible_missing_lines` | warning | line gap > 3x the median line pitch |
| `duplicated_lines` | warning | the same line recognised twice in a row |
| `control_characters` | warning | control characters in the output |
| `orphan_combining_mark` | warning | a Tamil combining mark without a base letter |
| `zero_width_marks` | info | zero-width/directional marks left in the output |
| `mixed_script_tokens` | info | tokens mixing Tamil and Latin (legitimate for transliteration) |
| `low_confidence` / `moderate_confidence` | warning / info | engine confidence below 55 % / 70 %, only when the engine reports it |
| `engine_disagreement` | info | two engines agree on < 55 % of the text |
| `engine_failure` | error | the engine failed or timed out |

Statuses: **Provisional**, **Review Required**, **Verified**, **Failed** — the
same vocabulary in the engine, the store and the UI.

Deliberately **not** flagged: historical Tamil spelling, valid combining
sequences and rare Siddha vocabulary (covered by a test that asserts no warnings
for such text). Confidence is never invented: when an engine reports none, no
confidence finding is produced.

Retries: bounded (default 2 extra attempts), each derived from the **original**
region so they cannot compound (verified by test), chosen from the diagnosed

## 7. Tests executed and their actual results

`npm test` (or `python -m pytest backend/tests -v`):

```
32 passed, 1 skipped in 43.38s
```

The skipped test is the reference-based accuracy measurement; it skips because no
verified transcription is committed yet (see `backend/tests/reference/README.md`).

Measured results printed by the tests:

* manual box vs the same paragraph inside a forced multi-column zone:
  **paragraph word overlap 91.7 %**, zone-paragraph **CER 0.044**, manual-box
  **CER 0.0**;
* whole page as one block vs column by column: **CER 0.5915 / WER 0.72** versus
  **CER 0.0274 / WER 0.06**;
* scanned Tamil sample (`public/samples/11.jpg`, dense crop): mean engine
  confidence **21.0** — reported as a measurement, not as an accuracy claim.

Coverage: crop geometry and the manual/zone regression, coordinate mapping,
rendering DPI and pixel dimensions, artifact hashes and de-duplication, engine
settings/version/model recording, raw vs normalized vs corrected stages, quality
rules, retry budgets and non-repetition, retry non-compounding, engine failure
handling, CLI timeout handling, cancellation leaving completed results intact,
Tamil Unicode preservation, correction history and verified-text protection,
concurrent writers, multipage reading order, and TXT/JSON/HTML (and DOCX when
python-docx is present) export.

Deterministic tests mock the OCR engine (`monkeypatch` of `recognize_region`) and
are labelled as such; the integration tests run the **real Tesseract** binary and
skip automatically when it is absent.

## 8. Were real Tesseract and Surya integration tests performed?

* **Tesseract: yes** — every integration test, every measurement above and the
  end-to-end HTTP verification used the real `tesseract 5.4.0.20240606` binary
  with the bundled `tam` + `eng` models.
* **Surya: no** — the real Surya model is not installed in this environment
  (`pip install surya-ocr` plus CRAFT weights would be required). In this
  application `surya`, `chandra` and `gnana70` are Tesseract-backed pipelines with
  different preprocessing personalities, and they all go through the same
  column-aware path, so they benefit from the fix, but the
  `engine_disagreement` check is currently exercised only by unit tests, not by a
  second real engine.

End-to-end verification through the running server (`npm run dev`):

```
GET  /api/config                          -> 200 {renderDpi: 200, pdfWorkers: 4, ...}
POST /api/ocr        (with diagnostics)   -> 200 diagnosticsId, columns, status,
                                                 retryCount, quality codes, attempts, artifacts
GET  /api/diagnostics/<id>                -> 200 pages/regions, settings, engine v5.4.0, models eng+tam
GET  /api/diagnostics/<id>/artifact/<sha> -> 200, 95 421-byte PNG
POST /api/diagnostics/<id>/correction     -> 200 finalText = corrected text
POST .../correction (verified)            -> status verified, history 1, raw text preserved
GET  .../artifact/..%2F..%2Fserver.ts     -> 404 (path traversal refused)
```

## 9. Remaining limitations and recommended next steps

* **Residual edge clipping on real scans.** A forced zone can start a couple of
  pixels inside a column, which clips the first glyphs of the longest lines (the
  real page shows 82 % paragraph word overlap for that reason). The quality check
  reports `clipped_characters` and the retry expands the crop, but the cleanest
  fix is to prefer the detector's own zones (auto mode) over forced modes that cut
  through columns.
* **Gutter detection on very noisy scans** relies on gutters being roughly 2.5x
  wider than a word gap. Bleed-through in the page-split area can make a very
  narrow real gutter invisible; such a zone then falls back to single-block

---

## Appendix — AI vision engines (Claude, ChatGPT, OpenAI-compatible)

Added after the report above, following the same rules: reuse existing services,
no new heavy dependencies (Node's built-in `fetch` and `child_process` only), and
no claim that was not measured.

**What was added**

* `aiVision.ts` — one provider layer used by both actions:
  * `anthropic` — Anthropic Messages API (`x-api-key`, base64 image block).
  * `openai` — OpenAI chat-completions API (image as a data URL).
  * `openai-compatible` — any endpoint speaking that API (Ollama, LM Studio, vLLM,
    OpenRouter, Groq, Together, DeepSeek, gateways ...), with `max_tokens` falling
    back to `max_completion_tokens` when a server rejects the old name.
  * `claude-cli` / `codex-cli` — the local subscription CLIs, so a Claude or ChatGPT
    subscription can be used without an API key.
* Layout detection: the model answers with zones, which are normalised into the
  app's `LayoutZone` shape — pixel or fractional coordinates, `{x,y,w,h}`,
  `{x0,y0,x1,y1}`, `{left,top,right,bottom}` or `{bbox:[...]}` are all accepted —
  then clamped to the page, filtered for degenerate boxes and sorted into reading
  order (columns left to right, lines top to bottom inside a column).
* OCR: the page or the selected zone is transcribed with an instruction set that
  forbids modernising, correcting, translating or reordering the Tamil text.
* Server: `GET /api/ai/providers` (configuration state, never a key),
  `POST /api/ai/test` (verifies a key, endpoint or subscription), plus AI branches
  in `/api/layout-detect` (single page and batch) and `/api/ocr`.
* Sign-in: `GET /api/agent/auth-status`, `POST /api/agent/sign-in` (the deep check),
  `POST /api/agent/login/start|code|cancel` and `POST /api/agent/logout`. The app runs
  the provider's own login, so the panel shows the link and takes the code; no
  credential is ever read, stored or logged by this app. See
  [docs/CLAUDE_INTEGRATION.md](docs/CLAUDE_INTEGRATION.md).
* Diagnostics: an AI OCR run records an attempt through the existing store
  (`op: "ai-attempt"`), so AI regions appear in the diagnostics workspace with
  their crop artifact, provider, model and the same quality findings as every other
  engine. Confidence is recorded as "not reported" rather than invented.
* UI: three new engines in the selector, with an options panel for subscription
  mode, API key, base URL and model, a **Test** button, and a configuration badge.
  Settings persist in `localStorage`; environment variables are the fallback.

**Verification actually performed**

* `npx tsx _verify_ai.ts` (provider layer against local mock servers):
  **24/24 checks passed** — fenced-JSON extraction, fractional→pixel conversion,
  reading order, data-URL image part, model forwarding, Anthropic base64 image
  block, HTTP 401 surfaced with the provider message, missing key/endpoint errors,
  non-JSON answers reported clearly, bbox/x1-y1 box shapes, CLI detection, JSON
  envelope unwrapping and the file-based instruction plumbing (fake `claude.cmd`
  and `codex.cmd` on PATH).
* `python _verify_ai_e2e.py` (through the running app with a mock OpenAI-compatible
  endpoint): **18/18 checks passed** — provider listing, connection test, AI layout
  detection (3 zones in page pixels), AI OCR (Tamil text returned), the attempt
  appearing in `/api/diagnostics` with raw text, provider, quality findings and a
  crop artifact, and the actionable error for a missing key.
* `python -m pytest backend/tests -q` → **32 passed, 1 skipped** (unchanged).
* `npx tsc --noEmit` → clean; Vite transforms both changed UI modules.

**Bugs the tests caught (all fixed)**

1. The Anthropic base-URL override was ignored, so a configured proxy/mock was
   bypassed (the test reached the live API and returned a real 401).
2. Arguments were passed to the CLIs through a shell unquoted, so multi-line
   prompts were split into several arguments; the prompt now travels as a file the
   CLI reads, with each argument quoted.
3. A CLI that is not installed was reported as available (the shell's
   "not recognized" text was read as a version).
4. JSON envelopes were not unwrapped for the `codex` path.
5. The aggregated diagnostics record omitted `pipeline`/`pipelineOptions`.

**Honest limitations**

* No real Anthropic/OpenAI key was available here, so live API calls were not made;
  the HTTP layer was verified against local mock servers that mimic the documented
  request/response shapes, and the Anthropic request was confirmed to reach the
  real endpoint (it returned a genuine 401 for the dummy key).
* The subscription CLIs are not installed on this machine, so the CLI path was
  verified with fake `claude`/`codex` binaries. The exact flag names of those CLIs
  can change between versions; the code tries the documented variants in turn and
  reports the CLI's own error text when none works.
* Vision models return no confidence, so AI regions are recorded with "not
  reported" and the review status comes from the quality checks only.
* Model names change over time: the defaults (`claude-sonnet-4-5`, `gpt-4o`) are
  editable in the UI and overridable through the environment.

  reading and is reported as review-required rather than silently misread.
* **Edge slivers.** When a forced mode cuts through a column, the fragment left at
  the crop edge is read as its own column (a few characters, correctly placed).
  The column boxes are recorded, so this is visible in the workspace.
* **No verified Tamil transcription is committed**, so CER/WER is measured only on
  synthetic references. Transcribing one scanned page into
  `backend/tests/reference/` enables the full measurement and regression guard.
* **The workspace was verified** by `tsc --noEmit`, by Vite transforming the
  component without error and by end-to-end API tests; an interactive browser
  session (clicking through every control) was not possible in this environment.
* **Recommended next steps:** install real Surya/Chandra models to activate the
  engine-disagreement comparison with two genuinely independent engines; add a
  verified reference transcription; consider a terminology lexicon stage built
  from the corrections collected in the diagnostics store.

problem — `expand_crop` for clipping/missing lines, `contrast` for low contrast
or blur, `upscale` for small text, `alt_profile` for suspicious text, duplicated
lines or an engine failure — and a strategy is never repeated. An attempt is
preferred only when it **removes warning-level findings**, never because its text
looks more fluent. Every attempt is recorded with its reason and output.

## 6. Diagnostic workspace and correction workflow

`src/components/DiagnosticsWorkspace.tsx` (opened from the toolbar **Diagnostics**
button) provides:

* **Original page viewer** with zoom, pan, page-following, region overlays for
  every recorded region (colour-coded by status) and a highlighted region under
  investigation;
* **Image comparison** — original page, detected region, exact OCR crop and
  preprocessed crop as thumbnails, with crop coordinates, pixel dimensions,
  render DPI, rotation, columns read and the preprocessing profile;
* **OCR result comparison** — raw engine output (read-only), the normalized text
  and the editable final text side by side, each labelled, with "use as final"
  shortcuts;
* **Diagnostic information** — identifiers, render DPI, dimensions, crop box,
  engine, version, models, settings, duration, confidence, status, quality
  findings, warnings and errors;
* **Retry history** — every attempt with its profile, confidence, duration, retry
  strategy, the alternative preprocessing candidates that were measured and their
  artifacts, plus the correction history;
* **Actions** — retry the region, save a correction, accept & verify, unverify,
  mark unresolved, and previous/next navigation over the regions that still need
  review. Corrected text is written into the assembled document and export;
  verified corrections are never overwritten by later automatic retries (test).
