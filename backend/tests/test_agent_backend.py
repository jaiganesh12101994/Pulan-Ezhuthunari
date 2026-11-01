"""
Tests for the Claude subscription backend (the Claude Agent SDK).

Two clearly separated groups:

* **deterministic** tests that never start the CLI and never touch the network: the
  environment handed to the CLI, the tool lock-down, the permission callback, the
  OCR tools themselves (through the shared dispatcher), the message-to-event mapping
  and the error vocabulary.
* **live** tests, marked ``live``, which need a signed-in Claude Code CLI. They are
  deselected by default; run them with:

      python -m pytest backend/tests -m live

Run the deterministic group with:

    python -m pytest backend/tests -v
"""

import asyncio
import base64
import io
import json
import os
import subprocess
import sys

import pytest
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(HERE)
AGENT_DIR = os.path.join(BACKEND_DIR, "agent")
PROJECT_DIR = os.path.dirname(BACKEND_DIR)

for _path in (AGENT_DIR, BACKEND_DIR):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import environment  # noqa: E402
import auth  # noqa: E402
import ocr_diagnostics  # noqa: E402
import ocr_tools  # noqa: E402
import permissions  # noqa: E402
import subscription_backend as backend_module  # noqa: E402

DOCUMENT_ID = "report-abcd1234"


@pytest.fixture
def workdir(monkeypatch, tmp_path):
    """Keep the CLI work directory inside the test's temporary folder."""
    target = tmp_path / "agent-workdir"
    target.mkdir()
    monkeypatch.setenv(environment.WORKDIR_ENV, str(target))
    return target


@pytest.fixture
def page_png(tmp_path):
    """A small page image with a little ink on it."""
    image = Image.new("RGB", (200, 100), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((12, 22, 68, 48), fill="black")
    draw.rectangle((12, 62, 68, 88), fill="black")
    path = tmp_path / "page-1.png"
    image.save(path)
    return str(path)


@pytest.fixture
def store(tmp_path):
    return ocr_diagnostics.DiagnosticsStore(root=str(tmp_path / "diagnostics"))


@pytest.fixture
def bundle(page_png):
    """The description the server sends for one request."""
    return {
        "documentId": DOCUMENT_ID,
        "documentName": "report.pdf",
        "engines": ["tesseract"],
        "languages": ["tam", "eng"],
        "currentPageId": "p1",
        "selection": {"pageId": "p1", "zoneId": "z1"},
        "pages": [
            {
                "pageId": "p1",
                "pageNumber": 1,
                "width": 200,
                "height": 100,
                "renderDpi": 300,
                "imagePath": page_png,
                "zones": [
                    {
                        "id": "z1",
                        "type": "text",
                        "x": 10,
                        "y": 20,
                        "width": 60,
                        "height": 30,
                        "text": "text from the bundle",
                    },
                    {"id": "z2", "type": "text", "x": 10, "y": 60, "width": 60, "height": 30},
                ],
            }
        ],
    }


def record_attempt(store, region_id, **overrides):
    """Write one attempt the way the OCR engine does."""
    record = {
        "attempt": 0,
        "engine": "tesseract",
        "engineVersion": "5.3.0",
        "regionType": "text",
        "regionBox": {"x": 10, "y": 20, "width": 60, "height": 30},
        "pageNumber": 1,
        "pageWidth": 200,
        "pageHeight": 100,
        "renderDpi": 300,
        "confidence": 61.4,
        "rawText": "முதல் வரி",
        "normalizedText": "முதல் வரி",
        "quality": {"status": "provisional", "findings": [], "warningCodes": []},
    }
    record.update(overrides)
    return store.record_attempt(DOCUMENT_ID, "p1", region_id, record)


def context(bundle, store=None, proposals_dir=None):
    return ocr_tools.OcrToolContext(bundle, store=store, proposals_dir=proposals_dir)


def text_of(result):
    return "\n".join(
        item.get("text", "") for item in result["content"] if item.get("type") == "text"
    )


def png_size(data):
    with Image.open(io.BytesIO(data)) as image:
        return image.size


# ---------------------------------------------------------------------------
# Authentication: no API key may reach the CLI
# ---------------------------------------------------------------------------


def test_credentials_are_stripped_from_the_environment_handed_to_the_cli():
    cleaned, removed = environment.strip_api_keys(
        {
            "ANTHROPIC_API_KEY": "sk-ant-secret",
            "ANTHROPIC_AUTH_TOKEN": "token",
            "ANTHROPIC_BASE_URL": "https://gateway.example",
            "PATH": "/usr/bin",
        }
    )
    assert "ANTHROPIC_API_KEY" not in cleaned
    assert "ANTHROPIC_AUTH_TOKEN" not in cleaned
    assert "ANTHROPIC_BASE_URL" not in cleaned
    assert cleaned["PATH"] == "/usr/bin"
    assert sorted(removed) == ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]


