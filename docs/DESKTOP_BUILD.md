# Building the Windows desktop app

This produces a single `.exe` installer that installs Pulan Tamil OCR on a machine that
has **nothing** installed: no Node, no Python, no Tesseract, no Poppler, no OCR models.

```
build/installer/PulanTamilOCR-1.0.0-Setup.exe     228 MB   (installs to 768 MB)
```

## Building it

Three commands, in order. The first only needs running once (or again to pick up new
Python package versions):

```powershell
npm install
npm run desktop:python      # downloads Python 3.11 embeddable + Pillow, numpy, OpenCV, pytesseract, python-docx
npm run desktop:installer   # builds the UI, bundles the server, stages everything, builds the installer
```

Then either hand the installer to the target machine, or run the app straight from the
build tree with `npm run desktop` (which needs `npm run desktop:stage` first).

| Script | What it does |
|---|---|
| `scripts/prepare-python.ps1` | Builds `build/python/` — the embedded runtime and its packages |
| `scripts/build-desktop.ps1` | Stages `build/app/` and, with `-Installer`, runs electron-builder |
| `scripts/test-packaged.ps1` | Smoke-tests the staged app with PATH stripped |
| `scripts/verify-bridge.cjs` | Drives the window controls in a running build over CDP |

## What is inside the installer

| Part | Size | Why it is there |
|---|---|---|
| Electron 45 (Chromium + Node) | ~330 MB installed | The window, and the Node that runs the server |
| `python/` — Python 3.11 embeddable | 215 MB | Pillow, numpy, OpenCV, pytesseract, python-docx |
| `engines/tesseract/` — Tesseract 5.4 + 51 DLLs | 160 MB | The OCR engine itself |
| `engines/tessdata/` | 9.7 MB | The Tamil (`tam`) and English (`eng`) LSTM models |
| `bin/` — Poppler | 22 MB | `pdftoppm`/`pdfinfo`, for rasterizing PDF pages |
| `server.mjs` | 3.8 MB | The Express API, bundled from `server.ts` into one file |
| `dist/` | 1 MB | The built React UI |
| `backend/` | 0.4 MB | The Python engine, quality checks and diagnostics |
| `public/samples/` | 0.6 MB | The sample pages the picker offers |

**No ML frameworks are bundled, and none are needed.** The Surya, Chandra and gnana70
engines in `backend/tamil_ocr_engine.py` are Tesseract pipelines with their own
preprocessing — they call `run_tesseract_tamil` like the Tesseract engine does. There are
no model weights and no PyTorch. That is the difference between a 228 MB installer and a
multi-gigabyte one.

## How the app finds its own copies

Nothing is left to PATH. `electron/main.cjs` sets these before starting the server, so
the app cannot silently borrow a system install — the failure mode this prevents is an
app that works on the build machine and breaks on a clean one.

| Variable | Points at |
|---|---|
| `PYTHON_BIN` | `resources/app/python/python.exe` |
| `TESSERACT_CMD` | `resources/app/engines/tesseract/tesseract.exe` |
| `PDFTOPPM_BIN` | `resources/app/bin/pdftoppm.exe` |
| `PDFINFO_BIN` | `resources/app/bin/pdfinfo.exe` |
| `PORT` | a free port chosen at launch (3917-3928), so a busy 3000 is not a problem |
| `PULAN_DIAGNOSTICS_DIR` | `%APPDATA%\Pulan Tamil OCR\diagnostics` |
| `PULAN_TEMP_DIR` | `%TEMP%\pulan-ocr` |

The last two matter because Program Files is read-only for a standard user: an installed
app must not try to write its diagnostics or rendered pages next to its own executable.

The engine also finds its data with no configuration at all: `backend/tamil_ocr_engine.py`
treats the parent of `backend/` as the app root and looks for `engines/tessdata` and
`engines/tesseract` there.

## The window has no native chrome

The packaged app runs **frameless** (`frame: false`) with **no application menu**
(`Menu.setApplicationMenu(null)`), so Electron's own minimise / maximise / close buttons
and its File / Edit / View / Window / Help menu are not there. Only the app's own top
panel is visible.

That makes the panel the title bar:

| Region | Behaviour |
|---|---|
| The space beside the menus and the controls, and the app name | drags the window (`.app-drag-region`) |
| The six menus and the three window-control buttons | stay clickable (`.app-no-drag`) |

The 8 px difference between the window and the page is the **invisible resize border**
(`thickFrame`, the WS_THICKFRAME style). Setting it to `false` makes the window flush
with the page but it can no longer be resized by dragging an edge, so it stays on.

Both CSS properties are ignored outside Electron, so the same markup still works
unchanged in the browser at `npm run dev`.

## What is deliberately not bundled

The three subscription engines need **the user's own account**, so their sign-in cannot be
shipped inside an installer:

