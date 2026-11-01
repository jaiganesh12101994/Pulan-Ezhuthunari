# Claude integration

How the Claude engine works in Pulan Ezhuthunari, in both of its modes, and what
holds it in place. Written for whoever maintains this next, including the notes on
what the code deliberately does *not* do.

## The two backends

| | API key | Subscription |
|---|---|---|
| Transport | Anthropic Messages API over HTTPS, in process | Claude Agent SDK (`claude-agent-sdk`) → Claude Code CLI → your account |
| Code | `aiVision.ts` (`callAnthropic`) | `agentClient.ts` → `backend/agent/` → `aiVision.ts` (`callClaudeAgent`) |
| Needs | `ANTHROPIC_API_KEY`, or a key pasted in the panel | the `claude-agent-sdk` package, which the desktop app already bundles, then **Sign in** in the panel |
| Chosen by | leaving **Subscription** unticked | ticking **Subscription** in the engine options panel |

The panel is unchanged in both modes: layout detection and OCR return the same
shapes, so the viewer, the zone overlays, the diagnostics and the exporters need no
special casing. Only the transport differs. The ChatGPT engine keeps its own `codex`
CLI path; the old one-shot `claude -p` shell-out was retired in favour of the
subscription backend.

## Signing in — from inside the app

Neither Anthropic nor OpenAI publishes an OAuth flow that a third-party app may use
to obtain a *subscription* token. Reimplementing one against the vendor's own client
id would mean impersonating their client: undocumented, against their terms, and
broken the moment they change anything. So the app does the next best thing, which
is what it is designed to do:

**It runs the vendor's own login for you, in the app.** Press **Sign in** in the
engine options panel (next to the Subscription tick) and the panel:

1. starts the provider's official login command,
2. shows the authorization link it prints, with **Copy** and **Open** buttons,
3. **watches for the sign-in to finish by itself** — Claude Code completes it as soon
   as the browser has authorised, prints "Login successful." and exits, so most of the
   time no code is needed at all,
4. takes a code only if the page shows one, and hands it to that command,
5. reports the result, and offers **Sign out** afterwards.

You never open a terminal, and this app never sees a password, a token or a
credential file — the vendor's tool performs the exchange and keeps the credential
itself. Closing the panel, or the app, cancels a sign-in that is still waiting.

Three behaviours in step 3 and 4 are deliberate, and each fixes a real confusion:

* The panel polls `GET /api/agent/login/state` while it waits, so it finishes the
  moment the account appears rather than asking you for a code that will never come.
* A code typed **after** the sign-in already finished reports success, not "the sign-in
  is no longer running".
* A link whose login process has exited is reported as expired, with a **Sign in**
  button for a fresh one — an old link cannot be reused, because it carries that
  process's PKCE challenge.

The panel shows the account it finds, including the plan and address the CLI reports:
`Signed in as Claude Pro (you@example.com)`.

### If the provider's tool is missing

Claude Code ships inside the `claude-agent-sdk` wheel, and the desktop app bundles that
package, so on a normal install there is nothing to fetch: the toolbar shows the account
instead of a warning. OpenAI's Codex CLI ships with nothing, and it is the only supported
way to sign in to a ChatGPT subscription — so it has to be installed. When a tool *is*
missing (running from source, or a `-WithoutClaudeSdk` build), the panel says so, shows
the exact command, and offers **Install it for me**:

| Provider | Command | When the panel offers it |
|---|---|---|
| Claude | `python -m pip install claude-agent-sdk` | the SDK is not installed |
| Claude | `irm https://claude.ai/install.ps1 \| iex` | the SDK is installed, but no usable CLI is |
| ChatGPT | `npm install -g @openai/codex` | the Codex CLI is not installed |

Claude needs two things, and which one is missing decides the command:

* **The `claude-agent-sdk` package is the transport.** Nothing works without it, and its
  wheel carries a Claude Code binary, so installing it fixes both halves at once. This is
  why the desktop app bundles the whole package rather than asking for it later.