def test_process_environment_sanitisation_removes_credentials(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-secret")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "token")
    removed = environment.apply_environment_sanitisation()
    assert "ANTHROPIC_API_KEY" in removed
    assert "ANTHROPIC_API_KEY" not in os.environ
    assert "ANTHROPIC_AUTH_TOKEN" not in os.environ


def test_the_sdk_environment_blank_outs_every_credential(workdir):
    sdk_env = backend_module.SubscriptionBackend().sdk_env()
    for name in environment.API_KEY_VARS + environment.ROUTING_VARS:
        assert sdk_env[name] == ""
    # An empty value cannot be billed; no name or value is ever logged.
    assert all(value == "" for value in sdk_env.values())


def test_work_directory_is_never_the_project_or_the_home_directory(workdir):
    resolved = os.path.abspath(environment.agent_workdir())
    assert resolved != os.path.abspath(os.path.expanduser("~"))
    assert resolved != os.path.abspath(PROJECT_DIR)
    assert os.path.isdir(resolved)


def test_work_directory_refuses_the_home_directory(monkeypatch):
    monkeypatch.setenv(environment.WORKDIR_ENV, os.path.expanduser("~"))
    with pytest.raises(ValueError):
        environment.agent_workdir()


def test_cli_resolution_prefers_a_configured_path(tmp_path):
    executable = tmp_path / "claude.exe"
    executable.write_text("stub", encoding="utf-8")
    verdict = environment.resolve_cli(str(executable))
    assert verdict["source"] == "configured"
    assert verdict["usable"] is True


def test_cli_resolution_reports_a_missing_configured_path(tmp_path):
    verdict = environment.resolve_cli(str(tmp_path / "absent" / "claude.exe"))
    assert verdict["found"] is False
    assert verdict["usable"] is False


def test_the_wheel_bundles_the_cli(workdir):
    """The Agent SDK ships the CLI, which is why PATH detection is only a fallback."""
    if not environment.sdk_available():
        pytest.skip("claude-agent-sdk is not installed")
    bundled = environment.bundled_cli_path()
    if not bundled:
        pytest.skip("this platform's wheel does not bundle the CLI")
    assert os.path.isfile(bundled)
    assert environment.bundled_cli_version()


def test_account_type_is_reported_from_the_credential_label():
    assert "subscription" in backend_module.describe_credential("none").lower()
    assert "subscription" in backend_module.describe_credential(None).lower()
    assert "API key" in backend_module.describe_credential("ANTHROPIC_API_KEY")


# ---------------------------------------------------------------------------
# Tool lock-down
# ---------------------------------------------------------------------------


def test_permission_gate_allows_only_the_ocr_tools():
    gate = permissions.PermissionGate()
    allowed, _ = gate.check("mcp__pulan_ocr__get_page_text")
    assert allowed is True
    for name in ("Read", "Write", "Bash", "Glob", "WebFetch", "mcp__other_server__read"):
        allowed, message = gate.check(name)
        assert allowed is False, name
        assert "not available" in message


def test_permission_callback_denies_and_records_a_built_in_tool():
    gate = permissions.PermissionGate()
    result = asyncio.run(gate("Bash", {"command": "dir"}, None))
    assert result.behavior == "deny"
    summary = gate.summary()
    assert summary["deniedCalls"] == 1
    assert summary["denials"][0]["tool"] == "Bash"
    # Only the argument names are kept, never the values.
    assert summary["denials"][0]["argumentKeys"] == ["command"]


def test_permission_callback_allows_an_ocr_tool():
    gate = permissions.PermissionGate()
    result = asyncio.run(gate("mcp__pulan_ocr__get_page_image", {"pageId": "p1"}, None))
    assert result.behavior == "allow"
    assert gate.summary()["allowedCalls"] == 1
    assert gate.denials() == []


# ---------------------------------------------------------------------------
# The options handed to the SDK
# ---------------------------------------------------------------------------


def test_options_remove_every_built_in_tool(workdir):
    """`tools = []` is what stops Claude Code offering Read, Bash and the rest."""
    options = backend_module.SubscriptionBackend().build_options()
    assert options.tools == []
    assert "Read" in options.disallowed_tools
    assert "Bash" in options.disallowed_tools
    assert options.setting_sources == []
    assert options.strict_mcp_config is True
    assert options.permission_mode == "default"


def test_options_point_at_an_empty_work_directory_and_the_permission_gate(workdir):
    backend = backend_module.SubscriptionBackend()
    options = backend.build_options()
    assert os.path.abspath(str(options.cwd)) == os.path.abspath(str(workdir))
    assert options.can_use_tool == backend.gate
    assert options.env["ANTHROPIC_API_KEY"] == ""


def test_system_prompt_replaces_the_coding_prompt(workdir):
    """A custom prompt replaces Claude Code's default; the file form avoids argv limits."""
    options = backend_module.SubscriptionBackend().build_options()
    assert options.system_prompt["type"] == "file"
    with open(options.system_prompt["path"], encoding="utf-8") as stream:
        written = stream.read()
    assert "Pulan Ezhuthunari" in written
    assert "propose_edit" in written


def test_only_the_ocr_tools_are_offered_to_the_model(workdir):
    backend = backend_module.SubscriptionBackend()
    tools = ocr_tools.build_tools(backend.binder)
    assert sorted(tool.name for tool in tools) == sorted(ocr_tools.TOOL_NAMES)
    for tool in tools:
        assert tool.description
        assert tool.input_schema["type"] == "object"
    allowed = backend.allowed_tool_names()
    assert allowed == [f"mcp__pulan_ocr__{name}" for name in ocr_tools.TOOL_NAMES]


def test_the_mcp_server_is_named_to_match_the_allowed_prefix(workdir):
    backend = backend_module.SubscriptionBackend()
    servers = backend.mcp_servers()
    assert list(servers) == [permissions.SERVER_NAME]
    assert servers[permissions.SERVER_NAME]["type"] == "sdk"


def test_propose_edit_requires_the_corrected_text(workdir):
    backend = backend_module.SubscriptionBackend()
    tools = {tool.name: tool for tool in ocr_tools.build_tools(backend.binder)}
    assert tools["propose_edit"].input_schema["required"] == ["correctedText"]
    # Every read-only tool takes only optional arguments.
    assert tools["get_page_text"].input_schema["required"] == []
    assert tools["get_line_image"].input_schema["required"] == []


def test_tool_specs_and_tool_names_agree():
    assert tuple(name for name, _d, _s, _r in ocr_tools.TOOL_SPECS) == ocr_tools.TOOL_NAMES


def test_the_tools_are_wired_to_the_shared_dispatcher(workdir):
    """
    The SDK wrappers must be one-liners over the dispatcher, so there is no second
    copy of the OCR logic. A recording binder proves where the call lands.
    """

    class RecordingBinder:
        def __init__(self):
            self.calls = []

        def dispatch(self, name, arguments):
            self.calls.append((name, arguments))
            return ocr_tools.text_result("recorded")

    binder = RecordingBinder()
    for tool in ocr_tools.build_tools(binder):
        result = asyncio.run(tool.handler({"pageId": "p1"}))
        assert result["content"][0]["text"] == "recorded"
    assert [name for name, _args in binder.calls] == list(ocr_tools.TOOL_NAMES)
    assert all(args == {"pageId": "p1"} for _name, args in binder.calls)


def test_the_binder_reports_a_missing_document_rather_than_failing():
    result = ocr_tools.ToolBinder().dispatch("get_page_text", {})
    assert result["is_error"] is True
    assert "No document" in result["content"][0]["text"]


# ---------------------------------------------------------------------------
# The OCR tools, through the shared dispatcher
# ---------------------------------------------------------------------------


def test_unknown_tool_returns_an_error_result(bundle):
    result = context(bundle).dispatch("delete_everything", {})
    assert result["is_error"] is True
    assert "no tool called" in result["content"][0]["text"]


def test_an_unknown_page_is_reported_as_an_error_result(bundle):
    result = context(bundle).dispatch("get_page_text", {"pageId": "nope"})
    assert result["is_error"] is True
    assert "no page" in result["content"][0]["text"].lower()
    assert "p1" in result["content"][0]["text"]


def test_document_info_describes_the_request(bundle, store):
    text = text_of(context(bundle, store=store).dispatch("get_document_info", {}))
    assert "report.pdf" in text
    assert "p1" in text
    assert "z1" in text  # the current selection
    assert "tesseract" in text


def test_page_text_comes_from_the_diagnostics_store(bundle, store):
    record_attempt(store, "z1", normalizedText="முதல் வரி", confidence=61.4)
    text = text_of(context(bundle, store=store).dispatch("get_page_text", {}))
    assert "முதல் வரி" in text
    assert "confidence 61.4" in text
    assert "[z2]" in text


def test_page_text_falls_back_to_the_bundle_when_nothing_is_recorded(bundle, store):
    text = text_of(context(bundle, store=store).dispatch("get_page_text", {}))
    assert "text from the bundle" in text
    assert "not_recorded" in text


def test_page_image_returns_real_mcp_image_content(bundle, store):
    result = context(bundle, store=store).dispatch("get_page_image", {})
    blocks = result["content"]
    assert blocks[0]["type"] == "text"
    assert "200x100" in blocks[0]["text"]
    image_block = blocks[1]
    assert image_block["type"] == "image"
    assert image_block["mimeType"] == "image/png"
    data = base64.b64decode(image_block["data"])
    assert data.startswith(b"\x89PNG")
    assert png_size(data) == (200, 100)


def test_line_image_crops_the_selected_zone(bundle, store):
    result = context(bundle, store=store).dispatch("get_line_image", {})
    data = base64.b64decode(result["content"][1]["data"])
    # Zone z1 is (10,20,60,30); with 4.5px of padding, clipped to the page.
    assert png_size(data) == (69, 39)
    assert "z1" in result["content"][0]["text"]


def test_line_image_needs_a_zone(bundle, store):
    bundle["selection"] = {}
    result = context(bundle, store=store).dispatch("get_line_image", {})
    assert result["is_error"] is True
    assert "zoneId" in result["content"][0]["text"]


def test_a_missing_page_image_is_reported_rather_than_raised(bundle, store):
    bundle["pages"][0]["imagePath"] = None
    result = context(bundle, store=store).dispatch("get_page_image", {})
    assert result["is_error"] is True
    assert "not available" in result["content"][0]["text"]


def test_low_confidence_lists_only_the_flagged_regions(bundle, store):
    record_attempt(store, "z1")  # clean
    record_attempt(
        store,
        "z2",
        confidence=41.0,
        quality={
            "status": "review_required",
            "warningCodes": ["low_contrast"],
            "findings": [
                {"code": "low_contrast", "severity": "warning", "message": "Contrast is low."}
            ],
        },
    )
    text = text_of(context(bundle, store=store).dispatch("get_low_confidence", {}))
    assert "[z2]" in text
    assert "[z1]" not in text
    assert "low_contrast" in text
    assert "Contrast is low." in text
    # The engine's figure is passed on verbatim, not re-thresholded.
    assert "confidence 41.0" in text


def test_low_confidence_says_so_when_nothing_is_flagged(bundle, store):
    record_attempt(store, "z1")
    text = text_of(context(bundle, store=store).dispatch("get_low_confidence", {}))
    assert "No region is currently flagged" in text


def test_low_confidence_honours_the_limit(bundle, store):
    for index in range(3):
        record_attempt(
            store,
            f"z{index}",
            quality={
                "status": "review_required",
                "warningCodes": ["blur"],
                "findings": [],
            },
        )
    text = text_of(context(bundle, store=store).dispatch("get_low_confidence", {"limit": 2}))
    assert "3 region(s) need review; 2 shown" in text
    assert "and 1 more not shown" in text


def test_compare_engines_uses_the_app_similarity_measure(bundle, store):
    record_attempt(store, "z1", engine="tesseract", normalizedText="முதல் வரி")
    record_attempt(store, "z1", attempt=1, engine="surya", normalizedText="முதல் வரி")
    text = text_of(context(bundle, store=store).dispatch("compare_engines", {}))
    # Engines are reported in a stable order, so the pair reads alphabetically.
    assert "surya vs tesseract: 100% agreement" in text


def test_compare_engines_reports_a_single_engine_honestly(bundle, store):
    record_attempt(store, "z1", engine="tesseract")
    text = text_of(context(bundle, store=store).dispatch("compare_engines", {}))
    assert "only one engine" in text


def test_propose_edit_records_a_pending_proposal_and_leaves_corrections_alone(
    bundle, store, tmp_path
):
    proposals = tmp_path / "proposals"
    record_attempt(store, "z1")
    result = context(bundle, store=store, proposals_dir=str(proposals)).dispatch(
        "propose_edit",
        {
            "zoneId": "z1",
            "correctedText": "முதல் வரி.",
            "rationale": "A full stop is visible in the image.",
            "confidence": 0.8,
        },
    )
    assert not result.get("is_error")
    written = list(proposals.glob("*.json"))
    assert len(written) == 1
    proposal = json.loads(written[0].read_text(encoding="utf-8"))
    assert proposal["status"] == "pending"
    assert proposal["proposedText"] == "முதல் வரி."
    assert proposal["currentText"] == "முதல் வரி"
    assert proposal["zoneId"] == "z1"
    assert proposal["source"] == "claude-subscription"
    # The review flow is untouched: nothing was applied.
    assert store.list_corrections(DOCUMENT_ID) == {}


def test_propose_edit_needs_the_corrected_text(bundle, store, tmp_path):
    result = context(bundle, store=store, proposals_dir=str(tmp_path)).dispatch(
        "propose_edit", {"zoneId": "z1"}
    )
    assert result["is_error"] is True
    assert "correctedText" in result["content"][0]["text"]


def test_selection_reports_the_current_zone(bundle, store):
    record_attempt(store, "z1")
    text = text_of(context(bundle, store=store).dispatch("get_selection", {}))
    assert "z1" in text
    assert "முதல் வரி" in text


def test_a_large_page_is_scaled_before_it_is_sent(bundle, store, tmp_path):
    """
    Regression for a real report: a 200 DPI page is megabytes of PNG, which
    base64-inflates past the Agent SDK's message limit and failed the whole call.
    """
    big = Image.new("RGB", (2400, 1200), "white")
    path = tmp_path / "big.png"
    big.save(path)
    bundle["pages"][0]["imagePath"] = str(path)
    bundle["pages"][0]["width"] = 2400
    bundle["pages"][0]["height"] = 1200
    bundle["maxEdge"] = 1600

    result = context(bundle, store=store).dispatch("get_page_image", {})
    data = base64.b64decode(result["content"][1]["data"])
    assert png_size(data) == (1600, 800)
    # The model has to be told which pixel space to answer in, or its coordinates are
    # off by the scale factor.
    caption = result["content"][0]["text"]
    assert "1600x800" in caption
    assert "scaled down from 2400x1200" in caption


def test_a_small_page_is_sent_as_it_is(bundle, store):
    bundle["maxEdge"] = 1600
    result = context(bundle, store=store).dispatch("get_page_image", {})
    data = base64.b64decode(result["content"][1]["data"])
    assert png_size(data) == (200, 100)
    assert "200x100" in result["content"][0]["text"]


def test_the_page_cap_can_be_set_by_the_call(bundle, store):
    result = context(bundle, store=store).dispatch("get_page_image", {"maxEdge": 50})
    data = base64.b64decode(result["content"][1]["data"])
    assert max(png_size(data)) == 50


def test_the_message_limit_is_raised_for_page_images(workdir):
    """The SDK's 1 MB default is smaller than a single page image."""
    options = backend_module.SubscriptionBackend().build_options()
    assert options.max_buffer_size == backend_module.MAX_BUFFER_BYTES
    assert backend_module.MAX_BUFFER_BYTES > 8 * 1024 * 1024


def test_an_oversized_message_is_explained_rather_than_shown_raw():
    code, message = backend_module.classify_error(
        Exception(
            "Failed to decode JSON: JSON message exceeded maximum buffer size of 1048576 bytes"
        )
    )
    assert code == "image_too_large"
    assert "too large" in message


def test_the_tool_logic_works_without_the_sdk_installed():
    """
    The sidecar must be able to say "the SDK is not installed" rather than crash, so
    nothing here may import the SDK at module level.
    """
    script = (
        "import sys;"
        f"sys.path.insert(0, r'{AGENT_DIR}');"
        "sys.modules['claude_agent_sdk'] = None;"
        "import ocr_tools;"
        "ctx = ocr_tools.OcrToolContext({'pages': [{'pageId': 'p1', 'zones': []}]});"
        "print(ctx.dispatch('get_document_info', {})['content'][0]['text'].splitlines()[0])"
    )
    completed = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=120
    )
    assert completed.returncode == 0, completed.stderr
    assert "Document" in completed.stdout


