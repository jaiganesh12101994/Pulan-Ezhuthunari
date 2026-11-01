#!/usr/bin/env python3
"""
In-app sign-in for the subscription backends.

Neither Anthropic nor OpenAI publishes an OAuth flow that a third-party app may use
to obtain a *subscription* token, so the only supported way to sign in to a Claude
Pro/Max or ChatGPT subscription is the vendor's own login. This module runs that
login *for* the user:

* it starts the official command (``claude auth login --claudeai`` / ``codex login``),
* hands the authorization URL back to the app, so the panel can show it and open it,
* takes the code the user pastes into the panel and gives it to the command,
* reports the result, and can sign out again.

The user therefore never opens a terminal, and nothing here reads, copies, stores or
logs a token, a refresh token or a credential file: the vendor's tool performs the
exchange and keeps the credential itself. ``claude auth status --json`` is the
supported way to *ask* about the sign-in, and it is machine-readable.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time

from environment import (
    claude_code_install_command,
    claude_code_install_hint,
    resolve_cli,
    sdk_available,
)

#: The subscriptions this app can drive.
PROVIDERS = ("claude", "chatgpt", "google")

#: How each provider's tool is named in the panel.
PROVIDER_LABELS = {
    "claude": "Claude Code",
    "chatgpt": "OpenAI's Codex CLI",
    "google": "Google's Antigravity CLI",
}

#: How long the panel keeps watching for a Google sign-in to land in the keyring. The
#: interactive flow waits for the user, who has a browser step and a code to paste, so
#: this is deliberately generous.
GOOGLE_SIGN_IN_WINDOW = 900.0

_ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")
_URL = re.compile(r"https://[^\s\"'<>]+")

CLAUDE_INSTRUCTIONS = (
    "Approve access in the browser window that opened (or open the link below). This "
    "panel notices by itself when the sign-in is done. If the page shows a code, paste "
    "it below; if it does not, just wait a moment — no code is needed."
)
CODEX_INSTRUCTIONS = (
    "Sign in with your ChatGPT account in the browser window that opened (or open the "
    "link below). This panel notices by itself when the sign-in is done; paste a code "
    "below only if the page shows one."
)
GOOGLE_INSTRUCTIONS = (
    "A terminal window has opened and the Antigravity CLI is starting Google's sign-in "
    "there. If that window first asks about a colour scheme, a rendering mode or workspace "
    "trust, answer those. Then your browser opens for the Google account that holds your "
    "plan: approve it, and Google shows a code. The CLI asks \"Enter the authorization "
    "code\" — paste the code into that terminal window. This panel notices by itself once "
    "it succeeds, so nothing has to be typed here."
)


class AuthError(RuntimeError):
    """A sign-in failure the panel can explain."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def clean(text):
    """Strip ANSI colour and carriage returns from a CLI line."""
    return _ANSI.sub("", str(text)).replace("\r", "").strip()


def find_url(text):
    """The authorization URL a login command printed, if any."""
    match = _URL.search(text)
    if not match:
        return None
    # The trailing prompt can be glued to the URL when the line is not framed.
    return match.group(0).rstrip(".,;)")


def provider_cli(provider, cli_path=None):
    """The executable that owns this provider's sign-in."""
    if provider == "claude":
        return resolve_cli(cli_path)
    if provider == "chatgpt":
        configured = os.environ.get("CODEX_CLI_BIN")
        found = configured if configured and os.path.sep in configured else shutil.which(
            configured or "codex"
        )
        return {
            "path": found,
            "source": "environment" if configured else "path",
            "found": bool(found),
            "usable": bool(found and os.path.isfile(found)),
            "reason": None,
        }
    if provider == "google":
        return find_antigravity()
    raise AuthError("unknown_provider", f"There is no subscription sign-in for {provider!r}.")


