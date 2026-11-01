#!/usr/bin/env python3
"""
Claude subscription backend for Pulan Ezhuthunari.

This package drives the official Claude Agent SDK (`claude_agent_sdk`), which in
turn drives the Claude Code CLI. The CLI is signed in to a Claude Pro/Max
subscription, so no API key is involved: `ANTHROPIC_API_KEY` and
`ANTHROPIC_AUTH_TOKEN` are stripped from the environment handed to the CLI, so a
subscription is billed rather than the API.

The backend runs as a small sidecar process, spawned by `server.ts` the same way
`backend/tamil_ocr_engine.py` already is, and speaks newline-delimited JSON over
stdio. It re-exposes the app's OCR tools to Claude through the SDK's in-process
MCP server and nothing else: every built-in Claude Code tool is removed, and any
tool outside the OCR allow-list is refused by a permission callback.

Intended for single-user, personal use on one machine with the owner's own
subscription. There is deliberately no way for anybody else to sign in to their
Claude account through this app.
"""

__all__ = [
    "environment",
    "ocr_tools",
    "permissions",
    "prompts",
    "subscription_backend",
]