| Engine | What it needs on the target machine |
|---|---|
| Google Gemini (subscription) | The Antigravity CLI (`agy`), signed in to the user's Google account |
| Claude (subscription) | A Claude Code sign-in — see the note below |
| ChatGPT (subscription) | The `codex` CLI, signed in to the user's OpenAI account |
| Any API-key engine | A key typed into the engine options panel, or set in the environment |

The OCR engines — Tesseract, Surya, Chandra and gnana70 — are fully self-contained and
need no account of any kind.

### The Claude subscription in a packaged build

`claude-agent-sdk` **is bundled** (`scripts/prepare-python.ps1`), so a fresh install has
the whole Claude path ready and the toolbar shows the account instead of a warning. It is
the biggest single thing in the installer: a 149 MB wheel whose `_bundled/claude.exe` (the
Claude Code CLI) unpacks to about 320 MB, which is why the installer is ~590 MB rather
than ~230 MB.

Both halves have to be there for the engine to work. The package is the transport the app
talks to Claude Code through, and the CLI is what performs the sign-in and the queries, so
shipping one without the other would leave a badge that says *Agent SDK not installed* (no
package) or *Claude Code not found* (no usable executable).

To build the smaller installer instead, leave the SDK out:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\prepare-python.ps1 -WithoutClaudeSdk
powershell -ExecutionPolicy Bypass -File scripts\build-desktop.ps1 -Installer
```

The sign-in panel then offers **Install it for me**, which runs
`python -m pip install claude-agent-sdk` in the app's own Python — pip is bundled either
way, so that button works in both builds. That costs the user a ~360 MB download on first
use, which is the reason the SDK is bundled by default.

Anthropic's own installer is the other way to get a CLI the SDK accepts, and the panel
offers it instead of the pip command when the package is present but the CLI is missing
(npm's `claude.cmd` shim, say — the SDK refuses to run those). It writes a real
`claude.exe` to `%USERPROFILE%\.local\bin`, which `resolve_cli` already probes, so no PATH
change is needed:

```powershell
irm https://claude.ai/install.ps1 | iex
```

Either way the app never stores a credential of its own: the CLI performs the sign-in and
keeps the token.

## Verifying a build

`scripts/test-packaged.ps1` starts the staged app the way an installed copy runs, with
`PATH` cut down to the Windows system directories. On the build machine a system
Tesseract and Python exist and would happily satisfy the engine, hiding a bundling
mistake until a user hit it; stripping PATH makes that fail here instead. It then checks
that the Tesseract the app resolved really is the bundled one, and OCRs a page.

`scripts/verify-bridge.cjs` attaches to a running build over the Chrome DevTools Protocol
and drives the minimise / maximise / restore buttons, so a broken preload or IPC channel
fails in the build rather than on a user's screen:

```powershell
npx electron . --remote-debugging-port=9222
node scripts\verify-bridge.cjs
```

Both were run against the finished installer, not just the staged folder.

## Before you ship it

**Code signing.** The installer is unsigned, so Windows SmartScreen will warn on first
run ("Windows protected your PC"). Either buy a code-signing certificate and set
`win.certificateFile` in `electron-builder.yml`, or tell users to click *More info* →
*Run anyway*.

**The icon must contain a 256×256 entry.** Windows requires one for an executable, and a
32×32-only `icon.ico` stops the build with `Icon must be at least 256x256 pixels,
provided: 32x32`. Run `python make-icon.py` in `electron/build-resources/` to generate the
full size range; it prefers a `icon-source.png` if you have one, so drop a 256 px square
in there for a crisp large icon.

**Licences of what is bundled.** Worth a look before redistributing:

| Component | Licence | Note |
|---|---|---|
| Tesseract OCR | Apache-2.0 | permissive |
| Electron, Chromium | MIT / BSD | permissive |
| Python | PSF | permissive |
| Pillow, numpy, OpenCV | MIT-CMU / BSD / Apache-2.0 | permissive |
| **Poppler** | **GPL-2.0-or-later** | **copyleft** — distributing the binaries carries source-availability obligations |

Poppler is the one to think about. It is only used for PDF rasterization. If GPL is a
problem for how you plan to distribute this, the options are to ship its source or a
written offer alongside the installer, or to replace the `pdftoppm`/`pdfinfo` calls in
`server.ts` with a permissively-licensed rasterizer.

## Known limitations

* **Windows x64 only.** The config targets `nsis`/`x64`; the staged binaries are Windows
  builds of Python, Tesseract and Poppler.
* **The first launch is slow** (~2-4 s) while the server starts and the window waits for
  it. Later launches are faster once the OS has the files cached.
* **A `.env` file is not read from the install folder.** Server-side API keys come from
  the environment or from the engine options panel in the UI, which stores them in the
  browser profile.
* **Uninstalling keeps `%APPDATA%\Pulan Tamil OCR`**, so diagnostics records and
  subscription sign-ins survive a reinstall. `deleteAppDataOnUninstall` in
  `electron-builder.yml` flips that.
* **`build/app` is regenerated from scratch** on every staging run, so do not put
  anything there by hand.

