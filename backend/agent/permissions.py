#!/usr/bin/env python3
"""
Tool lock-down for the Claude subscription backend.

The Agent SDK can hand Claude Code's built-in tools to the model: file access,
shell, web, task management and more. This app exposes only its own OCR tools, so
the lock-down uses every mechanism the installed SDK offers, in layers:

1. ``ClaudeAgentOptions.tools = []`` -- the SDK passes ``--tools ""``, so no
   built-in tool is offered to the model at all.
2. ``ClaudeAgentOptions.disallowed_tools`` -- an explicit deny list, in case a
   later CLI offers a tool that ``--tools ""`` does not cover.
3. ``ClaudeAgentOptions.setting_sources = []`` with ``strict_mcp_config = True``
   -- no user/project settings, no ``CLAUDE.md``, no hooks, no plugins and no MCP
   servers discovered from the filesystem.
4. ``can_use_tool`` -- a permission callback that allows only
   ``mcp__<server>__*`` names and refuses everything else, recording each refusal
   so the panel and the tests can show what was attempted.

``cwd`` is an empty application-data folder (see :func:`environment.agent_workdir`),
so even a tool that slipped through would have nothing to read.
"""

from __future__ import annotations

import time

SERVER_NAME = "pulan_ocr"

#: Every tool this app exposes is namespaced by the SDK's MCP server name.
ALLOWED_PREFIX = f"mcp__{SERVER_NAME}__"

#: Claude Code's built-in tools at the tested CLI version (2.1.314). They are
#: already removed from the model's toolset by ``tools = []``; this list is the
#: explicit second layer, and it is deliberately generous so a newly added
#: built-in is still covered by name.
BUILT_IN_TOOLS = (
    "Bash",
    "BashOutput",
    "KillShell",
    "KillBash",
    "Read",
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "Glob",
    "Grep",
    "LS",
    "WebFetch",
    "WebSearch",
    "Task",
    "Agent",
    "TodoWrite",
    "SlashCommand",
    "Skill",
    "ExitPlanMode",
    "NotebookRead",
    "Computer",
    "TextEditor",
    "StructuredOutput",
)


def is_allowed(tool_name):
    """Only the app's own OCR tools are allowed, and nothing else."""
    return isinstance(tool_name, str) and tool_name.startswith(ALLOWED_PREFIX)


class PermissionGate:
    """
    A ``can_use_tool`` callback that refuses anything outside the OCR allow-list.

    Refusals are recorded (name, time, and the keys the model sent -- never the
    values, which may contain document text) so that a refusal can be shown to the
    user and asserted in tests.
    """

    def __init__(self, allowed_prefix=ALLOWED_PREFIX, max_records=50):
        self.allowed_prefix = allowed_prefix
        self.max_records = max_records
        self._denials = []
        self._allowed = 0

    def check(self, tool_name):
        """``(allowed, refusal_message)`` for a tool name."""
        if is_allowed(tool_name):
            return True, None
        return (
            False,
            f"The tool {tool_name!r} is not available. This app exposes only its own "
            "read-only OCR tools; file, shell and web access are refused.",
        )

    def _record(self, tool_name, tool_input):
        self._denials.append(
            {
                "tool": str(tool_name),
                "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "argumentKeys": sorted((tool_input or {}).keys())[:20],
            }
        )
        del self._denials[: max(0, len(self._denials) - self.max_records)]

    def denials(self):
        return list(self._denials)

    def summary(self):
        return {
            "allowedPrefix": self.allowed_prefix,
            "allowedCalls": self._allowed,
            "deniedCalls": len(self._denials),
            "denials": self.denials(),
        }

    async def __call__(self, tool_name, tool_input, context=None):
        """
        The SDK's ``can_use_tool`` hook. Returns an allow/deny result and never
        raises, so a refusal can never kill the session.
        """
        from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny

        allowed, message = self.check(tool_name)
        if allowed:
            self._allowed += 1
            return PermissionResultAllow(behavior="allow")
        self._record(tool_name, tool_input)
        return PermissionResultDeny(behavior="deny", message=message)
