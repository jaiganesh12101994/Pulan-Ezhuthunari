# Pulan Tamil OCR

**புலன் தமிழ் எழுத்துணரி** — a multi-engine Tamil OCR and document layout analysis
workspace for scanned Tamil books, newspapers, palm-leaf manuscripts and bilingual
documents.

It runs locally: a Node/Express server drives Python OCR engines and local AI vision
models, and a React front end provides the document tree, a page canvas with editable
layout zones, batch processing, an OCR diagnostics workspace and the text editor. The same
application also builds as a Windows desktop installer that carries Python, Tesseract, its
language models and Poppler with it.

## Features

* **Eight OCR engines** — Tesseract (Tamil + English), the Surya, Chandra and gnana70
  pipelines, and the Google Gemini, Anthropic Claude, OpenAI ChatGPT and any
  OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, OpenRouter, Groq, DeepSeek, a
  gateway, ...).
* **API key or subscription** — every AI engine runs from an API key, or from a
  subscription you already pay for, with the sign-in handled inside the app.
* **Multi-column layout detection** with a reading order, plus an editable zone overlay:
  draw, retype, reorder and delete zones, and recognise one zone on its own.
* **Batch OCR** across every page, with per-page progress and a **Cancel OCR** button.
* **OCR diagnostics workspace** — every attempt on every region is recorded with its
  preprocessing, candidates, confidence, quality findings and image artifacts, so a
  questionable reading can be inspected rather than guessed at.
* **Quality control** per region, with configurable retry strategies.
* **Export** to DOCX, TXT, JSON and HTML, per page or as one combined document.
* **Image preprocessing** — brightness, contrast, Otsu binarisation and inversion, with
  deskew, denoise and sharpening inside the recognition pipeline.
* **Text editor** with a Tamil text normaliser (kombu and pulli sequence repair) and a
  Tamil virtual keyboard / character palette.