* **A usable Claude Code CLI.** With the SDK already present, only the CLI can be
  missing, and Anthropic's own installer is then the right command. It writes a real
  `claude.exe` to `%USERPROFILE%\.local\bin`, where this app already looks, so it needs
  no PATH change and no restart. It is also the fix for npm's `claude.cmd` shim, which
  the SDK refuses to run on Windows.

The command the panel shows is always the command the button runs; the two are generated
together, so they can never describe different fixes.

That button is the only place in this app that installs software. It runs the vendor's
own documented command and nothing else; the app downloads nothing itself, and you can
run the same command yourself instead. If `npm` is missing, the panel tells you to
install Node.js first rather than failing with a raw error.

The ChatGPT flow is worth knowing about: Codex signs in through a **localhost callback**
(`http://127.0.0.1:1455/auth/callback`), so the browser completes the sign-in and the
panel notices by itself — there is usually no code to paste at all.

For Claude the command is `claude auth login --claudeai`, and the state is read with
`claude auth status --json`, which is machine-readable:

```json
{"loggedIn": true, "authMethod": "claudeai", "configDirectory": "C:\\Users\\you\\.claude"}
```

The CLI is bundled with the `claude-agent-sdk` wheel, so there is nothing to install
for it; a `claude` on PATH is used only if you installed one yourself. Anthropic's own
installer (`irm https://claude.ai/install.ps1 | iex`) is the documented way to have one
of your own, and it lands in `%USERPROFILE%\.local\bin`, where the app looks. For
ChatGPT the command is `codex login`, which needs the codex CLI installed
(`npm install -g @openai/codex`).

| `status` | Meaning |
|---|---|
| signed in | the provider's own status says so, and `account` names the credential in use |
| not signed in | the tool ran but no account is signed in — the panel quotes the provider's own words |
| tool not found | no usable executable, with the install instruction |
| timeout | the tool did not answer |
| error | anything else, with the provider's own text |

A **session alone is not proof of sign-in**: the CLI opens a session and only then
reports `authentication_failed`. That distinction is a regression test
(`test_an_expired_oauth_session_is_not_reported_as_signed_in`), and it is why the
"Check again" button asks `auth status` rather than trusting a session.

### The deep check

`POST /api/agent/sign-in` still exists: it runs one minimal query with no tools, so
it proves not just that a credential exists but that the account can actually answer.
It costs one turn, so the panel uses it for the **Test** button rather than for every
status read.


## How usage is billed

* **API key mode** bills the Anthropic API for the key you supplied.
* **Subscription mode** uses your Claude Pro/Max subscription. `ANTHROPIC_API_KEY`
  and `ANTHROPIC_AUTH_TOKEN` are removed from the environment handed to the CLI, and
  `ANTHROPIC_BASE_URL` with them, so subscription traffic cannot be billed to a key
  or routed to a gateway. This is done twice over: the variables are popped from the
  sidecar's own environment before the SDK is used (the SDK builds the CLI's
  environment as `{**os.environ, **options.env}`), and empty values are passed
  through `ClaudeAgentOptions.env`.

Usage draws on the same limits as the Claude apps and Claude Code. The panel says so,
and the footer reports the turn count and any cost/usage figures **the CLI reports** —
nothing is invented. When a limit is hit, the CLI's own reset time is passed on if it
reports one.

The app never reads, copies, stores or logs OAuth tokens or the CLI's credential
files. The only thing read about the account is the CLI's `apiKeySource` label
(`"none"` for a claude.ai login), which is a word, not a secret. An
`ANTHROPIC_API_KEY` label is surfaced as a warning, because it means the API is being
billed instead of the subscription.

## The sidecar

`backend/agent/` is a small Python package that `server.ts` starts the way it starts
`backend/tamil_ocr_engine.py`, but keeps alive and talks to over newline-delimited
JSON on stdio (one JSON object per line; `stdout` carries frames only).