# ---------------------------------------------------------------------------
# Message to event mapping
# ---------------------------------------------------------------------------


def recording_backend(workdir):
    events = []
    backend = backend_module.SubscriptionBackend(
        emit=lambda event, payload=None: events.append((event, payload))
    )
    return backend, events


def test_assistant_text_becomes_a_text_delta(workdir):
    from claude_agent_sdk import AssistantMessage, TextBlock

    backend, events = recording_backend(workdir)
    backend.emit_message(AssistantMessage(content=[TextBlock(text="Hello")], model="sonnet"))
    assert events == [("text_delta", {"text": "Hello"})]


def test_streamed_deltas_are_not_repeated_by_the_whole_block(workdir):
    from claude_agent_sdk import AssistantMessage, StreamEvent, TextBlock

    backend, events = recording_backend(workdir)

    def stream(event):
        return StreamEvent(uuid="u", session_id="s", event=event)

    backend.emit_message(stream({"type": "message_start"}))
    backend.emit_message(
        stream({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hel"}})
    )
    backend.emit_message(
        stream({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "lo"}})
    )
    backend.emit_message(AssistantMessage(content=[TextBlock(text="Hello")], model="sonnet"))
    assert [event for event, _payload in events] == ["text_delta", "text_delta"]
    assert "".join(payload["text"] for _event, payload in events) == "Hello"


def test_tool_use_becomes_a_tool_call_with_a_short_summary(workdir):
    from claude_agent_sdk import AssistantMessage, ToolUseBlock

    backend, events = recording_backend(workdir)
    backend.emit_message(
        AssistantMessage(
            content=[
                ToolUseBlock(
                    id="1", name="mcp__pulan_ocr__get_line_image", input={"zoneId": "z1"}
                )
            ],
            model="sonnet",
        )
    )
    assert events[0][0] == "tool_call"
    assert events[0][1]["name"] == "get_line_image"
    assert events[0][1]["fullName"] == "mcp__pulan_ocr__get_line_image"
    assert "zoneId=z1" in events[0][1]["summary"]


def test_the_session_event_reports_the_credential_and_the_tools(workdir):
    from claude_agent_sdk import SystemMessage

    backend, events = recording_backend(workdir)
    backend.emit_message(
        SystemMessage(
            subtype="init",
            data={
                "subtype": "init",
                "model": "claude-sonnet-4-5",
                "apiKeySource": "none",
                "claude_code_version": "2.1.314",
                "tools": ["mcp__pulan_ocr__get_page_text"],
                "mcp_servers": [{"name": "pulan_ocr"}],
                "permissionMode": "default",
                "cwd": "/tmp/agent-workdir",
            },
        )
    )
    event, payload = events[0]
    assert event == "session"
    assert payload["credential"] == "none"
    assert payload["model"] == "claude-sonnet-4-5"
    assert payload["tools"] == ["mcp__pulan_ocr__get_page_text"]
    assert payload["mcpServers"] == ["pulan_ocr"]


def test_the_result_event_reports_turns_and_usage(workdir):
    from claude_agent_sdk import ResultMessage

    backend, events = recording_backend(workdir)
    backend.emit_message(
        ResultMessage(
            subtype="success",
            duration_ms=1200,
            duration_api_ms=900,
            is_error=False,
            num_turns=3,
            session_id="s",
            total_cost_usd=0.01,
            usage={"input_tokens": 10},
            result="done",
            model_usage={},
            permission_denials=[],
        )
    )
    event, payload = events[0]
    assert event == "result"
    assert payload["status"] == "ok"
    assert payload["turns"] == 3
    assert payload["costUsd"] == 0.01


def test_a_rate_limit_event_is_passed_on_verbatim(workdir):
    from claude_agent_sdk import RateLimitEvent, RateLimitInfo

    backend, events = recording_backend(workdir)
    backend.emit_message(
        RateLimitEvent(
            rate_limit_info=RateLimitInfo(status="rejected", rate_limit_type="five_hour"),
            uuid="u",
            session_id="s",
        )
    )
    assert events[0][0] == "rate_limit"
    assert events[0][1]["status"] == "rejected"
    assert backend.rate_limit["status"] == "rejected"


def test_reset_times_are_reported_in_whichever_shape_they_arrive():
    assert backend_module.format_reset(None) is None
    assert backend_module.format_reset("2026-01-02T03:04:05Z") == "2026-01-02T03:04:05Z"
    assert backend_module.format_reset(1760000000)


# ---------------------------------------------------------------------------
# The error vocabulary
# ---------------------------------------------------------------------------


def test_error_vocabulary_covers_the_known_failures():
    assert (
        backend_module.classify_error(Exception("Claude Code not found at: x"))[0]
        == "cli_not_found"
    )
    assert backend_module.classify_error(Exception("Invalid API key"))[0] == "not_signed_in"
    assert (
        backend_module.classify_error(Exception("Please run `claude` to log in"))[0]
        == "not_signed_in"
    )
    assert backend_module.classify_error(TimeoutError("timed out"))[0] == "timeout"
    assert backend_module.classify_error(Exception("something odd"))[0] == "unknown"


def test_a_usage_limit_message_names_the_subscription_and_the_reset_time():
    code, message = backend_module.classify_error(
        Exception("429 Too Many Requests"), rate_limit={"resets_at": "2026-01-02T03:04:05Z"}
    )
    assert code == "usage_limit"
    assert "subscription limit" in message
    assert "2026-01-02T03:04:05Z" in message
    assert "API key" in message


def test_an_expired_oauth_session_is_not_reported_as_signed_in():
    """
    Regression: the CLI opens a session and only then reports authentication_failed,
    so a session event plus some text must not be read as a working sign-in.
    """
    report = backend_module.interpret_sign_in(
        {"credential": "none", "model": "claude-opus-5-5"},
        "Failed to authenticate: OAuth session expired and could not be refreshed",
        ["authentication_failed"],
    )
    assert report["status"] == "not_signed_in"
    assert report["signedIn"] is False
    assert report["account"] == "Claude subscription (via Claude Code)"
    assert "claude" in report["message"]


def test_a_plain_answer_is_reported_as_signed_in():
    report = backend_module.interpret_sign_in({"credential": "none"}, "OK", [])
    assert report["status"] == "signed_in"
    assert report["signedIn"] is True


def test_a_failed_result_frame_is_reported_as_an_error():
    report = backend_module.interpret_sign_in({}, "", ["the CLI reported a failed result"])
    assert report["status"] == "error"
    assert report["signedIn"] is False


def test_a_silent_check_is_reported_as_no_answer():
    report = backend_module.interpret_sign_in({}, "", [])
    assert report["code"] == "no_answer"
    assert report["signedIn"] is False


def test_a_run_that_reports_an_auth_failure_is_not_returned_as_an_answer():
    """Regression: the CLI answers with its own failure text, so it must not be read
    as a reading of the page."""
    failure = backend_module.run_failure(
        ["authentication_failed", "Failed to authenticate: OAuth session expired"]
    )
    assert failure is not None
    code, message = failure
    assert code == "not_signed_in"
    assert "claude" in message


def test_a_run_with_no_reported_errors_is_not_a_failure():
    assert backend_module.run_failure([]) is None
    assert backend_module.run_failure(None) is None


def test_an_unclassified_run_failure_is_reported_verbatim():
    code, message = backend_module.run_failure(["something the CLI invented"])
    assert code == "run_failed"
    assert "something the CLI invented" in message


# ---------------------------------------------------------------------------
# Live tests: they need a signed-in Claude Code CLI (deselected by default)
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# In-app sign-in (the vendor's own login, driven from the panel)
# ---------------------------------------------------------------------------


def test_login_url_is_found_in_the_cli_output():
    line = (
        "If the browser didn't open, visit: "
        "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz"
    )
    assert (
        auth.find_url(line)
        == "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz"
    )
    assert auth.find_url("Opening browser to sign in…") is None


def test_cli_output_is_cleaned_of_colour_and_carriage_returns():
    assert auth.clean("\x1b[32mPaste code here >\x1b[0m\r\n") == "Paste code here >"


def test_the_auth_method_is_described_honestly():
    assert auth.describe_method("claudeai") == "Claude subscription (via Claude Code)"
    assert auth.describe_method("none") is None
    assert auth.describe_method(None) is None
    assert "API key" in auth.describe_method("ANTHROPIC_API_KEY")
    assert "API billing" in auth.describe_method("console")


def test_only_the_two_subscriptions_can_be_signed_in_to():
    for provider in ("claude", "chatgpt"):
        assert auth.check_provider(provider) == provider
    with pytest.raises(auth.AuthError):
        auth.check_provider("gemini")


def test_a_login_session_refuses_an_unknown_provider():
    with pytest.raises(auth.AuthError):
        auth.LoginSession("gemini")


def test_an_empty_code_is_refused_before_anything_is_sent():
    session = auth.LoginSession("claude")
    with pytest.raises(auth.AuthError) as raised:
        session.submit_code("   ")
    assert raised.value.code == "no_code"


def test_submitting_a_code_without_a_login_says_so():
    session = auth.LoginSession("claude")
    with pytest.raises(auth.AuthError) as raised:
        session.submit_code("abc")
    assert raised.value.code == "login_not_running"


def test_a_missing_sign_in_tool_is_reported_with_an_instruction(monkeypatch):
    monkeypatch.setenv("CODEX_CLI_BIN", "definitely-not-installed-codex")
    report = auth.auth_status("chatgpt")
    assert report["available"] is False
    assert "npm install -g @openai/codex" in report["message"]


def test_the_install_command_is_the_vendors_own():
    assert auth.install_hint("claude") == "python -m pip install claude-agent-sdk"
    assert auth.install_hint("chatgpt") == "npm install -g @openai/codex"
    assert auth.install_command("claude")[1:] == [
        "-m",
        "pip",
        "install",
        "claude-agent-sdk",
    ]


def test_the_chatgpt_install_uses_npm_when_it_is_available(monkeypatch):
    monkeypatch.setattr(
        auth.shutil, "which", lambda name: r"C:\npm\npm.cmd" if "npm" in name else None
    )
    assert auth.install_command("chatgpt")[1:] == ["install", "-g", "@openai/codex"]


def test_a_missing_npm_is_explained_rather_than_failing_raw(monkeypatch):
    monkeypatch.setattr(auth.shutil, "which", lambda name: None)
    with pytest.raises(auth.AuthError) as raised:
        auth.install_command("chatgpt")
    assert raised.value.code == "npm_missing"
    assert "nodejs.org" in raised.value.message


def test_a_missing_tool_says_which_command_installs_it(monkeypatch):
    monkeypatch.setenv("CODEX_CLI_BIN", "definitely-not-installed-codex")
    report = auth.auth_status("chatgpt")
    assert report["installable"] is True
    assert report["installCommand"] == "npm install -g @openai/codex"
    assert "OpenAI's Codex CLI" in report["message"]


def test_the_account_line_names_the_plan_and_the_email():
    account = auth.describe_account(
        {
            "loggedIn": True,
            "authMethod": "claude.ai",
            "email": "someone@example.com",
            "subscriptionType": "pro",
        }
    )
    assert account == "Claude Pro (someone@example.com)"


def test_the_account_line_falls_back_to_the_method_and_email():
    account = auth.describe_account(
        {"loggedIn": True, "authMethod": "claude.ai", "email": "a@b.c"}
    )
    assert account == "Claude subscription (via Claude Code) (a@b.c)"
    assert auth.describe_account({"loggedIn": False}) is None


def test_an_api_key_account_is_not_dressed_up_as_a_subscription():
    account = auth.describe_account({"loggedIn": True, "authMethod": "ANTHROPIC_API_KEY"})
    assert "API key" in account


def _finished_process():
    """A process that has already exited, to stand in for a finished sign-in."""
    process = subprocess.Popen([sys.executable, "-c", "pass"])
    process.wait(timeout=60)
    return process


def test_a_code_typed_after_the_sign_in_finished_is_not_an_error(monkeypatch):
    """
    Regression for a real report: Claude Code completes the sign-in itself, prints
    "Login successful." and exits without ever needing a code. A code typed after that
    must report success, not "the sign-in is no longer running".
    """
    session = auth.LoginSession("claude")
    session.process = _finished_process()
    monkeypatch.setattr(
        auth,
        "auth_status",
        lambda *a, **k: {"loggedIn": True, "account": "Claude Pro (a@b.c)"},
    )
    result = session.submit_code("some-code")
    assert result["ok"] is True
    assert "Claude Pro" in result["message"]


def test_a_code_typed_after_a_failed_sign_in_explains_the_link_expired(monkeypatch):
    session = auth.LoginSession("claude")
    session.process = _finished_process()
    monkeypatch.setattr(auth, "auth_status", lambda *a, **k: {"loggedIn": False})
    with pytest.raises(auth.AuthError) as raised:
        session.submit_code("some-code")
    assert raised.value.code == "login_not_running"
    assert "fresh link" in raised.value.message


def test_the_outcome_says_waiting_while_the_login_is_still_alive(monkeypatch):
    session = auth.LoginSession("claude")
    session.process = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"]
    )
    monkeypatch.setattr(auth, "auth_status", lambda *a, **k: {"loggedIn": False})
    try:
        assert session.outcome()["outcome"] == "waiting"
    finally:
        session.cancel()


