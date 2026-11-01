#!/usr/bin/env python3
"""
The Claude subscription backend: one persistent Agent SDK client per conversation.

The Agent SDK is asynchronous, and the sidecar is its own process, so the asyncio
loop owns the sidecar's main thread while stdin is read on a worker thread. Work
is handed to the loop with ``run_coroutine_threadsafe``, so no caller ever blocks
the loop, and there is exactly one `claude` process per conversation.

This module owns the transport only. The tools come from :mod:`ocr_tools`, the
lock-down from :mod:`permissions`, the environment from :mod:`environment`, and the
prompt from :mod:`prompts`.
"""

from __future__ import annotations

import asyncio
import json
import os
import time

import environment
from environment import API_KEY_VARS, ROUTING_VARS, agent_workdir, resolve_cli
from ocr_tools import TOOL_NAMES, OcrToolContext, ToolBinder, build_tools
from permissions import BUILT_IN_TOOLS, PermissionGate, SERVER_NAME
from prompts import IMAGE_TOOL_INSTRUCTION, SYSTEM_PROMPT, VISION_SYSTEM_PROMPT

#: Guidance shown for each failure the CLI can produce.
CLI_NOT_FOUND_MESSAGE = (
    "The Claude Code CLI could not be started. Keep the CLI bundled with the "
    "claude-agent-sdk package, or install Claude Code and set its path in Settings."
)
NOT_SIGNED_IN_MESSAGE = (
    "Claude Code is not signed in. Open a terminal, run `claude`, and sign in with your "
    "Claude account. This app never reads, copies or stores your credentials."
)
NOT_INSTALLED_MESSAGE = (
    "The claude-agent-sdk package is not installed in the Python environment this app "
    "uses. Install it with `pip install claude-agent-sdk`."
)
PROTOCOL_MESSAGE = (
    "Claude Code sent a response this app could not read. Updating the claude-agent-sdk "
    "package usually fixes this."
)
IMAGE_TOO_LARGE_MESSAGE = (
    "The page image was too large for Claude Code to accept in one message. Lower the PDF "
    "render DPI, or ask for one region at a time with get_line_image."
)

#: The Agent SDK caps one JSON message from the CLI at 1 MB by default, which a page
#: image passed through a tool will exceed. The image is capped separately (see
#: `ocr_tools.DEFAULT_MAX_IMAGE_EDGE`), so this is the safety net rather than the plan.
MAX_BUFFER_BYTES = int(os.environ.get("PULAN_AGENT_MAX_BUFFER") or 64 * 1024 * 1024)


def _mentions(text, needles):
    return any(needle in text for needle in needles)