def find_antigravity():
    """
    Where the Antigravity CLI is.

    It does not install itself into PATH: its own installer puts the binary in
    ``%LOCALAPPDATA%\\agy\\bin`` on Windows and ``~/.local/bin`` elsewhere. Looking only
    at PATH would report an installed CLI as missing, so its own folder is checked
    first and PATH is the fallback.
    """
    configured = (os.environ.get("AGY_CLI_BIN") or "").strip()
    exe = "agy.exe" if os.name == "nt" else "agy"
    candidates = []
    if configured:
        candidates.append((configured, "environment"))
    local = (os.environ.get("LOCALAPPDATA") or "").strip()
    if local:
        candidates.append((os.path.join(local, "agy", "bin", exe), "installer"))
    candidates.append(
        (os.path.join(os.path.expanduser("~"), ".local", "bin", "agy"), "installer")
    )
    for path_value, source in candidates:
        if path_value and os.path.isfile(path_value):
            return {
                "path": path_value,
                "source": source,
                "found": True,
                "usable": True,
                "reason": None,
            }
    on_path = shutil.which("agy") or (shutil.which("agy.exe") if os.name == "nt" else None)
    if on_path:
        return {
            "path": on_path,
            "source": "path",
            "found": True,
            "usable": True,
            "reason": None,
        }
    return {
        "path": None,
        "source": "none",
        "found": False,
        "usable": False,
        "reason": "The Antigravity CLI was not found.",
    }


def _open_terminal(command):
    """
    Open the vendor's own CLI in a visible terminal window.

    Google's flow redirects to a hosted page (`https://antigravity.google/oauth-callback`)
    that *displays a code* rather than calling anything back on this machine, and the only
    place that code can be entered is the CLI's own prompt — "Enter the authorization
    code". The CLI is a full-screen application, so it needs a terminal to ask in, and the
    code has to be typed by the user there. `start` is cmd.exe's own launcher, so this
    needs no window API and no extra dependency.
    """
    if os.name == "nt":
        return subprocess.Popen(["cmd", "/c", "start", "", "cmd", "/k", command])
    opener = (
        shutil.which("x-terminal-emulator")
        or shutil.which("gnome-terminal")
        or shutil.which("xterm")
        or shutil.which("open")
    )
    if not opener:
        raise AuthError(
            "no_terminal",
            f"No terminal launcher was found. Run `{command}` in a terminal and sign in there.",
        )
    return subprocess.Popen([opener, command])


def check_provider(provider):
    if provider not in PROVIDERS:
        raise AuthError(
            "unknown_provider",
            f"There is no subscription sign-in for {provider!r}; use one of {', '.join(PROVIDERS)}.",
        )
    return provider