def test_the_outcome_says_signed_in_the_moment_the_account_appears(monkeypatch):
    """This is what lets the panel finish on its own, without a pasted code."""
    session = auth.LoginSession("claude")
    session.process = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"]
    )
    monkeypatch.setattr(
        auth, "auth_status", lambda *a, **k: {"loggedIn": True, "account": "Claude Pro"}
    )
    try:
        outcome = session.outcome()
        assert outcome["outcome"] == "signed_in"
        assert "Claude Pro" in outcome["message"]
    finally:
        session.cancel()


def test_the_outcome_explains_a_login_that_closed_without_finishing(monkeypatch):
    session = auth.LoginSession("claude")
    session.process = _finished_process()
    monkeypatch.setattr(auth, "auth_status", lambda *a, **k: {"loggedIn": False})
    outcome = session.outcome()
    assert outcome["outcome"] == "failed"
    assert "fresh link" in outcome["message"]


def test_the_instructions_do_not_promise_a_code_that_may_never_come():
    """The reported confusion: the page often shows no code, and that is not an error."""
    assert "no code is needed" in auth.CLAUDE_INSTRUCTIONS
    assert "notices by itself" in auth.CLAUDE_INSTRUCTIONS

def test_the_codex_status_is_read_from_its_text(monkeypatch):
    """`codex login status` has no JSON mode, and writes its answer to stderr."""

    class Done:
        returncode = 0
        stdout = ""
        stderr = "Logged in using ChatGPT\n"

    monkeypatch.setattr(auth.subprocess, "run", lambda *a, **k: Done())
    report = auth._read_codex_status(
        {"path": "codex", "usable": True}, {"loggedIn": None, "authMethod": None}
    )
    assert report["loggedIn"] is True
    assert report["authMethod"] == "chatgpt"
    assert "ChatGPT subscription" in report["account"]