def content_text(value):
    """Flatten a tool result's content into plain text, whatever shape it arrived in."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, dict):
                parts.append(str(item.get("text") or item.get("type") or ""))
            else:
                parts.append(str(item))
        return " ".join(part for part in parts if part)
    return "" if value is None else str(value)


def format_reset(value):
    """A readable form of a rate-limit reset time, whatever shape it arrives in."""
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        try:
            return time.strftime("%Y-%m-%d %H:%M", time.localtime(float(value)))
        except (OSError, ValueError, OverflowError):
            return str(value)
    return str(value)


def classify_error(exc, rate_limit=None):
    """
    Map anything the SDK or the CLI throws onto a code and a panel message, so the
    user is told what to do rather than shown a traceback.
    """
    text = str(exc) or exc.__class__.__name__
    lowered = text.lower()
    reset = format_reset((rate_limit or {}).get("resets_at"))

    if _mentions(
        lowered,
        ("claude code not found", "no such file", "cannot find the file", "winerror 2"),
    ):
        return "cli_not_found", CLI_NOT_FOUND_MESSAGE
    if _mentions(
        lowered,
        ("not logged in", "please run `claude", "run claude login", "/login", "unauthorized",
         "authenticate", "oauth", "session expired", "could not be refreshed", "invalid_grant",
         "invalid api key", "invalid x-api-key", "401"),
    ):
        return "not_signed_in", NOT_SIGNED_IN_MESSAGE
    if _mentions(lowered, ("exceeded maximum buffer size", "maximum buffer size")):
        return "image_too_large", IMAGE_TOO_LARGE_MESSAGE
    if _mentions(lowered, ("usage limit", "rate limit", "quota", "429", "too many requests")):
        message = (
            "Your Claude subscription limit has been reached, so Claude Code stopped this "
            "request. Nothing was charged to an API key."
        )
        if reset:
            message += f" The limit is reported to reset at {reset}."
        message += (
            " The same limits cover the Claude apps, Claude Code and this app, so you can "
            "carry on with the offline engines in the meantime."
        )
        return "usage_limit", message
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)) or "timed out" in lowered:
        return "timeout", (
            "Claude Code did not answer in time. Try again, or ask about a single region "
            "instead of a whole page."
        )

    try:
        from claude_agent_sdk import (
            CLIConnectionError,
            CLIJSONDecodeError,
            CLINotFoundError,
            ProcessError,
            ResultError,
        )
    except Exception:  # the SDK is missing: the message above is the useful one
        return "sdk_missing", NOT_INSTALLED_MESSAGE

    if isinstance(exc, CLINotFoundError):
        return "cli_not_found", CLI_NOT_FOUND_MESSAGE
    if isinstance(exc, ProcessError):
        code = getattr(exc, "exit_code", None)
        return "process_crashed", (
            f"The Claude Code process stopped unexpectedly (exit code {code}). Try again, "
            "or start a new conversation."
        )
    if isinstance(exc, CLIJSONDecodeError):
        return "protocol", PROTOCOL_MESSAGE
    if isinstance(exc, ResultError):
        return "result_error", f"Claude Code reported a failed result: {text}"
    if isinstance(exc, CLIConnectionError):
        return "cli_connection", f"Claude Code could not be reached: {text}"
    return "unknown", f"The Claude subscription backend reported: {text}"


class SubscriptionBackend:
    """
    One conversation with Claude through the Claude Code CLI.

    ``emit(event, payload)`` is called as the SDK streams, so the sidecar can
    forward events without knowing anything about the SDK's own types.
    """

    def __init__(self, cli_path=None, model=None, max_turns=8, system_prompt=None, emit=None):
        self.cli_path = cli_path
        self.model = model
        self.max_turns = int(max_turns or 8)
        self.system_prompt = system_prompt or SYSTEM_PROMPT
        self.gate = PermissionGate()
        self.binder = ToolBinder()
        self.emit = emit or (lambda event, payload=None: None)
        self.session = {}
        self._client = None
        self._stderr = []
        self._saw_delta = False
        self._session_model = None
        self.rate_limit = {}
        self.run_errors = []

    # -- options ----------------------------------------------------------
    def sdk_env(self):
        """
        Second line of defence for authentication: the SDK merges these over
        ``os.environ`` when it starts the CLI, and an empty value cannot be billed.
        The variables are also removed from this process entirely (see
        :func:`environment.apply_environment_sanitisation`).
        """
        return {name: "" for name in API_KEY_VARS + ROUTING_VARS}

    def _system_prompt_option(self):
        """
        The prompt *replaces* Claude Code's default coding prompt. It is passed as a
        file because the string form travels on the CLI command line, which Windows
        caps at roughly 32 KB.
        """
        try:
            path = os.path.join(agent_workdir(), "system-prompt.txt")
            with open(path, "w", encoding="utf-8") as stream:
                stream.write(self.system_prompt)
            return {"type": "file", "path": path}
        except Exception:
            return self.system_prompt

    def _on_stderr(self, line):
        """Keep the CLI's own diagnostics, bounded, for error reporting."""
        text = str(line).rstrip()
        if not text:
            return
        self._stderr.append(text)
        del self._stderr[: max(0, len(self._stderr) - 100)]

    def stderr_tail(self, lines=6):
        return "\n".join(self._stderr[-lines:])

    def mcp_servers(self, tool_names=None):
        """An in-process MCP server holding only the OCR tools."""
        from claude_agent_sdk import create_sdk_mcp_server

        return {SERVER_NAME: create_sdk_mcp_server(SERVER_NAME, tools=build_tools(self.binder))}

    def allowed_tool_names(self, names=None):
        return [f"mcp__{SERVER_NAME}__{name}" for name in (names or TOOL_NAMES)]

    def build_options(
        self,
        mcp_servers=None,
        allowed_tools=None,
        max_turns=None,
        model=None,
        system_prompt=None,
        include_partial_messages=True,
    ):
        """Every lock-down option the installed SDK offers, in one place."""
        from claude_agent_sdk import ClaudeAgentOptions

        options = {
            # An empty application-data folder, never the project or the home folder.
            "cwd": agent_workdir(),
            # No user/project settings, no CLAUDE.md, no hooks, no plugins, and no MCP
            # servers discovered from the filesystem.
            "setting_sources": [],
            "strict_mcp_config": True,
            # No built-in Claude Code tool is offered to the model at all.
            "tools": [],
            # An explicit deny list as the second layer, in case a later CLI offers a
            # tool that an empty tool set does not cover.
            "disallowed_tools": list(BUILT_IN_TOOLS),
            "system_prompt": system_prompt or self._system_prompt_option(),
            "max_turns": int(max_turns or self.max_turns),
            "permission_mode": "default",
            "can_use_tool": self.gate,
            "env": self.sdk_env(),
            "include_partial_messages": bool(include_partial_messages),
            "stderr": self._on_stderr,
            # The SDK caps one CLI JSON message at 1 MB, which a page image passed
            # through a tool exceeds; the image is capped too, but this is the safety net.
            "max_buffer_size": MAX_BUFFER_BYTES,
        }
        cli = resolve_cli(self.cli_path)
        if cli.get("usable"):
            options["cli_path"] = cli["path"]
        chosen_model = model or self.model
        if chosen_model:
            options["model"] = chosen_model
        if mcp_servers:
            options["mcp_servers"] = mcp_servers
        if allowed_tools is not None:
            options["allowed_tools"] = list(allowed_tools)
        return ClaudeAgentOptions(**options)

    # -- message mapping --------------------------------------------------
    def _emit_tool_call(self, block):
        name = str(getattr(block, "name", "") or "")
        short = name.split("__")[-1] if name.startswith("mcp__") else name
        args = getattr(block, "input", None) or {}
        summary = ", ".join(
            f"{key}={str(value)[:60]}" for key, value in list(args.items())[:4]
        )
        self.emit("tool_call", {"name": short, "fullName": name, "summary": summary})

    def _emit_stream_event(self, stream_event):
        event = getattr(stream_event, "event", None) or {}
        kind = event.get("type")
        if kind == "message_start":
            # Track streaming per assistant message, so a turn whose text did not
            # stream is still posted in full.
            self._saw_delta = False
        elif kind == "content_block_delta":
            delta = event.get("delta") or {}
            if delta.get("type") == "text_delta" and delta.get("text"):
                self._saw_delta = True
                self.emit("text_delta", {"text": delta["text"]})

    def _emit_assistant(self, message):
        from claude_agent_sdk import TextBlock, ToolUseBlock

        texts = []
        for block in message.content or []:
            if isinstance(block, ToolUseBlock):
                self._emit_tool_call(block)
            elif isinstance(block, TextBlock):
                texts.append(block.text)
        if texts and not self._saw_delta:
            self.emit("text_delta", {"text": "".join(texts)})

    def _emit_system(self, message):
        data = message.data or {}
        if data.get("subtype") != "init":
            return
        servers = data.get("mcp_servers") or []
        self.session = {
            "model": data.get("model"),
            "cliVersion": data.get("claude_code_version"),
            "credential": data.get("apiKeySource"),
            "tools": list(data.get("tools") or []),
            "mcpServers": [
                item.get("name") if isinstance(item, dict) else str(item) for item in servers
            ],
            "permissionMode": data.get("permissionMode"),
            "cwd": data.get("cwd"),
        }
        self.emit("session", self.session)

    def _emit_result(self, message):
        self.emit(
            "result",
            {
                "status": "error" if message.is_error else "ok",
                "turns": message.num_turns,
                "durationMs": message.duration_ms,
                "costUsd": message.total_cost_usd,
                "usage": message.usage,
                "modelUsage": message.model_usage,
                "permissionDenials": message.permission_denials,
                "errors": message.errors,
                "result": message.result,
                "sessionId": message.session_id,
            },
        )

    def _emit_rate_limit(self, message):
        info = getattr(message, "rate_limit_info", None)
        payload = {}
        if info is not None:
            payload = {
                "status": getattr(info, "status", None),
                "type": getattr(info, "rate_limit_type", None),
                "utilization": getattr(info, "utilization", None),
                "resetsAt": format_reset(getattr(info, "resets_at", None)),
                "raw": getattr(info, "raw", None),
            }
        self.rate_limit = payload
        self.emit("rate_limit", payload)

    def emit_message(self, message):
        """Forward one SDK message as one or more sidecar events."""
        from claude_agent_sdk import (
            AssistantMessage,
            RateLimitEvent,
            ResultMessage,
            StreamEvent,
            SystemMessage,
            UserMessage,
        )

        if isinstance(message, StreamEvent):
            self._emit_stream_event(message)
        elif isinstance(message, AssistantMessage):
            if getattr(message, "error", None):
                self.emit("warning", {"message": f"Claude reported: {message.error}"})
            self._emit_assistant(message)
        elif isinstance(message, SystemMessage):
            self._emit_system(message)
        elif isinstance(message, ResultMessage):
            self._emit_result(message)
        elif isinstance(message, RateLimitEvent):
            self._emit_rate_limit(message)
        elif isinstance(message, UserMessage):
            for block in message.content or []:
                if getattr(block, "is_error", False):
                    self.emit(
                        "tool_result",
                        {"isError": True, "text": content_text(block.content)[:400]},
                    )
        return message

    # -- session lifecycle ------------------------------------------------
    def set_context(self, bundle, store=None, proposals_dir=None):
        """Point the tools at the document this request is about."""
        self.binder.context = OcrToolContext(bundle, store=store, proposals_dir=proposals_dir)
        return self.binder.context

    @property
    def session_open(self):
        """Whether a `claude` process is running for this conversation."""
        return self._client is not None

    async def start(self, model=None):
        """Open the persistent session, reusing it when it is already open."""
        if self._client is not None:
            return self._client
        from claude_agent_sdk import ClaudeSDKClient

        self._client = ClaudeSDKClient(
            self.build_options(
                mcp_servers=self.mcp_servers(),
                allowed_tools=self.allowed_tool_names(),
                model=model,
            )
        )
        await self._client.connect()
        self._session_model = model or self.model
        return self._client

    async def new_conversation(self):
        """Close the session, so the next question starts with no context."""
        await self.stop()
        self.gate = PermissionGate()
        self.session = {}

    async def interrupt(self):
        """Stop the run in flight; the session stays usable afterwards."""
        if self._client is None:
            return False
        await self._client.interrupt()
        return True

    async def stop(self):
        """Close the session cleanly, so no orphan `claude` process is left."""
        client, self._client = self._client, None
        if client is None:
            return
        try:
            await client.disconnect()
        except Exception:
            pass

    # -- running ----------------------------------------------------------
    async def _drive(self, client, prompt):
        """Send a prompt and stream the reply. Errors propagate to the caller."""
        self.run_errors = []
        await client.query(str(prompt))
        async for message in client.receive_response():
            self.emit_message(message)
            self._note_run_error(message)

    def _note_run_error(self, message):
        """Collect the failures a run reports without raising."""
        try:
            from claude_agent_sdk import AssistantMessage, ResultMessage
        except Exception:
            return
        if isinstance(message, AssistantMessage) and getattr(message, "error", None):
            self.run_errors.append(str(message.error))
        elif isinstance(message, ResultMessage):
            if message.is_error:
                self.run_errors.append(str(message.result or "the CLI reported a failed result"))
            for item in message.errors or []:
                self.run_errors.append(str(item))

    async def _discard(self, client):
        """Close a one-shot session, never raising."""
        try:
            await client.disconnect()
        except Exception:
            pass

    async def _fail(self, exc):
        """
        Report a failure in the panel's vocabulary, and drop a session that cannot
        be reused.
        """
        code, message = classify_error(exc, self.rate_limit)
        self.emit("error", {"code": code, "message": message, "detail": self.stderr_tail()})
        if code in (
            "cli_not_found",
            "process_crashed",
            "not_signed_in",
            "sdk_missing",
            "cli_connection",
        ):
            await self.stop()
        return {"ok": False, "code": code, "message": message}

    async def ask(self, prompt, context=None, model=None, max_turns=None):
        """
        Send one message on the persistent session and stream the answer as events.
        Returns a summary the sidecar passes on.
        """
        if context is not None:
            self.set_context(context)
        if max_turns and int(max_turns) != self.max_turns and self._client is not None:
            # max_turns is fixed when the CLI process starts, so a change cannot be
            # applied to a conversation already under way.
            self.emit(
                "info",
                {
                    "message": "The maximum-turn setting changed. It applies from the next "
                    "conversation onwards."
                },
            )
        try:
            client = await self.start(model=model)
        except Exception as exc:
            return await self._fail(exc)
        if model and model != self._session_model:
            try:
                await client.set_model(model)
                self._session_model = model
            except Exception:
                pass
        self._saw_delta = False
        try:
            await self._drive(client, prompt)
        except Exception as exc:
            return await self._fail(exc)
        failure = run_failure(self.run_errors, self.rate_limit)
        if failure:
            code, message = failure
            self.emit("error", {"code": code, "message": message})
            return {"ok": False, "code": code, "message": message}
        return {"ok": True, "session": self.session, "permissions": self.gate.summary()}

    async def one_shot(
        self,
        prompt,
        tool_names=None,
        max_turns=4,
        model=None,
        system_prompt=None,
        timeout=180,
        context=None,
    ):
        """
        One question in a session of its own, for the vision calls that read a single
        page or region. The image reaches the model through an MCP tool, because an
        Agent SDK prompt carries text only, so the caller's prompt is prefixed with
        the instruction to fetch the image, and the context that describes the page is
        attached first. Returns the answer text.
        """
        from claude_agent_sdk import ClaudeSDKClient

        if context is not None:
            self.set_context(context)
        full_prompt = f"{IMAGE_TOOL_INSTRUCTION}\n\n{prompt}"
        collected = []
        original = self.emit

        def capture(event, payload=None):
            if event == "text_delta":
                collected.append(str((payload or {}).get("text") or ""))
            original(event, payload)

        client = ClaudeSDKClient(
            self.build_options(
                mcp_servers=self.mcp_servers(),
                allowed_tools=self.allowed_tool_names(tool_names),
                max_turns=max_turns,
                model=model,
                system_prompt=system_prompt or VISION_SYSTEM_PROMPT,
                include_partial_messages=False,
            )
        )
        self.emit = capture
        try:
            await client.connect()
            try:
                await asyncio.wait_for(self._drive(client, full_prompt), timeout)
            except (asyncio.TimeoutError, TimeoutError):
                self.emit(
                    "warning",
                    {"message": f"Claude did not finish this page within {int(timeout)}s."},
                )
        finally:
            self.emit = original
            await self._discard(client)
        failure = run_failure(self.run_errors, self.rate_limit)
        if failure:
            # The CLI answered with a failure rather than a reading of the page, which
            # must not be handed back as if it were a model answer.
            raise BackendError(*failure)
        return "".join(collected)

    # -- sign-in check ----------------------------------------------------
    async def sign_in_check(self, timeout=90):
        """
        A minimal query with no tools, which proves three things at once: the CLI
        runs, an account answers, and which credential paid for it.

        Nothing about the account is stored. The CLI's own ``apiKeySource`` label is
        the only thing read, and it is a word such as ``"none"`` or
        ``"ANTHROPIC_API_KEY"`` -- never a token.
        """
        from claude_agent_sdk import ClaudeSDKClient

        cli = resolve_cli(self.cli_path)
        report = {
            "status": "unknown",
            "signedIn": False,
            "cli": cli,
            "sdkVersion": environment.sdk_version(),
            "cliVersion": environment.bundled_cli_version(),
        }
        if not cli.get("usable"):
            report.update(
                {
                    "status": "cli_not_found",
                    "message": CLI_NOT_FOUND_MESSAGE
                    + (f" ({cli['reason']})" if cli.get("reason") else ""),
                }
            )
            return report
        client = ClaudeSDKClient(
            self.build_options(
                allowed_tools=[],
                max_turns=1,
                system_prompt="You are checking that this account is reachable. Reply with exactly: OK",
                include_partial_messages=False,
            )
        )
        text = []
        errors = []
        try:
            await asyncio.wait_for(self._run_check(client, text, errors), timeout)
        except (asyncio.TimeoutError, TimeoutError):
            report.update(
                {
                    "status": "timeout",
                    "message": "Claude Code did not answer within "
                    f"{int(timeout)}s. Check that running `claude` in a terminal works.",
                }
            )
        except Exception as exc:
            code, message = classify_error(exc, self.rate_limit)
            status = "cli_not_found" if code == "cli_not_found" else (
                "not_signed_in" if code == "not_signed_in" else "error"
            )
            report.update(
                {"status": status, "code": code, "message": message, "detail": self.stderr_tail()}
            )
        else:
            report.update(
                interpret_sign_in(
                    self.session,
                    " ".join(text),
                    errors,
                    self.rate_limit,
                    report["cliVersion"],
                )
            )
        finally:
            await self._discard(client)
        return report

    async def _run_check(self, client, text, errors):
        from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock

        await client.connect()
        await client.query("Reply with OK")
        async for message in client.receive_response():
            self.emit_message(message)
            if isinstance(message, AssistantMessage):
                if getattr(message, "error", None):
                    errors.append(str(message.error))
                for block in message.content or []:
                    if isinstance(block, TextBlock):
                        text.append(block.text)
            elif isinstance(message, ResultMessage):
                if message.is_error:
                    errors.append(str(message.result or "the CLI reported a failed result"))
                for item in message.errors or []:
                    errors.append(str(item))

    def status(self):
        """Everything Settings can show without asking Claude anything."""
        report = environment.environment_report(self.cli_path)
        report.update(
            {
                "sessionOpen": self._client is not None,
                "session": self.session,
                "model": self.model or "sonnet (default)",
                "maxTurns": self.max_turns,
                "tools": list(TOOL_NAMES),
                "permissions": self.gate.summary(),
                "rateLimit": self.rate_limit,
                "account": describe_credential(self.session.get("credential")),
            }
        )
        return report