def auth_status(provider="claude", cli_path=None):
    """
    The supported way to ask about a subscription sign-in.

    Claude answers with JSON (``claude auth status --json``); the ChatGPT CLI has no
    equivalent, so its state is reported as unknown until a login is run.
    """
    check_provider(provider)
    cli = provider_cli(provider, cli_path)
    report = {
        "provider": provider,
        "cli": cli,
        "available": bool(cli.get("usable")),
        "loggedIn": None,
        "authMethod": None,
        "account": None,
        "configDirectory": None,
        "message": None,
    }
    if not cli.get("usable"):
        report["installable"] = True
        report["installCommand"] = install_hint(provider)
        message = (
            f"{PROVIDER_LABELS[provider]} was not found. Install it with: "
            + install_hint(provider)
        )
        if provider == "claude" and not sdk_available():
            # Say plainly why this is the package and not the CLI installer: without it
            # the app has no transport at all, so installing Claude Code on its own
            # would still leave the panel in this state.
            message += (
                " It installs the claude-agent-sdk package this app talks to Claude Code "
                "through, and brings a Claude Code binary with it. Anthropic's own "
                f"installer ({claude_code_install_hint()}) installs Claude Code alone, "
                "which this app cannot use without that package."
            )
        report["message"] = message
        return report
    if provider == "chatgpt":
        return _read_codex_status(cli, report)
    if provider == "google":
        return _read_google_status(cli, report)

    try:
        completed = subprocess.run(
            [cli["path"], "auth", "status", "--json"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
        )
    except Exception as exc:  # noqa: BLE001 - reported, never raised
        report["message"] = f"The sign-in status could not be read: {exc}"
        return report

    output = clean(completed.stdout) or clean(completed.stderr)
    payload = _json_object(output)
    if payload is None:
        report["message"] = output[:300] or "The sign-in status could not be read."
        return report
    report["loggedIn"] = bool(payload.get("loggedIn"))
    report["authMethod"] = payload.get("authMethod")
    report["configDirectory"] = payload.get("configDirectory")
    report["email"] = payload.get("email")
    report["orgName"] = payload.get("orgName")
    report["subscriptionType"] = payload.get("subscriptionType")
    report["account"] = describe_account(payload)
    report["message"] = (
        f"Signed in as {report['account']}."
        if report["loggedIn"] and report["account"]
        else "Signed in."
        if report["loggedIn"]
        else "Not signed in. Press Sign in to continue."
    )
    return report


def _read_codex_status(cli, report):
    """
    Ask the Codex CLI about its own sign-in.

    It has no JSON mode, so the answer is read from its text — ``Logged in using
    ChatGPT`` (exit 0) or ``Not logged in`` (exit 1) — and it writes that to stderr, so
    both streams are checked. Without this the panel could never tell that a ChatGPT
    sign-in had succeeded, and every finished login looked like a failure.
    """
    try:
        completed = subprocess.run(
            [cli["path"], "login", "status"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
        )
    except Exception as exc:  # noqa: BLE001 - reported, never raised
        report["message"] = f"The sign-in status could not be read: {exc}"
        return report
    text = "\n".join(
        part for part in (clean(completed.stdout), clean(completed.stderr)) if part
    )
    lowered = text.lower()
    if "not logged in" in lowered or "no credentials" in lowered:
        report["loggedIn"] = False
    elif "logged in" in lowered:
        report["loggedIn"] = True
        report["authMethod"] = "api" if "api key" in lowered else "chatgpt"
    else:
        report["loggedIn"] = completed.returncode == 0
    report["account"] = describe_account(
        {"loggedIn": report["loggedIn"], "authMethod": report["authMethod"]}
    )
    report["message"] = (
        f"Signed in as {report['account']}."
        if report["loggedIn"] and report["account"]
        else "Signed in."
        if report["loggedIn"]
        else "Not signed in. Press Sign in to continue."
    )
    return report


def _json_object(text):
    start = text.find("{")
    if start == -1:
        return None
    try:
        return json.loads(text[start:])
    except ValueError:
        return None


def _google_account():
    """
    The Google address the Antigravity CLI is signed in with.

    The CLI keeps its account list in ``~/.gemini/google_accounts.json``. Only the email
    is read, so the panel can say *which* account a plan belongs to; no token lives in
    that file.
    """
    try:
        path_value = os.path.join(
            os.path.expanduser("~"), ".gemini", "google_accounts.json"
        )
        with open(path_value, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        active = payload.get("active") if isinstance(payload, dict) else None
        return str(active).strip() if active else None
    except Exception:  # noqa: BLE001 - a missing account file is not an error
        return None


def _antigravity_keyring_entries():
    """
    The names of the Antigravity credentials in the operating system's keyring.

    `cmdkey /list` prints those names and no secret, which is exactly the question being
    asked: the CLI signs in silently from this credential, so its presence *is* the
    sign-in state. Names are matched loosely because the entry is created by whichever
    Antigravity surface signed in first — the app, an IDE extension or the CLI itself.
    """
    if os.name != "nt":
        return []
    try:
        completed = subprocess.run(
            ["cmdkey", "/list"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
    except Exception:  # noqa: BLE001 - reported as "not signed in" by the caller
        return []
    entries = []
    for line in f"{completed.stdout}\n{completed.stderr}".splitlines():
        if "target=" in line and "antigravity" in line.lower():
            entries.append(line.split("target=", 1)[1].strip())
    return entries


def _read_google_status(cli, report):
    """
    Ask about the Google sign-in the Antigravity CLI uses.

    There is no ``auth status`` subcommand, and there must be no probing run either: a
    headless ``agy`` that finds no credential **starts an OAuth flow and opens the
    browser**, then waits a minute for the callback. Asking that way opened a sign-in
    page every time the panel was looked at — and the panel looks every few seconds.

    So the keyring is the answer, and it costs nothing and touches nothing.
    """
    entries = _antigravity_keyring_entries()
    account = _google_account()
    report["keyringEntry"] = entries[0] if entries else None
    if os.name != "nt":
        # The keyring check above is Windows-only. Elsewhere the state is reported as
        # unknown rather than as "signed in" or "signed out", because guessing wrong
        # would either hide a working subscription or send the user through a sign-in
        # they do not need.
        report["loggedIn"] = None
        report["message"] = (
            "This app can only read the Antigravity sign-in from the Windows Credential "
            "Manager. If the Antigravity CLI works in a terminal, the subscription will "
            "work here too."
        )
        return report
    report["loggedIn"] = bool(entries)
    report["authMethod"] = "google" if entries else None
    if entries:
        report["account"] = (
            f"Google subscription (Antigravity CLI, {account})"
            if account
            else "Google subscription (via the Antigravity CLI)"
        )
        report["message"] = (
            f"Signed in as {report['account']}. This sign-in is shared with the "
            "Antigravity app, and usage draws on the same Google AI plan limits."
        )
    else:
        report["account"] = None
        report["message"] = (
            "No Google sign-in was found for the Antigravity CLI. Press Sign in: it opens "
            "the CLI in a terminal window, which starts Google's sign-in and asks there for "
            "the code Google shows you."
        )
    return report


def describe_method(auth_method):
    """
    Turn the CLI's own ``authMethod`` into something the panel can show. ``claudeai``
    is the subscription; anything else means the API is being billed instead.
    """
    if not auth_method:
        return None
    method = str(auth_method).strip().lower()
    if method in ("", "none", "null"):
        return None
    if "chatgpt" in method:
        return "ChatGPT subscription (via the Codex CLI)"
    if "claudeai" in method or method in ("oauth", "claude.ai"):
        return "Claude subscription (via Claude Code)"
    if "console" in method:
        return "Anthropic Console account (API billing, not your subscription)"
    if "api" in method:
        return "Anthropic API key (the API is billed, not your subscription)"
    return str(auth_method)


def describe_account(payload):
    """
    The account line for the panel, built from what the CLI reports. The plan and the
    email address are shown when the CLI gives them, because confirming *which* account
    is in use is the whole point of showing this at all.
    """
    if not payload.get("loggedIn"):
        return None
    method = describe_method(payload.get("authMethod"))
    email = payload.get("email")
    plan = payload.get("subscriptionType")
    if plan:
        return f"Claude {str(plan).capitalize()}" + (f" ({email})" if email else "")
    if email:
        return f"{method or 'Signed in'} ({email})"
    return method


def install_hint(provider):
    """
    The vendor's documented install command, as text for the panel.

    Claude Code needs two things, and which one is missing decides the answer. Without
    the claude-agent-sdk package there is no transport at all, and installing that
    package is also what puts a Claude Code binary on the machine, because the wheel
    ships one. With the package already present it is the CLI that is missing, and
    Anthropic's own installer is then the documented fix: it writes a real claude.exe
    to ~/.local/bin, where this app already looks for it.
    """
    check_provider(provider)
    if provider == "claude":
        if sdk_available():
            return claude_code_install_hint()
        return "python -m pip install claude-agent-sdk"
    if provider == "google":
        # The Gemini CLI used to be the answer here. It is not any more: Google retired
        # its individual subscription login and pointed users at Antigravity instead.
        return (
            "irm https://antigravity.google/cli/install.ps1 | iex"
            if os.name == "nt"
            else "curl -fsSL https://antigravity.google/cli/install.sh | bash"
        )
    return "npm install -g @openai/codex"


def install_command(provider):
    """
    The same command as an argv list. Returned separately from the hint so the panel
    can be explicit about what it is about to run.
    """
    check_provider(provider)
    if provider == "claude":
        # The same split as install_hint, so the command the panel runs is the command
        # it showed: the package when the app has no transport, Anthropic's installer
        # when only the CLI is missing.
        if sdk_available():
            return claude_code_install_command()
        return [sys.executable, "-m", "pip", "install", "claude-agent-sdk"]
    if provider == "google":
        # Google's own installer, run exactly as its documentation gives it.
        if os.name == "nt":
            powershell = (
                shutil.which("powershell") or shutil.which("powershell.exe") or "powershell"
            )
            return [
                powershell,
                "-NoProfile",
                "-Command",
                "irm https://antigravity.google/cli/install.ps1 | iex",
            ]
        return ["sh", "-c", "curl -fsSL https://antigravity.google/cli/install.sh | bash"]
    npm = shutil.which("npm") or (shutil.which("npm.cmd") if os.name == "nt" else None)
    if not npm:
        raise AuthError(
            "npm_missing",
            "npm was not found, so the Codex CLI cannot be installed for you. Install "
            "Node.js from https://nodejs.org and then run: npm install -g @openai/codex",
        )
    return [npm, "install", "-g", "@openai/codex"]


def _installer_spawn_options():
    """
    How to run a vendor installer without handing it the sidecar's own plumbing.

    Two things matter on Windows. The sidecar's stdin is the pipe node writes the sidecar
    protocol to, so the child is given DEVNULL rather than a share of it: nothing about an
    installer should be able to read or consume that. And the child is a console program
    while this app is not, so CREATE_NO_WINDOW keeps Windows from creating a console for
    it — that combination is what a child can get stuck in before it ever runs.
    """
    options = {"stdin": subprocess.DEVNULL}
    if os.name == "nt":
        options["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    return options


def install_tool(provider, timeout=900):
    """
    Install the provider's sign-in tool, using the vendor's own documented command.

    This runs only when the user asks for it from the panel, and it is the one place in
    this app that installs software. Nothing is downloaded by this app itself.
    """
    command = install_command(provider)
    shown = install_hint(provider)
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            **_installer_spawn_options(),
        )
    except Exception as exc:  # noqa: BLE001 - reported, never raised raw
        raise AuthError("install_failed", f"`{shown}` could not be run: {exc}") from exc
    output = "\n".join(
        part for part in (clean(completed.stdout), clean(completed.stderr)) if part
    ).strip()
    if completed.returncode != 0:
        raise AuthError("install_failed", f"`{shown}` failed: {output[-400:]}")
    report = auth_status(provider)
    return {
        "ok": True,
        "command": shown,
        "output": output[-800:],
        "status": report,
        "message": f"Installed with `{shown}`. {report.get('message') or ''}".strip(),
    }


class LoginSession:
    """
    One sign-in in progress: the command runs, its output is read, and the code the
    user pastes into the panel is written back to it.
    """

    def __init__(self, provider="claude", cli_path=None, email=None, url_timeout=45.0):
        self.provider = check_provider(provider)
        self.cli_path = cli_path
        self.email = (email or "").strip()
        self.url_timeout = float(url_timeout)
        self.process = None
        self.url = None
        self.instructions = (
            CLAUDE_INSTRUCTIONS
            if self.provider == "claude"
            else GOOGLE_INSTRUCTIONS
            if self.provider == "google"
            else CODEX_INSTRUCTIONS
        )
        # Google's sign-in is watched for a while rather than driven: nothing is pasted.
        self._deadline = None
        self.output = []
        self._lock = threading.Lock()
        self._finished = threading.Event()
        self._exit_code = None

    # -- lifecycle --------------------------------------------------------
    def _command(self):
        cli = provider_cli(self.provider, self.cli_path)
        if not cli.get("usable"):
            raise AuthError(
                "cli_not_found",
                f"The {self.provider} sign-in tool was not found. Install it with: "
                + (
                    install_hint("claude")
                    if self.provider == "claude"
                    else "npm install -g @openai/codex"
                ),
            )
        if self.provider == "claude":
            command = [cli["path"], "auth", "login", "--claudeai"]
            if self.email:
                command += ["--email", self.email]
            return command
        return [cli["path"], "login"]

    def start(self):
        """Start the login and wait until it prints an authorization URL."""
        if self.provider == "google":
            return self._start_google()
        command = self._command()
        try:
            self.process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                env=self._environment(),
            )
        except Exception as exc:  # noqa: BLE001
            raise AuthError("cli_not_found", f"The sign-in could not be started: {exc}") from exc

        threading.Thread(target=self._read, daemon=True).start()
        deadline = time.time() + self.url_timeout
        while time.time() < deadline and not self.url and not self._finished.is_set():
            time.sleep(0.1)
        if not self.url and self._finished.is_set():
            raise AuthError(
                "login_failed",
                self.tail() or "The sign-in command stopped without giving a link.",
            )
        return {
            "provider": self.provider,
            "url": self.url,
            "instructions": self.instructions,
            "command": os.path.basename(command[0]),
            "email": self.email or None,
        }

    def _start_google(self):
        """
        Begin Google's own sign-in for the Antigravity CLI.

        This step cannot be completed from inside this app, and that is the CLI's design
        rather than a gap here. Google's redirect goes to a *hosted* page
        (`https://antigravity.google/oauth-callback`) which shows a code; the CLI holds the
        PKCE verifier that code has to be exchanged with; and the only prompt that accepts
        the code is the CLI's own. Print mode does not read one from stdin — measured, it
        waits its full minute and times out — so the CLI is opened in a terminal window
        where its own prompt can take the code, and this panel watches the keyring.
        """
        cli = provider_cli(self.provider, self.cli_path)
        if not cli.get("usable"):
            raise AuthError(
                "cli_not_found",
                "The Antigravity CLI was not found. Install it with: " + install_hint("google"),
            )
        self._deadline = time.time() + GOOGLE_SIGN_IN_WINDOW
        try:
            _open_terminal(cli["path"])
        except AuthError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise AuthError(
                "login_failed", f"The sign-in window could not be opened: {exc}"
            ) from exc
        return {
            "provider": "google",
            "url": None,
            "instructions": self.instructions,
            "command": os.path.basename(cli["path"]),
            "email": None,
            "window": True,
        }

    def _google_outcome(self):
        """
        How a Google sign-in stands.

        Nothing here owns the CLI's process — it is the user's terminal window — so the
        keyring is the only signal, and it is the right one: the moment the CLI has stored
        its credential the sign-in is done.
        """
        report = auth_status(self.provider, self.cli_path)
        if report.get("loggedIn"):
            return {
                "outcome": "signed_in",
                "status": report,
                "message": f"Signed in as {report.get('account') or 'your Google account'}.",
            }
        if self._deadline and time.time() > self._deadline:
            return {
                "outcome": "failed",
                "status": report,
                "message": "No Google sign-in appeared. Press Sign in again to reopen "
                "Google's sign-in window.",
            }
        return {
            "outcome": "waiting",
            "status": report,
            "message": report.get("message"),
        }

    def _environment(self):
        """Never let an API key turn a subscription sign-in into an API sign-in."""
        env = dict(os.environ)
        for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
            env.pop(name, None)
        return env

    def _read(self):
        """Collect output; the authorization URL is picked out as soon as it appears."""
        stream = self.process.stdout if self.process else None
        try:
            if stream is not None:
                for line in stream:
                    text = clean(line)
                    if not text:
                        continue
                    with self._lock:
                        self.output.append(text)
                        del self.output[:-200]
                    if "://" in text:
                        candidate = find_url(text)
                        # A Google run's progress output can carry other links, so an
                        # authorization link replaces whatever was picked up first.
                        if candidate and (
                            self.url is None or "accounts.google.com" in candidate
                        ):
                            self.url = candidate
        except Exception:  # noqa: BLE001 - the stream can close at any moment
            pass
        finally:
            code = None
            if self.process is not None:
                try:
                    code = self.process.wait(timeout=10)
                except Exception:  # noqa: BLE001
                    code = None
            self._exit_code = code
            self._finished.set()

    def tail(self, lines=6):
        with self._lock:
            return "\n".join(self.output[-lines:])

    def exit_code(self):
        """The command's exit status once it has ended, however we learned that."""
        if self.process is not None:
            code = self.process.poll()
            if code is not None:
                return code
        return self._exit_code

    def state(self):
        """
        The process itself decides whether the login has ended: the reader thread may
        not have seen the end of the stream yet, and its flag alone would let a finished
        login read as still waiting.
        """
        running = bool(self.process and self.process.poll() is None)
        return {
            "provider": self.provider,
            "url": self.url,
            "running": running,
            "finished": self._finished.is_set() or (self.process is not None and not running),
            "exitCode": self.exit_code(),
        }

    def outcome(self):
        """
        How the sign-in stands, in one call, for the panel to poll.

        Claude Code completes the sign-in by itself once the browser has authorised, so
        "the process has exited" is not a failure — the account is asked, and that is
        the answer that counts.
        """
        state = self.state()
        report = auth_status(self.provider, self.cli_path)
        if self.provider == "google":
            return self._google_outcome()
        if report.get("loggedIn"):
            return {
                "outcome": "signed_in",
                "state": state,
                "status": report,
                "message": f"Signed in as {report.get('account') or 'your subscription'}.",
            }
        if state["finished"]:
            return {
                "outcome": "failed",
                "state": state,
                "status": report,
                "tail": self.tail(),
                "message": "The sign-in window closed before it finished. Press Sign in again "
                "for a fresh link — an old link cannot be reused.",
            }
        return {"outcome": "waiting", "state": state, "status": report}

    def submit_code(self, code, timeout=180.0):
        """
        Hand the pasted code to the command and wait for it to finish. A login ends
        when the command exits, so its exit status plus ``auth status`` is the verdict.
        """
        text = (code or "").strip()
        if not text:
            raise AuthError("no_code", "Paste the code from the sign-in page first.")
        if self.provider == "google":
            # There is nothing here to hand a code to: it belongs to the CLI's own prompt in
            # the terminal window that opened. If the keyring already has the credential,
            # the sign-in has simply worked.
            report = auth_status("google", self.cli_path)
            if report.get("loggedIn"):
                return {
                    "ok": True,
                    "message": f"Signed in as {report.get('account') or 'your Google account'}.",
                    "account": report.get("account"),
                    "authMethod": "google",
                    "status": report,
                }
            raise AuthError(
                "no_code_here",
                "Google's code goes into the terminal window that opened — the Antigravity "
                "CLI asks for it there. If that window is closed, press Sign in again.",
            )
        if self.process is None:
            raise AuthError(
                "login_not_running", "The sign-in was never started. Press Sign in."
            )
        if self.process.poll() is not None:
            # Claude Code often finishes the sign-in *itself* once the browser has
            # authorised: it prints "Login successful." and exits without ever needing a
            # pasted code. A code typed after that is not an error, and must not be
            # reported as one.
            report = auth_status(self.provider, self.cli_path)
            if report.get("loggedIn"):
                return {
                    "ok": True,
                    "message": f"Signed in as {report.get('account') or 'your subscription'}.",
                    "account": report.get("account"),
                    "authMethod": report.get("authMethod"),
                    "status": report,
                }
            raise AuthError(
                "login_not_running",
                "The sign-in window closed before it finished. Press Sign in again for a "
                "fresh link — an old link cannot be reused.",
            )
        try:
            self.process.stdin.write(text + "\n")
            self.process.stdin.flush()
        except Exception as exc:  # noqa: BLE001
            raise AuthError("login_failed", f"The code could not be sent: {exc}") from exc
        if not self._finished.wait(timeout):
            self.cancel()
            raise AuthError("timeout", "The sign-in did not finish in time. Try again.")

        report = auth_status(self.provider, self.cli_path)
        if report.get("loggedIn"):
            account = report.get("account") or "your subscription"
            return {
                "ok": True,
                "message": f"Signed in as {account}.",
                "account": report.get("account"),
                "authMethod": report.get("authMethod"),
            }
        detail = self.tail() or report.get("message") or "The sign-in was not completed."
        raise AuthError("login_failed", detail[:400])

    def cancel(self):
        """
        Stop a sign-in the user abandoned, so no process is left waiting. The wait is
        what makes that a guarantee rather than a hope: on Windows the kill is
        asynchronous.
        """
        if self.process and self.process.poll() is None:
            try:
                self.process.kill()
            except Exception:  # noqa: BLE001 - already gone
                pass
            try:
                self.process.wait(timeout=5)
            except Exception:  # noqa: BLE001 - it will exit on its own
                pass
        return {"cancelled": True}


def _logout_google(cli):
    """
    Sign out of Google for the Antigravity CLI.

    There is no sign-out command either: the credential is the shared Antigravity one
    in the operating system keyring, which the Antigravity app uses as well. So the
    entry is removed with the operating system's own tool, and the answer says plainly
    that the app's sign-in goes with it.
    """
    del cli  # the keyring is the credential store, not the executable
    entries = _antigravity_keyring_entries()
    entry = entries[0] if entries else None
    if not entry:
        return {
            "ok": True,
            "message": "No Google sign-in is stored for the Antigravity CLI, so there is "
            "nothing to sign out of.",
            "status": auth_status("google"),
        }
    if os.name != "nt":
        return {
            "ok": False,
            "message": "Remove the Antigravity credential from this system's keyring to "
            "sign out; the Antigravity CLI keeps no sign-out command of its own.",
            "status": auth_status("google"),
        }
    try:
        completed = subprocess.run(
            ["cmdkey", f"/delete:{entry}"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
        )
    except Exception as exc:  # noqa: BLE001
        raise AuthError("logout_failed", f"Signing out failed: {exc}") from exc
    output = clean(completed.stdout) or clean(completed.stderr)
    ok = completed.returncode == 0
    return {
        "ok": ok,
        "message": (
            f"Signed out: the shared Antigravity credential ({entry}) was removed from "
            "the system keyring. The Antigravity app will ask you to sign in again."
            if ok
            else output[:300] or "The stored credential could not be removed."
        ),
        "status": auth_status("google"),
    }


def logout(provider="claude", cli_path=None):
    """Sign out through the vendor's own command, then report the new state."""
    check_provider(provider)
    cli = provider_cli(provider, cli_path)
    if provider == "google":
        if not cli.get("usable"):
            raise AuthError("cli_not_found", "The Antigravity CLI was not found.")
        return _logout_google(cli)
    if not cli.get("usable"):
        raise AuthError("cli_not_found", f"The {provider} sign-in tool was not found.")
    command = [cli["path"], "auth", "logout"] if provider == "claude" else [cli["path"], "logout"]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
        )
    except Exception as exc:  # noqa: BLE001
        raise AuthError("logout_failed", f"Signing out failed: {exc}") from exc
    output = clean(completed.stdout) or clean(completed.stderr)
    return {
        "ok": completed.returncode == 0,
        "message": output[:300] or "Signed out.",
        "status": auth_status(provider, cli_path),
    }