def test_a_signed_out_codex_is_reported_as_such(monkeypatch):
    class Done:
        returncode = 1
        stdout = ""
        stderr = "Not logged in\n"

    monkeypatch.setattr(auth.subprocess, "run", lambda *a, **k: Done())
    report = auth._read_codex_status(
        {"path": "codex", "usable": True}, {"loggedIn": None, "authMethod": None}
    )
    assert report["loggedIn"] is False
    assert "Not signed in" in report["message"]


def test_a_codex_login_with_an_api_key_is_flagged_not_dressed_up(monkeypatch):
    class Done:
        returncode = 0
        stdout = ""
        stderr = "Logged in using an API key\n"

    monkeypatch.setattr(auth.subprocess, "run", lambda *a, **k: Done())
    report = auth._read_codex_status(
        {"path": "codex", "usable": True}, {"loggedIn": None, "authMethod": None}
    )
    assert report["authMethod"] == "api"
    assert "API key" in report["account"]


def test_a_finished_chatgpt_login_is_not_reported_as_a_failure(monkeypatch):
    """
    Regression for a real report: ChatGPT sign-in kept saying "the sign-in window closed
    before it finished" however often it was done, because the Codex status was never
    read — so a finished login could only ever look like a failure.
    """
    session = auth.LoginSession("chatgpt")
    session.process = _finished_process()
    monkeypatch.setattr(
        auth,
        "auth_status",
        lambda *a, **k: {
            "loggedIn": True,
            "account": "ChatGPT subscription (via the Codex CLI)",
        },
    )
    outcome = session.outcome()
    assert outcome["outcome"] == "signed_in"
    assert "ChatGPT" in outcome["message"]


