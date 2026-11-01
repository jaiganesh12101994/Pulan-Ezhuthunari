#!/usr/bin/env python3
"""
The Claude subscription sidecar.

``server.ts`` starts this process the way it already starts
``backend/tamil_ocr_engine.py``, but keeps it alive and talks newline-delimited
JSON in both directions, one object per line:

    -> {"id": "1", "op": "ask", "prompt": "...", "context": {...}}
    <- {"id": "1", "event": "text_delta", "text": "..."}
    <- {"id": "1", "event": "result", "status": "ok", "turns": 3}
    <- {"id": "1", "event": "done", "ok": true}

Operations: ``status``, ``sign-in``, ``ask``, ``vision``, ``new-conversation``,
``interrupt`` and ``shutdown``. ``stdout`` carries protocol frames only; anything
else goes to ``stderr``.

The asyncio loop owns the main thread and ``stdin`` is read on a worker thread, so
the loop is never blocked and there is one ``claude`` process per conversation.
Requests are handled as separate tasks, so ``interrupt`` is answered while an
``ask`` is still streaming.

Run it on its own for a sign-in check:

    python backend/agent/sidecar.py --check-signin
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import queue
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import environment  # noqa: E402
from auth import AuthError, LoginSession, auth_status, install_tool  # noqa: E402
from auth import logout as auth_logout  # noqa: E402
from subscription_backend import BackendError, SubscriptionBackend  # noqa: E402


def write_frame(payload, stream=None):
    """One JSON object per line, flushed at once, never interleaved."""
    target = stream if stream is not None else sys.stdout
    target.write(json.dumps(payload, ensure_ascii=False) + "\n")
    target.flush()


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Claude subscription sidecar for Pulan Ezhuthunari"
    )
    parser.add_argument("--check-signin", action="store_true", dest="check_signin",
                        help="run the sign-in check, print the report and exit")
    parser.add_argument("--cli", default=None, help="path to the claude executable")
    parser.add_argument("--model", default=None, help="model id, for example sonnet")
    parser.add_argument("--max-turns", type=int, default=8, dest="max_turns",
                        help="maximum turns per answer")
    parser.add_argument("--timeout", type=float, default=180.0,
                        help="seconds allowed for one page read")
    return parser.parse_args(argv)


class Sidecar:
    """Request handling: one frame per event, one id per request."""

    def __init__(self, backend, stream=None, timeout=180.0):
        self.backend = backend
        self.stream = stream if stream is not None else sys.stdout
        self.timeout = float(timeout)
        self.lock = asyncio.Lock()
        self.request_id = None
        # One sign-in at a time, held while the vendor's login command waits for a code.
        self.login = None

    def write(self, payload):
        write_frame(payload, self.stream)

    def emit(self, event, payload=None):
        """Called by the backend as it streams."""
        frame = {"event": event}
        if self.request_id is not None:
            frame["id"] = self.request_id
        if isinstance(payload, dict):
            frame.update(payload)
        elif payload is not None:
            frame["value"] = payload
        self.write(frame)

    async def _apply_overrides(self, request):
        """
        Honour the CLI path and the model the UI is set to.

        A running conversation keeps the CLI process it started with, so a changed CLI
        path restarts the conversation rather than being silently ignored.
        """
        cli = str(request.get("cli") or "").strip()
        if cli and cli != (self.backend.cli_path or ""):
            self.backend.cli_path = cli
            if self.backend.session_open:
                await self.backend.new_conversation()
                self.write(
                    {
                        "event": "info",
                        "message": "The CLI path changed, so the conversation was restarted.",
                    }
                )
        model = str(request.get("model") or "").strip()
        if model:
            self.backend.model = model

    # -- subscription sign-in ---------------------------------------------
    async def _start_login(self, request):
        """
        Begin a sign-in and hand the authorization URL back to the panel. Only one
        sign-in runs at a time, and the vendor's command waits for the code the user
        pastes — the app never sees a token.
        """
        await self._cancel_login(None)
        self.login = LoginSession(
            provider=str(request.get("provider") or "claude"),
            cli_path=request.get("cli"),
            email=request.get("email"),
        )
        return await asyncio.to_thread(self.login.start)

    async def _submit_login_code(self, request, request_id):
        session, self.login = self.login, None
        if session is None:
            self.write(
                {
                    "id": request_id,
                    "event": "error",
                    "code": "login_not_running",
                    "message": "The sign-in is no longer running. Start it again.",
                }
            )
            return
        result = await asyncio.to_thread(session.submit_code, request.get("code"))
        # The new credential has to be picked up by a fresh conversation.
        await self.backend.new_conversation()
        report = await asyncio.to_thread(auth_status, session.provider, session.cli_path)
        self.write(
            {"id": request_id, "event": "login", "state": "done", **result, "status": report}
        )

    async def _login_state(self, request):
        """
        How a sign-in in progress stands. The panel polls this, because the browser flow
        can complete the sign-in without the user ever pasting a code.
        """
        if self.login is not None:
            return await asyncio.to_thread(self.login.outcome)
        provider = str(request.get("provider") or "claude")
        return {
            "outcome": "none",
            "status": await asyncio.to_thread(auth_status, provider, request.get("cli")),
        }

    async def _cancel_login(self, request_id=None):
        """
        Drop a sign-in that is still waiting for a code. Reports whether there was
        anything to cancel, so a caller cannot be told "cancelled" when nothing was.
        """
        session, self.login = self.login, None
        cancelled = False
        if session is not None:
            await asyncio.to_thread(session.cancel)
            cancelled = True
        if request_id is not None:
            self.write(
                {"id": request_id, "event": "done", "ok": True, "cancelled": cancelled}
            )
        return cancelled

    async def _logout(self, request, request_id):
        provider = str(request.get("provider") or "claude")
        result = await asyncio.to_thread(auth_logout, provider, request.get("cli"))
        await self.backend.new_conversation()
        self.write({"id": request_id, "event": "logout", "state": "done", **result})

    async def close(self):
        """Drop anything still waiting, so nothing is left running at exit."""
        await self._cancel_login(None)

    async def handle(self, request):
        """Answer one request. Never raises: a failure becomes an error frame."""
        op = str(request.get("op") or "")
        request_id = request.get("id")
        try:
            await self._apply_overrides(request)
            if op == "status":
                self.write({"id": request_id, "event": "status", **self.backend.status()})
            elif op in ("sign-in", "signin", "check-signin"):
                report = await self.backend.sign_in_check(
                    timeout=float(request.get("timeout") or 90)
                )
                self.write({"id": request_id, "event": "sign-in", **report})
            elif op == "auth-status":
                report = await asyncio.to_thread(
                    auth_status,
                    str(request.get("provider") or "claude"),
                    request.get("cli"),
                )
                self.write({"id": request_id, "event": "auth-status", **report})
            elif op == "login-start":
                info = await self._start_login(request)
                # Claude Code can finish the sign-in by itself, so ask before assuming a
                # code is still needed.
                outcome = (
                    await asyncio.to_thread(self.login.outcome) if self.login else {}
                )
                if outcome.get("outcome") == "signed_in":
                    self.login = None
                    await self.backend.new_conversation()
                    self.write(
                        {
                            "id": request_id,
                            "event": "login",
                            "state": "done",
                            "url": info.get("url"),
                            **outcome,
                        }
                    )
                else:
                    self.write(
                        {"id": request_id, "event": "login", "state": "awaiting-code", **info}
                    )
            elif op == "login-state":
                self.write(
                    {
                        "id": request_id,
                        "event": "login-state",
                        **await self._login_state(request),
                    }
                )
            elif op == "install-cli":
                # The one place this app installs software, and only when asked for.
                result = await asyncio.to_thread(
                    install_tool, str(request.get("provider") or "claude")
                )
                self.write({"id": request_id, "event": "install", **result})
            elif op == "login-code":
                await self._submit_login_code(request, request_id)
            elif op == "login-cancel":
                await self._cancel_login(request_id)
            elif op == "logout":
                await self._logout(request, request_id)
            elif op == "new-conversation":
                await self.backend.new_conversation()
                self.write({"id": request_id, "event": "done", "ok": True})
            elif op == "interrupt":
                stopped = await self.backend.interrupt()
                self.write(
                    {"id": request_id, "event": "done", "ok": True, "interrupted": stopped}
                )
            elif op in ("ask", "vision"):
                await self._answer(op, request, request_id)
            else:
                self.write(
                    {
                        "id": request_id,
                        "event": "error",
                        "code": "unknown_op",
                        "message": f"Unknown operation {op!r}.",
                    }
                )
        except (BackendError, AuthError) as exc:
            # A failure the panel can explain, in the shared code vocabulary.
            self.write(
                {"id": request_id, "event": "error", "code": exc.code, "message": exc.message}
            )
        except Exception as exc:  # noqa: BLE001 - the frame is the error channel
            self.write(
                {
                    "id": request_id,
                    "event": "error",
                    "code": "sidecar_error",
                    "message": f"{exc.__class__.__name__}: {exc}",
                }
            )

    async def _answer(self, op, request, request_id):
        """One question at a time; ``interrupt`` is handled outside this lock."""
        async with self.lock:
            self.request_id = request_id
            try:
                if op == "ask":
                    result = await self.backend.ask(
                        request.get("prompt") or "",
                        context=request.get("context"),
                        model=request.get("model"),
                        max_turns=request.get("maxTurns"),
                    )
                    self.write({"id": request_id, "event": "done", **result})
                else:
                    text = await self.backend.one_shot(
                        request.get("prompt") or "",
                        tool_names=request.get("tools"),
                        max_turns=int(request.get("maxTurns") or 4),
                        model=request.get("model"),
                        system_prompt=request.get("systemPrompt"),
                        timeout=float(request.get("timeout") or self.timeout),
                        # The tools need the page description, or the model cannot fetch
                        # the image it was asked about.
                        context=request.get("context"),
                    )
                    self.write({"id": request_id, "event": "done", "ok": True, "text": text})
            finally:
                self.request_id = None


async def main(argv=None):
    args = parse_args(argv)
    # Authentication: remove the credential and routing variables before the SDK can
    # hand them to the CLI, so the subscription is billed rather than the API.
    removed = environment.apply_environment_sanitisation()
    backend = SubscriptionBackend(
        cli_path=args.cli, model=args.model, max_turns=args.max_turns
    )
    sidecar = Sidecar(backend, timeout=args.timeout)
    backend.emit = sidecar.emit

    if args.check_signin:
        report = await backend.sign_in_check()
        report["environmentRemoved"] = removed
        json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        sys.stdout.flush()
        return 0 if report.get("signedIn") else 1

    if removed:
        sidecar.write(
            {
                "event": "info",
                "message": "Removed from the CLI environment: " + ", ".join(removed),
            }
        )

    requests = queue.Queue()

    def reader():
        try:
            for line in sys.stdin:
                requests.put(line)
        finally:
            requests.put(None)

    threading.Thread(target=reader, daemon=True).start()

    tasks = set()
    while True:
        line = await asyncio.to_thread(requests.get)
        if line is None:
            break
        text = line.strip().lstrip("\ufeff")
        if not text:
            continue
        try:
            request = json.loads(text)
        except ValueError:
            sidecar.write(
                {"event": "error", "code": "bad_json", "message": "That line was not JSON."}
            )
            continue
        if str(request.get("op") or "") == "shutdown":
            break
        task = asyncio.create_task(sidecar.handle(request))
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    for task in list(tasks):
        task.cancel()
    await sidecar.close()
    await backend.stop()
    return 0


def run(argv=None):
    """Set up the streams, then run the loop. Returns the exit status."""
    for stream, kwargs in (
        (sys.stdin, {"encoding": "utf-8"}),
        (sys.stdout, {"encoding": "utf-8", "newline": "\n"}),
    ):
        try:
            stream.reconfigure(**kwargs)
        except Exception:
            pass
    return asyncio.run(main(argv))


if __name__ == "__main__":
    sys.exit(run())