class BackendError(RuntimeError):
    """A failure the panel can explain, carrying a code from the shared vocabulary."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def run_failure(errors, rate_limit=None):
    """
    The classified failure for a run that reported errors, or None when it reported
    none. A run can fail *without* raising: the CLI opens a session, answers with
    "authentication_failed" or a usage-limit notice, and ends with ``is_error``. That
    must not reach the caller as a model answer.
    """
    joined = " ".join(str(item) for item in (errors or []) if item).strip()
    if not joined:
        return None
    code, message = classify_error(Exception(joined), rate_limit)
    if code == "unknown":
        code = "run_failed"
        message = f"Claude Code could not complete this request: {joined[:300]}"
    return code, message


def interpret_sign_in(session, text, errors, rate_limit=None, cli_version=None):
    """
    Decide the sign-in status from what the CLI actually said.

    A session event alone is not proof of anything: the CLI opens a session and only
    then reports ``authentication_failed`` when the OAuth session has expired, which
    must never be shown as a working sign-in. The decision is a pure function so it
    can be tested without a live account.
    """
    session = session or {}
    answer = str(text or "").strip()
    problems = " ".join(str(item) for item in (errors or []) if item).strip()
    report = {
        "answer": answer[:200],
        "detail": problems[:400] or None,
        "model": session.get("model"),
        "credential": session.get("credential"),
        "account": describe_credential(session.get("credential")),
        "cliVersion": session.get("cliVersion") or cli_version,
        "tools": session.get("tools") or [],
        "mcpServers": session.get("mcpServers") or [],
    }
    if not problems and not answer:
        report.update(
            {
                "status": "error",
                "signedIn": False,
                "code": "no_answer",
                "message": "Claude Code closed the check without answering. Run `claude` in a "
                "terminal to see what it reports.",
            }
        )
        return report
    code, message = classify_error(Exception(f"{problems} {answer}".strip()), rate_limit)
    if code == "not_signed_in":
        report.update(
            {
                "status": "not_signed_in",
                "signedIn": False,
                "code": code,
                "message": NOT_SIGNED_IN_MESSAGE,
            }
        )
    elif problems:
        report.update({"status": "error", "signedIn": False, "code": code, "message": message})
    else:
        report.update(
            {
                "status": "signed_in",
                "signedIn": True,
                "message": "Claude Code answered, so the sign-in works.",
            }
        )
    return report


def describe_credential(source):
    """
    Turn the CLI's own ``apiKeySource`` label into something the panel can show.

    The CLI reports ``"none"`` for a claude.ai login, which is the subscription this
    backend exists for. Anything else means an API key is paying, which the user
    should know about rather than discover on a bill.
    """
    if source in (None, "", "none", "/login managed key"):
        return "Claude subscription (via Claude Code)"
    if source == "ANTHROPIC_API_KEY":
        return "Anthropic API key (the API is billed, not your subscription)"
    if source == "apiKeyHelper":
        return "API key from an apiKeyHelper (the API is billed, not your subscription)"
    return str(source)


__all__ = [
    "BackendError",
    "SubscriptionBackend",
    "classify_error",
    "content_text",
    "describe_credential",
    "format_reset",
    "interpret_sign_in",
    "run_failure",
]