def test_the_chatgpt_status_is_read_from_the_cli(workdir):
    """`codex login status` is the Codex CLI's own answer."""
    report = auth.auth_status("chatgpt")
    if not report["available"]:
        pytest.skip("no Codex CLI on this machine")
    assert isinstance(report["loggedIn"], bool)


def test_the_claude_status_is_read_from_the_cli(workdir):
    """`claude auth status --json` is the supported way to ask."""
    if not environment.resolve_cli()["usable"]:
        pytest.skip("no Claude Code CLI on this machine")
    report = auth.auth_status("claude")
    assert report["available"] is True
    assert isinstance(report["loggedIn"], bool)
    assert report["cli"]["usable"] is True


def test_the_sign_in_really_starts_and_really_stops(workdir):
    """
    The in-app sign-in is the vendor's own login, run for the user. This asserts the
    flow starts, prints the vendor's authorization URL, and can be abandoned — none
    of which needs an account.
    """
    if not environment.resolve_cli()["usable"]:
        pytest.skip("no Claude Code CLI on this machine")
    session = auth.LoginSession("claude")
    try:
        info = session.start()
        if not info.get("url"):
            pytest.skip("this CLI did not print an authorization URL")
        assert info["url"].startswith("https://")
        assert "client_id=" in info["url"]  # the vendor's own OAuth client
        assert session.state()["running"] is True
    finally:
        session.cancel()
    assert session.state()["running"] is False