* **Large documents** — a 300 MB, 800-page scanned volume opens, with progress reported
  throughout. See [Opening documents](#opening-documents).
* **Tesseract language management** — list installed languages and download more
  `traineddata` from inside the app.
* **Windows desktop build** — an installer that bundles Python, Tesseract, the Tamil and
  English models and Poppler, so the target machine needs nothing installed.

## Technology stack

| Layer | Used |
|---|---|
| Front end | React 19, TypeScript, Vite 8, Tailwind CSS 4, lucide-react, motion |
| Server | Node.js, Express 4, TypeScript (run through `tsx`), multer, docx, `@google/genai` |
| OCR engines | Tesseract 5 through `pytesseract`, Pillow, numpy, OpenCV |
| PDF rasterization | Poppler (`pdftoppm`, `pdfinfo`) |
| AI vision | Google Gemini, Anthropic Claude, OpenAI, or any OpenAI-compatible endpoint |
| Desktop shell | Electron 45 with electron-builder (NSIS installer) |
| Tests | pytest |

## Project structure

```
.
├── server.ts                  Express API: uploads, rasterization, OCR, export, AI routes
├── aiVision.ts                Vision-model providers (Gemini, Claude, ChatGPT, compatible)
├── agentClient.ts             Client for the Python subscription sidecar
├── pulan_tamil_ocr.py         Standalone Tkinter desktop script (downloadable from the UI)
├── index.html                 Vite entry document
├── backend/
│   ├── tamil_ocr_engine.py    The OCR engine: engines, preprocessing, zones, CLI
│   ├── ocr_quality.py         Per-region quality checks and retry strategies
│   ├── ocr_diagnostics.py     Persisted diagnostics records and artifacts
│   ├── agent/                 Subscription sidecar: sign-in, tools, permissions, prompts
│   └── tests/                 pytest suite
├── src/
│   ├── App.tsx                Application state and the document/OCR workflows
│   ├── types.ts               Shared types
│   └── components/            Menu bar, toolbar, tree, canvas, editor, modals
├── engines/
│   ├── tessdata/              Tamil and English LSTM models
│   ├── ocr_tamil/             Vendored gnana70/tamil_ocr (MIT)
│   └── surya_chandra/         Pipeline configuration
├── electron/                  Desktop shell: main process, preload bridge, build resources
├── scripts/                   Desktop build, packaging and verification scripts
├── docs/                      Integration and desktop-build documentation
├── public/samples/            Sample pages offered by the sample picker
├── .env.example               Every configuration variable, with comments
└── electron-builder.yml       Installer packaging configuration
```

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js 20 or newer | Runs the server and builds the UI |
| Python 3.11 | Runs the OCR engine |
| Tesseract 5 | The OCR engine itself. On Windows, an install under `C:\Program Files\Tesseract-OCR` is found automatically |
| Poppler | `pdftoppm` and `pdfinfo`, needed to open PDFs; not needed for image files |
| Python packages | `pip install pillow numpy opencv-python pytesseract python-docx` |
| Optional | `pip install claude-agent-sdk` to use a Claude subscription instead of an API key. The packaged Windows app already includes it, so there is nothing to install there |

The Tamil and English language models ship in `engines/tessdata`, so no separate
`traineddata` download is required.

## Installation

```bash
git clone <repository-url>
cd Pulan-Ezhuthunari

npm install
pip install pillow numpy opencv-python pytesseract python-docx

cp .env.example .env      # optional: add API keys, or set them in the UI instead
```

## Development

```bash
npm run dev        # Vite dev server with HMR; API on http://localhost:3000
npm run lint       # tsc --noEmit
npm test           # pytest suite
```

`npm run build` produces the production UI in `dist/`. With `NODE_ENV=production` the
server serves that folder instead of running Vite.

## Configuration

Everything is optional. Keys can also be pasted into the engine options panel, where they
stay in the browser; the variables below configure them server-side instead. See
[.env.example](.env.example) for the full, commented list.

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Google Gemini vision |
| `ANTHROPIC_API_KEY` | Anthropic Claude vision |
| `OPENAI_API_KEY` | OpenAI ChatGPT vision |
| `PULAN_AI_API_KEY`, `PULAN_AI_BASE_URL`, `PULAN_AI_MODEL` | Any OpenAI-compatible endpoint |
| `TESSERACT_CMD` | Tesseract executable, when it is not on `PATH` |
| `PDFTOPPM_BIN`, `PDFINFO_BIN` | Poppler binaries, when they are not on `PATH` |
| `PYTHON_BIN` | Python interpreter, when `python` on `PATH` is not the right one |
| `PDF_DPI`, `PDF_WORKERS` | Rasterization resolution and parallelism |
| `PULAN_MAX_UPLOAD_MB` | Largest accepted upload (default 4096) |
| `PULAN_TEMP_DIR`, `PULAN_DIAGNOSTICS_DIR` | Where uploads, rendered pages and diagnostics are written |
| `PORT` | API port (default 3000) |
| `CLAUDE_CLI_BIN`, `CODEX_CLI_BIN`, `AGY_CLI_BIN` | Subscription CLIs, when not on `PATH` |

The server binds `0.0.0.0` and has no authentication of its own, so it is meant to run on
a machine you control rather than exposed to a network.

## OCR and layout engines

| Engine | What it uses | Needs |
|---|---|---|
| Tesseract (multi-language) | bundled Tesseract + `engines/tessdata` | nothing extra |
| Surya / Chandra / gnana70 | Tesseract pipelines with their own preprocessing | nothing extra |
| **Google Gemini** | Gemini vision API, or a Google AI plan (Free/Pro/Ultra) through the Antigravity CLI | `GEMINI_API_KEY`, or tick **Subscription** |
| **Claude (Anthropic) Vision** | Anthropic Messages API, or your Claude subscription through Claude Code | `ANTHROPIC_API_KEY`, or tick **Subscription** and sign in — the desktop app bundles everything the subscription needs |
| **ChatGPT (OpenAI) Vision** | OpenAI chat-completions API | `OPENAI_API_KEY`, or tick **Subscription** to run through the local `codex` CLI |
| **OpenAI-compatible AI** | any endpoint speaking the OpenAI chat-completions API with image parts | a base URL and model name (Ollama, LM Studio, vLLM, OpenRouter, Groq, DeepSeek, a gateway, ...) |

All four AI engines perform **both** layout detection and OCR:

* **Detect Layout** asks the model for the reading zones and converts the answer to
  pixel boxes (pixel or fractional coordinates, several box shapes accepted), sorts
  them into reading order and hands them to the normal zone overlay.
* **Recognize Page / Batch OCR** sends the page (or the selected zone) to the model
  and puts the transcription through the same diagnostics, quality checks and
  exporters as the other engines. A batch run reports its progress in a dialog with a
  **Cancel OCR** button: nothing further is started, pages already finished keep their
  text, and the page already in flight is left for the server to finish — a request
  that has been sent cannot be recalled.

Configure them in the toolbar's engine options panel: API key, base URL, model and a
**Test** button that verifies the key, endpoint or subscription. Pasted keys stay in
the browser (`localStorage`) and are sent only to the provider you configure; server
environment variables are used when the fields are left empty. See `.env.example`
for every variable.

Tick **Subscription** to run without an API key. For Claude that means your Claude
Pro/Max subscription through Claude Code: the panel then shows a **Sign in** button
that signs you in from inside the app — the authorization link and the code box appear
in the panel, so no terminal is ever needed — plus the CLI path and a badge naming the
account in use. Usage draws on the same subscription limits as the Claude apps and
Claude Code. For ChatGPT the subscription path signs in to the `codex` CLI the same
way, and the panel installs it for you if it is missing. For Gemini the subscription
runs through the **Antigravity CLI** rather than the Gemini CLI — Google retired the
Gemini CLI for individual plans, Google AI Pro included — and since it shares the
sign-in the Antigravity app already stored, it is often signed in before the panel is
opened. See [docs/CLAUDE_INTEGRATION.md](docs/CLAUDE_INTEGRATION.md) for the details.

## Opening documents

Large scanned volumes are handled as a matter of course. A 300 MB PDF of 800 pages
uploads, rasterizes with progress reported the whole way, and opens as a page list you
can scroll: measured on a clean install, 800 pages took about 5½ minutes to rasterize and
left the UI responsive. Uploads stream straight to disk rather than into memory, and the
pages are rendered by parallel `pdftoppm` workers.

Before rendering starts, the server checks that the temp folder can hold the pages it is
about to write — roughly 2.5 MB per page at 200 DPI — and says so plainly if it cannot,
instead of failing part way through with a disk-full error. Two settings control this:

| Setting | Default | Purpose |
|---|---|---|
| `PULAN_MAX_UPLOAD_MB` | `4096` | Largest single upload accepted |
| `PDF_DPI` | `200` | Quality against speed and disk space; lower it to fit a very large volume on a small drive |
| `PDF_WORKERS` | CPU cores, max 8 | Parallel `pdftoppm` processes |

All three are documented in [.env.example](.env.example).

## Building

### Web UI

```bash
npm run build          # -> dist/
```

### Windows desktop installer

The same application also builds as a desktop app whose installer carries every dependency
with it — Python, Tesseract, the Tamil and English models and Poppler — so the target
machine needs nothing installed:

```powershell
npm run desktop:python      # once: build the embedded Python runtime
npm run desktop:installer   # -> build/installer/PulanTamilOCR-<version>-Setup.exe
npm run desktop             # run the staged app without installing it
```

See [docs/DESKTOP_BUILD.md](docs/DESKTOP_BUILD.md) for what is bundled, how the app finds
its own copies, how to verify a build, and the licence note on Poppler.

## Testing

```bash
npm test           # pytest suite: OCR diagnostics and quality control
npm run lint       # tsc --noEmit
```

Three further scripts verify a packaged build rather than the source, since that is where
bundling mistakes show up:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\test-packaged.ps1   # runs the staged app with PATH stripped
node scripts\verify-bridge.cjs                                       # drives the desktop window controls
node scripts\test-large-file.cjs <path-to-pdf>                       # loads a large document through the real UI
```

## Third-party components

| Component | Licence |
|---|---|
| Tesseract OCR and the `engines/tessdata` models | Apache-2.0 |
| Poppler (`pdftoppm`, `pdfinfo`) | GPL-2.0-or-later |
| `engines/ocr_tamil` (gnana70/tamil_ocr) | MIT |
| `engines/ocr_tamil/ocr_tamil/craft_text_detector` | MIT |
| Electron and Chromium | MIT / BSD-3-Clause |
| React, Vite, Express and the other npm packages | see `package-lock.json` |

Poppler is the one component under copyleft terms. It is used only to rasterize PDFs, and
its source or a written offer must accompany any binary distribution of it.

## License

No licence has been chosen for this project yet and no `LICENSE` file is included, so the
default applies: all rights reserved by the copyright holder. Pick a licence and add it
here before distributing the project. The third-party components above keep their own
terms regardless.

