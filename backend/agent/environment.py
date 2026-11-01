#!/usr/bin/env python3
"""
Environment, CLI and work-directory handling for the Claude subscription backend.

Why this module exists
----------------------
The Claude Code CLI bills whichever credential it finds, and an
`ANTHROPIC_API_KEY` in the environment beats the subscription sign-in. The Agent
SDK builds the CLI's environment as `{**os.environ, **options.env}` at connect
time, so the API-key variables are removed from *this* process before the SDK is
used, and empty values are also passed through `ClaudeAgentOptions.env` as a
second line of defence. `ANTHROPIC_BASE_URL` is removed with them, because it
would route subscription traffic to a gateway.

The CLI's credential files (`~/.claude/...`) and any OAuth tokens are never read,
copied, logged or stored by this module. Sign-in happens once, outside the app,
with `claude`.
"""

from __future__ import annotations

import importlib.metadata
import os
import platform
import shutil

#: Credential variables that must not reach the CLI, or it bills the API instead
#: of the subscription.
API_KEY_VARS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")

#: Routing variable removed with them, so subscription traffic is not sent to a
#: gateway that the API-key path may be configured for.
ROUTING_VARS = ("ANTHROPIC_BASE_URL",)

#: The Agent SDK refuses to execute .bat/.cmd shims on Windows (CreateProcess
#: cannot run them), and npm's global install is exactly such a shim.
WINDOWS_BATCH_SUFFIXES = (".cmd", ".bat")

CLI_PATH_ENV = "PULAN_CLAUDE_CLI"
WORKDIR_ENV = "PULAN_AGENT_WORKDIR"


def sdk_version():
    """Version of the installed `claude-agent-sdk`, or None when absent."""
    try:
        return importlib.metadata.version("claude-agent-sdk")
    except Exception:
        return None


def sdk_available():
    try:
        import claude_agent_sdk  # noqa: F401

        return True
    except Exception:
        return False


def bundled_cli_version():
    """Version of the Claude Code CLI bundled in the SDK wheel, if any."""
    try:
        from claude_agent_sdk._cli_version import __cli_version__

        return __cli_version__
    except Exception:
        return None


def bundled_cli_path():
    """Path of the `claude` executable shipped inside the SDK wheel, if any."""
    try:
        import claude_agent_sdk
    except Exception:
        return None
    package_dir = os.path.dirname(os.path.abspath(claude_agent_sdk.__file__))
    name = "claude.exe" if platform.system() == "Windows" else "claude"
    candidate = os.path.join(package_dir, "_bundled", name)
    return candidate if os.path.isfile(candidate) else None


def _is_windows_batch(path):
    return platform.system() == "Windows" and path.lower().endswith(WINDOWS_BATCH_SUFFIXES)


def _common_locations():
    home = os.path.expanduser("~")
    if platform.system() == "Windows":
        local = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
        return [
            os.path.join(home, ".local", "bin", "claude.exe"),
            os.path.join(home, ".claude", "local", "claude.exe"),
            os.path.join(local, "Programs", "claude", "claude.exe"),
        ]
    return [
        os.path.join(home, ".claude", "local", "claude"),
        os.path.join(home, ".local", "bin", "claude"),
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
    ]


def _verdict(path, source):
    exists = os.path.isfile(path)
    usable = exists and not _is_windows_batch(path)
    return {"path": path, "source": source, "found": exists, "usable": usable, "reason": None}


def resolve_cli(explicit=None):
    """
    Decide which `claude` executable the SDK should run.

    Order: the path configured in Settings, then `PULAN_CLAUDE_CLI`, then the CLI
    bundled in the SDK wheel, then PATH, then the usual install locations. The
    bundled CLI comes before PATH because it is the one the SDK would choose
    itself, and it is the only one guaranteed to run on Windows.
    """
    if explicit:
        return _verdict(str(explicit), "configured")
    if os.environ.get(CLI_PATH_ENV):
        return _verdict(os.environ[CLI_PATH_ENV], "environment")

    bundled = bundled_cli_path()
    if bundled:
        return _verdict(bundled, "bundled")

    windows = platform.system() == "Windows"
    found = shutil.which("claude.exe") if windows else shutil.which("claude")
    if not found and windows:
        found = shutil.which("claude")
    if found and not _is_windows_batch(found):
        return _verdict(found, "path")

    for candidate in _common_locations():
        if os.path.isfile(candidate):
            return _verdict(candidate, "common")

    if found:  # a Windows .cmd/.bat shim: present, but the SDK will refuse it
        verdict = _verdict(found, "path")
        verdict["usable"] = False
        verdict["reason"] = (
            "This is an npm batch shim (.cmd), which the Claude Agent SDK refuses to run on "
            "Windows. Install the native claude.exe, or keep the CLI bundled with the SDK."
        )
        return verdict

    return {"path": None, "source": "none", "found": False, "usable": False, "reason": None}


def strip_api_keys(environ=None):
    """
    Return `(cleaned_environment, removed_names)` with the credential and routing
    variables taken out. Names only are ever reported, never values.
    """
    source = dict(os.environ if environ is None else environ)
    removed = []
    for name in API_KEY_VARS + ROUTING_VARS:
        if source.pop(name, None) is not None:
            removed.append(name)
    return source, removed


def apply_environment_sanitisation():
    """
    Remove the credential and routing variables from this process, so the SDK
    cannot inherit them. Returns the names that were removed.
    """
    removed = []
    for name in API_KEY_VARS + ROUTING_VARS:
        if os.environ.pop(name, None) is not None:
            removed.append(name)
    return removed


def agent_workdir():
    """
    An empty application-data folder to run the CLI in, never the project
    directory and never the user's home directory.
    """
    home = os.path.abspath(os.path.expanduser("~"))
    here = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.abspath(os.path.join(here, "..", ".."))
    override = os.environ.get(WORKDIR_ENV)
    if override:
        workdir = os.path.abspath(override)
        if workdir in (home, project_root):
            raise ValueError(
                f"{WORKDIR_ENV} must not be the home or project directory; refusing {workdir!r}."
            )
    elif platform.system() == "Windows":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
        workdir = os.path.join(base, "PulanEzhuthunari", "agent-workdir")
    else:
        base = os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share")
        workdir = os.path.join(base, "pulan-ezhuthunari", "agent-workdir")
    os.makedirs(workdir, exist_ok=True)
    return workdir


def environment_report(explicit_cli=None):
    """Facts for the Settings panel. Never includes a secret."""
    return {
        "python": platform.python_version(),
        "platform": platform.system(),
        "sdkInstalled": sdk_available(),
        "sdkVersion": sdk_version(),
        "bundledCli": bundled_cli_path(),
        "bundledCliVersion": bundled_cli_version(),
        "cli": resolve_cli(explicit_cli),
        "workdir": agent_workdir(),
    }