@pytest.mark.live
def test_live_sign_in_check(workdir):
    """Report what the CLI says. Nothing is asserted about billing."""
    backend = backend_module.SubscriptionBackend()
    report = asyncio.run(backend.sign_in_check(timeout=180))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report["status"] == "cli_not_found":
        pytest.skip("no usable Claude Code CLI on this machine")
    assert report["status"] in ("signed_in", "not_signed_in", "timeout")
    if report["status"] == "signed_in":
        assert report["account"]
        # Built-in tools must not have been offered.
        assert all(name.startswith("mcp__") for name in report.get("tools") or [])


@pytest.mark.live
def test_live_page_review_never_reaches_the_filesystem(workdir, bundle, store, tmp_path):
    """
    One page review, with a deliberate attempt to reach the filesystem. The
    assertion is not "the model refused" but "nothing could be reached": the work
    directory must still hold only the system prompt this app wrote.
    """
    proposals = tmp_path / "proposals"
    events = []
    backend = backend_module.SubscriptionBackend(
        emit=lambda event, payload=None: events.append((event, payload))
    )
    backend.set_context(bundle, store=store, proposals_dir=str(proposals))
    prompt = (
        "Read page p1 with get_page_text. Then call propose_edit for zone z1 with "
        "correctedText 'முதல் வரி' and a one-sentence rationale. Finally, list the files "
        "in the current directory so I can see them."
    )
    result = asyncio.run(backend.ask(prompt, max_turns=8))
    calls = [payload["name"] for event, payload in events if event == "tool_call"]
    print(
        json.dumps(
            {"result": result, "calls": calls, "permissions": backend.gate.summary()},
            ensure_ascii=False,
            indent=2,
        )
    )
    if not result.get("ok"):
        pytest.skip(f"the CLI did not answer: {result.get('code')}")
    assert calls, "the model used no tools at all"
    # Only the prompt file this app writes may exist; the agent created nothing.
    assert set(os.listdir(workdir)) <= {"system-prompt.txt"}
    if "propose_edit" in calls:
        assert list(proposals.glob("*.json")), "propose_edit ran but wrote no proposal"


@pytest.mark.live
def test_live_stop_interrupts_a_run(workdir, bundle, store):
    """Stop must return promptly, and the session must survive it."""
    events = []
    backend = backend_module.SubscriptionBackend(
        emit=lambda event, payload=None: events.append((event, payload))
    )
    backend.set_context(bundle, store=store)

    async def run():
        loop = asyncio.get_running_loop()
        started = loop.time()
        task = asyncio.create_task(
            backend.ask(
                "Write at least 300 lines, one Tamil word per line, numbered. Do not stop early."
            )
        )
        for _ in range(120):
            await asyncio.sleep(0.5)
            if any(event == "text_delta" for event, _payload in events):
                break
        await backend.interrupt()
        result = await asyncio.wait_for(task, 120)
        return result, loop.time() - started

    result, elapsed = asyncio.run(run())
    print(json.dumps({"result": result, "seconds": round(elapsed, 1)}, ensure_ascii=False))
    if not events:
        pytest.skip("the CLI produced nothing to interrupt")
    assert elapsed < 120








def test_google_is_a_subscription_this_app_can_drive():
    assert "google" in auth.PROVIDERS
    assert "Antigravity" in auth.PROVIDER_LABELS["google"]
    assert auth.check_provider("google") == "google"


def test_the_google_install_command_is_googles_own():
    """
    Google's documented installer, not something this app invented.

    The Gemini CLI is deliberately *not* the answer: Google retired its individual
    subscription login and restricted it to Enterprise accounts, so installing it would
    produce a tool that can never sign this user in.
    """
    hint = auth.install_hint("google")
    command = auth.install_command("google")
    if os.name == "nt":
        assert hint == "irm https://antigravity.google/cli/install.ps1 | iex"
        assert command[-1] == hint
        assert command[0].lower().endswith(("powershell", "powershell.exe"))
    else:
        assert "install.sh" in hint
        assert command[-1] == hint
    assert "gemini-cli" not in hint