| File | Responsibility |
|---|---|
| `sidecar.py` | the NDJSON protocol, the asyncio loop, request dispatch |
| `subscription_backend.py` | the `ClaudeSDKClient` session, event mapping, interrupt, the error vocabulary |
| `ocr_tools.py` | the eight tools and their shared dispatcher |
| `permissions.py` | the tool allow-list and the `can_use_tool` gate |
| `environment.py` | credential stripping, CLI resolution, the work directory |
| `prompts.py` | the system prompt that replaces Claude Code's coding prompt |

Requests: `status`, `sign-in`, `ask`, `vision`, `new-conversation`, `interrupt`,
`shutdown`. Frames: `info`, `session`, `text_delta`, `tool_call`, `tool_result`,
`warning`, `rate_limit`, `result`, `status`, `sign-in`, `error`, `done`.

The asyncio loop owns the sidecar's main thread and `stdin` is read on a worker
thread, so the loop is never blocked. Requests are handled as separate tasks, which
is why `interrupt` is answered while an `ask` is still streaming. One `claude`
process exists per conversation; **New conversation** closes and recreates it, and the
sidecar stops both when it exits, so no orphan `claude` processes are left behind.

A run can fail *without* raising: the CLI opens a session, answers with
`authentication_failed` or a usage-limit notice, and ends with `is_error`. That text
must never be handed back as a reading of the page, so `run_failure()` classifies it
and `one_shot` raises a `BackendError` carrying the panel's own wording.

## The tools

Claude reaches the document only through these eight tools, defined in `ocr_tools.py`
and exposed as an in-process MCP server named `pulan_ocr`:

| Tool | Reads |
|---|---|
| `get_document_info` | the document, pages, engines, languages, current selection |
| `get_page_text` | the recorded OCR text per region, with status and the engine's confidence |
| `get_page_image` | the rendered page, as a real MCP image block |
| `get_line_image` | one region, cropped from the page |
| `get_low_confidence` | the regions the app itself flagged, with reasons and warning codes |
| `compare_engines` | what different engines recorded for the same region, compared with the app's own similarity measure |
| `get_selection` | whatever is selected in the viewer |
| `propose_edit` | writes a **pending proposal** — nothing is applied |

Every one of them calls the shared dispatcher (`OcrToolContext.dispatch`), which reads
the real `DiagnosticsStore` records and `ocr_quality` checks. There is no second copy
of the OCR logic, and no tool invents a threshold: `get_low_confidence` reports the
status and warning codes the app already stored, and passes the engine's confidence
figure on verbatim (Tesseract reports 0–100, the zone detector 0–1, so comparing
either with a made-up number would be wrong).

`propose_edit` deliberately does **not** touch corrections. The review flow is
unchanged: a proposal is a file under the document's `proposals/` folder with
`status: "pending"`, and the user accepts or rejects it in the app as before.

## The lock-down

The Agent SDK can hand Claude Code's built-in tools (file access, shell, web) to the
model. Four layers prevent it, all set in `SubscriptionBackend.build_options`:

1. `tools=[]` → the SDK passes `--tools ""`, so **no built-in tool is offered**.
2. `disallowed_tools=[…]` → an explicit deny list as the second layer.
3. `setting_sources=[]` with `strict_mcp_config=True` → no user/project settings, no
   `CLAUDE.md`, no hooks, no plugins, and no MCP servers found on disk.
4. `can_use_tool` → a permission callback that allows only `mcp__pulan_ocr__*` and
   refuses everything else, recording each attempt (tool name and argument *keys*
   only, never values, which may hold document text).

`cwd` is an empty application-data folder, never the project or your home directory,
so even a tool that slipped through would have nothing to read. The system prompt is
passed as a *file* (`--system-prompt-file`), because the string form travels on the
command line and Windows caps that at about 32 KB.

The session frame proves all of it at runtime. This is a real one from this machine:

```json
{"event":"session","model":"claude-sonnet-5-5","cliVersion":"2.1.314","credential":"none",
 "tools":["mcp__pulan_ocr__compare_engines","mcp__pulan_ocr__get_document_info",
          "mcp__pulan_ocr__get_line_image","mcp__pulan_ocr__get_low_confidence",
          "mcp__pulan_ocr__get_page_image","mcp__pulan_ocr__get_page_text",
          "mcp__pulan_ocr__get_selection","mcp__pulan_ocr__propose_edit"],
 "mcpServers":["pulan_ocr"],"permissionMode":"default",
 "cwd":"C:\\Users\\<you>\\AppData\\Local\\PulanEzhuthunari\\agent-workdir"}
```

Eight tools, all of them this app's own, and no `Read`, `Bash` or `WebFetch` anywhere.

## Why the page travels through a tool

An Agent SDK prompt carries text only, so the page reaches the model through
`get_page_image` rather than as an inline image part. Two consequences are worth
knowing: a subscription call costs one extra turn (fetch the image, then answer), and
the page has to exist as a file on disk. The API-key mode sends the image inline as
before. The prompts themselves are built by `aiVision.ts` and passed to the sidecar,
so there is exactly one copy of them.

The page description travels with the request as a *context bundle* (pages, image
paths, zone boxes, the current selection), which is what lets the tools fetch and crop
the right page. Both `ask` and `vision` attach it before the model runs; a vision call
without it fails with "no document is attached", which the model then reports honestly.

Both actions report the model **Claude Code actually used**, taken from the session
frame, rather than the name this app would have asked for — a subscription is free to
serve a different model than the default label suggests.

### The ChatGPT path

ChatGPT does not go through the sidecar. The Codex CLI's non-interactive mode is called
directly (`codex exec`), with flags that turned out not to be optional:

* `--skip-git-repo-check` — Codex refuses to run outside a trusted directory, and this
  app is not a git repository, so without it the call stops immediately.
* `-s read-only` — an agent whose only job is to read one image must not be able to
  change anything.
* `-C <temp>` — it works in a throwaway folder, not in the project.
* `-i <image>` and `-o <file>` — the image is attached, and the answer is read from the
  file Codex writes, rather than picked out of its progress output.

Its **stdin is closed at once**, because Codex otherwise prints "Reading additional input
from stdin…" and waits for EOF before answering. The model it reports (for example
`gpt-5.6-luna`) is shown, taken from its own banner, rather than the label this app would
have guessed.

`codex login status` is what makes a finished ChatGPT sign-in visible: it answers
`Logged in using ChatGPT` (exit 0) or `Not logged in` (exit 1) on stderr. Without reading
it, every completed ChatGPT sign-in looked like a failure.

### The Google path

The obvious tool here would be Google's own Gemini CLI, and it no longer works. Its
`Login with Google` flow is refused by Google's servers:

```
IneligibleTierError: This client is no longer supported for Gemini Code Assist for
individuals. To continue using Gemini, please migrate to the Antigravity suite of products
```

That is not a configuration problem to work around: Google retired the Gemini CLI for
individual plans — Google AI Pro included — and restricted it to Enterprise organizations.
So the Google subscription here runs through the **Antigravity CLI** (`agy`), Google's
successor, which supports personal Free, Pro and Ultra plans.

What that means in practice:

* **It installs outside PATH.** Its own installer puts the binary in
  `%LOCALAPPDATA%\agy\bin` (Windows) or `~/.local/bin` (elsewhere), so those folders are
  checked before PATH. `AGY_CLI_BIN` overrides both.
* **There is no `auth login`, no `auth status` and no `auth logout`.** The CLI reads its
  token profile from the operating system keyring (Windows Credential Manager) and signs
  in silently when one is there, opening a browser by itself when there is not. So the
  sign-in state is read from the keyring entry's *name* — `gemini:antigravity` on the
  machine this was built on, matched loosely in case it is named differently elsewhere —
  which `cmdkey /list` prints without any secret. No CLI run is made to ask.
* **The sign-in is shared with the Antigravity app**, so a machine that already uses
  Antigravity is usually signed in before the panel is even opened.