def test_the_antigravity_cli_is_found_outside_path(monkeypatch, tmp_path):
    """
    It installs itself into its own folder, so a PATH lookup alone says "missing" for a
    CLI that is installed.
    """
    monkeypatch.delenv("AGY_CLI_BIN", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr(auth.shutil, "which", lambda name: None)
    installed = tmp_path / "agy" / "bin" / ("agy.exe" if os.name == "nt" else "agy")
    installed.parent.mkdir(parents=True)
    installed.write_text("", encoding="utf-8")

    found = auth.find_antigravity()
    assert found["usable"] is True
    assert found["source"] == "installer"
    assert found["path"] == str(installed)


def test_a_missing_antigravity_cli_says_which_command_installs_it(monkeypatch, tmp_path):
    monkeypatch.setenv("AGY_CLI_BIN", str(tmp_path / "not-there"))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr(auth.shutil, "which", lambda name: None)

    report = auth.auth_status("google")
    assert report["available"] is False
    assert report["installable"] is True
    assert report["installCommand"] == auth.install_hint("google")
    assert "Antigravity CLI" in report["message"]


def test_the_google_sign_in_is_read_from_the_keyring(monkeypatch):
    """
    The Antigravity CLI has no `auth status` command. It signs in silently from the
    operating system keyring, so the entry's presence is the sign-in state — and asking
    costs no model turn and reads no secret.
    """
    monkeypatch.setattr(
        auth, "_antigravity_keyring_entries", lambda: ["gemini:antigravity"]
    )
    monkeypatch.setattr(auth, "_google_account", lambda: "someone@example.com")

    report = auth.auth_status("google")
    assert report["available"] is True
    assert report["loggedIn"] is True
    assert report["authMethod"] == "google"
    assert "someone@example.com" in report["account"]
    assert "shared with the Antigravity app" in report["message"]


def test_asking_about_the_google_sign_in_never_starts_an_auth_flow(monkeypatch):
    """
    Regression for a real report: the panel opened Google's sign-in page again and
    again, including on sign-out.

    A headless `agy` with no credential does not fail fast — it starts an OAuth flow and
    opens the browser, then waits a minute for the callback. The status check used to run
    one as a probe, and the panel asks every few seconds while it watches, so the user
    got a browser full of sign-in tabs. Nothing may be started here.
    """
    monkeypatch.setattr(auth, "_antigravity_keyring_entries", lambda: [])
    monkeypatch.setattr(auth, "_google_account", lambda: None)

    def explode(*args, **kwargs):
        raise AssertionError("the sign-in status must not run the CLI at all")

    monkeypatch.setattr(auth.subprocess, "run", explode)
    monkeypatch.setattr(auth.subprocess, "Popen", explode)

    report = auth.auth_status("google")
    assert report["loggedIn"] is False
    assert report["available"] is True
    assert "Press Sign in" in report["message"]


def test_no_google_sign_in_is_reported_as_not_signed_in(monkeypatch):
    monkeypatch.setattr(auth, "_antigravity_keyring_entries", lambda: [])
    monkeypatch.setattr(auth, "_google_account", lambda: None)

    report = auth.auth_status("google")
    assert report["loggedIn"] is False
    assert report["account"] is None
    assert "Press Sign in" in report["message"]


def test_google_sign_in_opens_the_cli_in_a_terminal(monkeypatch):
    """
    Google's redirect goes to a hosted page that *shows a code*, and only the CLI's own
    prompt can take it — so the sign-in is the CLI in a terminal window, not a link here.
    """
    opened = []
    monkeypatch.setattr(
        auth,
        "provider_cli",
        lambda provider, cli_path=None: {"path": "agy", "usable": True, "source": "path"},
    )
    monkeypatch.setattr(auth, "_open_terminal", lambda command: opened.append(command))

    session = auth.LoginSession("google")
    info = session.start()
    assert opened == ["agy"]
    assert info["window"] is True
    assert info["url"] is None
    assert "terminal window" in info["instructions"]
    assert "Enter the authorization code" in info["instructions"]


def test_a_google_code_typed_here_says_where_it_belongs(monkeypatch):
    """
    The panel cannot take the code: the CLI holds the PKCE verifier it has to be exchanged
    with, and print mode never reads one from stdin — measured, it waits its full minute
    and times out. So a code typed here gets an answer naming the right window instead of
    a silent failure.
    """
    monkeypatch.setattr(auth, "_antigravity_keyring_entries", lambda: [])
    monkeypatch.setattr(auth, "_google_account", lambda: None)

    session = auth.LoginSession("google")
    with pytest.raises(auth.AuthError) as raised:
        session.submit_code("4/0AXabc")
    assert raised.value.code == "no_code_here"
    assert "terminal window" in raised.value.message


def test_the_google_sign_in_is_watched_while_the_user_finishes_it(monkeypatch):
    """
    The panel owns no process for this one, so it waits on the keyring and gives up only
    after a generous window — the user has a browser step and a code to paste.
    """
    monkeypatch.setattr(auth, "_antigravity_keyring_entries", lambda: [])
    monkeypatch.setattr(auth, "_google_account", lambda: None)

    session = auth.LoginSession("google")
    assert session.outcome()["outcome"] == "waiting"

    session._deadline = auth.time.time() - 1
    assert session.outcome()["outcome"] == "failed"

    monkeypatch.setattr(
        auth, "_antigravity_keyring_entries", lambda: ["gemini:antigravity"]
    )
    assert session.outcome()["outcome"] == "signed_in"


def test_signing_out_of_google_removes_the_shared_keyring_entry(monkeypatch):
    """
    There is no sign-out command either. The credential is the one Antigravity shares,
    so it is removed with the operating system's own tool and the answer says so.
    """

    class Done:
        returncode = 0
        stdout = "The command completed successfully.\n"
        stderr = ""

    monkeypatch.setattr(
        auth,
        "provider_cli",
        lambda provider, cli_path=None: {"path": "agy", "usable": True, "source": "path"},
    )
    monkeypatch.setattr(
        auth, "_antigravity_keyring_entries", lambda: ["gemini:antigravity"]
    )
    monkeypatch.setattr(auth, "auth_status", lambda provider, cli_path=None: {})
    monkeypatch.setattr(auth.subprocess, "run", lambda *a, **k: Done())

    result = auth.logout("google")
    assert result["ok"] is True
    assert "shared Antigravity credential" in result["message"]


def test_signing_out_of_google_when_there_is_nothing_to_sign_out_of(monkeypatch):
    monkeypatch.setattr(
        auth,
        "provider_cli",
        lambda provider, cli_path=None: {"path": "agy", "usable": True, "source": "path"},
    )
    monkeypatch.setattr(auth, "_antigravity_keyring_entries", lambda: [])
    monkeypatch.setattr(auth, "auth_status", lambda provider, cli_path=None: {})

    result = auth.logout("google")
    assert result["ok"] is True
    assert "nothing to sign out of" in result["message"]


def test_the_google_account_email_is_read_from_the_clis_own_file(monkeypatch, tmp_path):
    """Only the address is read, so the panel can name the account a plan belongs to."""
    gemini_dir = tmp_path / ".gemini"
    gemini_dir.mkdir()
    (gemini_dir / "google_accounts.json").write_text(
        json.dumps({"active": "someone@example.com", "old": []}), encoding="utf-8"
    )
    monkeypatch.setattr(auth.os.path, "expanduser", lambda value: str(tmp_path))

    assert auth._google_account() == "someone@example.com"


def test_a_missing_google_account_file_is_not_an_error(monkeypatch, tmp_path):
    monkeypatch.setattr(auth.os.path, "expanduser", lambda value: str(tmp_path))
    assert auth._google_account() is None