* **Signing in is the CLI in a terminal window, and that is the CLI's design.** Google's
  redirect goes to a *hosted* page (`https://antigravity.google/oauth-callback`) which
  **shows a code** instead of calling anything back on this machine. The CLI holds the
  PKCE verifier that code has to be exchanged with, and the only prompt that accepts it is
  the CLI's own — "Enter the authorization code". Print mode does not read one from stdin
  either (measured: it waits its full minute and times out), so the panel opens the CLI in
  a terminal window, states exactly what to do there, and watches the keyring for the
  result. The vendor's own documentation says the same thing: "Authenticate once with an
  interactive `agy` session first."
* **A code typed into the panel is refused with an explanation** rather than accepted and
  silently dropped. This app cannot complete the exchange — only the CLI process can — and
  saying so is more use than pretending.
* **The sign-in state is never probed.** That is what filled the screen with sign-in tabs:
  a headless `agy` with no credential starts an OAuth flow and opens the browser, and the
  panel used to run one as a probe — every few seconds while it watched. The keyring
  entry's name is the state instead, read with `cmdkey /list`, which prints no secret and
  starts nothing.
* **The page is handed over in a workspace of its own.** This matters more than it
  sounds: the CLI is a coding agent, and when its workspace is the project it reads the
  project. One measured run spent 203k tokens and over five minutes doing that instead of
  looking at the page. The page and the prompt therefore go into a throwaway folder that
  becomes the workspace, and the instruction forbids exploring it.
* **`--effort low` is passed** unless the panel names a model. The CLI's default is
  `high`, which thinks for minutes about a layout that is plain to see; the same page
  takes about 25 seconds at `low`. `--mode plan` keeps the agent read-only. The reported
  model is the one the app asked for, because the CLI's JSON envelope reports tokens, not
  the model.

### Page size, and why a big scan used to fail

A page rendered at 200 DPI is several megabytes of PNG, and base64 makes it about a
third larger again — past the Agent SDK's **1 MB per-message limit**. That limit is
what a page image hits, because the image travels through a tool. Two things keep it
from breaking a call:

* The page is scaled to `PULAN_AGENT_MAX_IMAGE_EDGE` (default **1600 px** on the long
  edge) before it is sent. The model is told the size of the image it is *shown*, so
  its coordinates are in that space, and `aiVision.ts` maps them back to page pixels —
  the prompt and the rescale use one scale factor, decided by the caller.
* `max_buffer_size` is raised to `PULAN_AGENT_MAX_BUFFER` (default **64 MB**) as the
  safety net, because a dense scan can still exceed 1 MB after scaling.

If a page is still too large, the panel says so and suggests a lower render DPI or one
region at a time, rather than failing with a JSON decode error. OCR (text) has no
coordinates to map, so capping the image there only makes the call smaller.

## Known limitations

* **One page per one-shot call.** Batch OCR loops page by page, as the other engines do.
* **A changed `maxTurns` applies from the next conversation**, because the CLI takes
  that setting when the process starts. A changed *model* is applied live.
* **`compare_engines` needs two engines to have run** over the same region; with one
  it says so rather than guessing.
* **Vision models report no confidence.** AI regions therefore record "not reported"
  and rely on the quality checks for review status.
* **The subscription path needs a file path** for the page. A data-URL-only image
  cannot be read by it, and the message says so.
* **The `ask` conversation has no panel yet.** The route and the client are complete
  and tested, but nothing in the UI drives them; layout detection and OCR are what the
  toolbar uses. Wiring a review panel is the obvious next step.
* **ChatGPT needs the Codex CLI installed**, which nothing else provides. The panel
  installs it on request (`npm install -g @openai/codex`), and its sign-in goes through a
  localhost callback, so no code has to be pasted.
* **Google has no sign-out command to run.** Signing out deletes the shared Antigravity
  credential from the system keyring, which signs the Antigravity app out too; the panel
  says so rather than pretending otherwise.
* **A Google sign-in needs a terminal window.** Google's flow ends by showing a code that
  only the CLI's own prompt can accept, so that last step cannot happen inside this app.
* **The Gemini CLI cannot be used for a Google subscription at all.** Google retired it
  for individual plans; only the Antigravity CLI can sign one in.
* **The app does not store credentials of its own.** It relies entirely on the
  vendor's tool for that, which is why the vendor's tool has to be present.
* Live tests need a signed-in account, so they are deselected by default.

## Versions tested

| Component | Version |
|---|---|
| `claude-agent-sdk` (Python) | 0.2.175, pinned |
| Bundled Claude Code CLI | 2.1.314 |
| OpenAI Codex CLI | 0.166.0 (`npm install -g @openai/codex`) |
| Antigravity CLI | 1.4.12 (`irm https://antigravity.google/cli/install.ps1 | iex`) |
| Python | 3.11.4 (the SDK needs 3.10+) |

The wheel bundles `claude.exe`, and on Windows the SDK **refuses npm's `claude.cmd`
shim**, so a system install has to be the native `claude.exe` — Anthropic's own
installer (`irm https://claude.ai/install.ps1 | iex`) writes one to
`%USERPROFILE%\.local\bin`, which the app probes. `PULAN_CLAUDE_CLI` (or the CLI path
field in the panel) points at one when you want to run your own.

## Tests

```
npm test                                  # everything deterministic (pytest)
python -m pytest backend/tests -m live    # needs a signed-in Claude Code CLI
```

The deterministic suite covers the credential stripping, the lock-down options, the
permission callback, the tool logic through the dispatcher, the image content, the
proposal flow, the message-to-event mapping and the error vocabulary. The live tests
cover the sign-in check, one page review that tries to reach the filesystem (the
assertion is that the work directory stays empty) and Stop.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /api/agent/status` | SDK, CLI, work directory, account, tool list, refusal counts |
| `GET /api/agent/auth-status` | the provider's own sign-in status (`?provider=claude\|chatgpt`) |
| `POST /api/agent/sign-in` | the deep check: one minimal query, no tools |
| `POST /api/agent/login/start` | begin a sign-in; returns the authorization URL |
| `GET /api/agent/login/state` | how a sign-in stands; the panel polls this |
| `POST /api/agent/install-cli` | install the provider's tool (`pip`, `npm`, or the vendor's own installer), on request |
| `POST /api/agent/login/code` | hand the pasted code to that login |
| `POST /api/agent/login/cancel` | abandon a sign-in still waiting for a code |
| `POST /api/agent/logout` | sign out through the provider's own command |
| `POST /api/agent/ask` | one message in the conversation, streamed as NDJSON |
| `POST /api/agent/interrupt` | stop the run in flight |
| `POST /api/agent/new-conversation` | drop the context and start again |
| `POST /api/agent/shutdown` | stop the sidecar and its `claude` child |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Badge says *Agent SDK not installed* | the `claude-agent-sdk` package is missing; press **Install it for me** in the sign-in panel, or `pip install claude-agent-sdk` in the Python this app uses. A packaged build bundles both the SDK and pip |
| *OpenAI's Codex CLI was not found* | press **Install it for me** in the sign-in panel, or run `npm install -g @openai/codex` |
| Badge says *Claude Code not found* | the SDK is present but no usable executable; press **Install it for me** (Anthropic's installer), or set the CLI path to a native `claude.exe` |
| *Claude Code is not signed in* | press **Sign in** and finish in the browser; no terminal is needed |
| The sign-in link never appears | the tool opened a browser instead of printing one; finish there and press **Check again** |
| The code was rejected | codes expire; press **Cancel** and **Sign in** again for a fresh link |
| *The page image was too large for Claude Code* | lower the PDF render DPI, or raise `PULAN_AGENT_MAX_IMAGE_EDGE` / `PULAN_AGENT_MAX_BUFFER` |
| Badge says *Anthropic API key (the API is billed…)* | a key is reaching the CLI anyway; check `ANTHROPIC_API_KEY` in the environment that starts `npm run dev` |
| *Your Claude subscription limit has been reached* | the limit is shared with the Claude apps and Claude Code; the reset time is shown when the CLI reports one |
| Stop seems to do nothing | the interrupt goes to the CLI; if the process is wedged, **New conversation** replaces it |



