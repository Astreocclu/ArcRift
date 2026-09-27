import asyncio
import importlib.util
import re
import sys
import types
from datetime import datetime
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "arcrift_memory"
sys.path.insert(0, str(ROOT))

from arcrift_memory.helpers.client import call_memory_tool, latest_exchange, proposal_key
from arcrift_memory.helpers import digest
from arcrift_memory.helpers.digest import current_slot, deliver_digest, load_state


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_latest_exchange_has_stable_message_idempotency():
    messages = [
        {"ai": False, "id": "u1", "content": "Please do this."},
        {"ai": True, "id": "a1", "content": "Done."},
    ]
    exchange = latest_exchange(messages)
    assert exchange == {"user_id": "u1", "assistant_id": "a1", "user": "Please do this.", "assistant": "Done."}
    assert proposal_key("ctx", exchange) == proposal_key("ctx", exchange)
    assert proposal_key("other", exchange) != proposal_key("ctx", exchange)


def test_latest_exchange_skips_mcp_results_and_extracts_a0_user_message():
    messages = [
        {"ai": False, "id": "u1", "content": {"user_message": "Find the routing decision."}},
        {"ai": True, "id": "a-tool", "content": '{"tool_name":"arcrift_memory_search"}'},
        {"ai": False, "id": "tool-result", "content": {"tool_name": "arcrift.memory_search", "tool_result": "large source text"}},
        {"ai": True, "id": "a-final", "content": "The decision is current."},
    ]
    assert latest_exchange(messages) == {
        "user_id": "u1",
        "assistant_id": "a-final",
        "user": "Find the routing decision.",
        "assistant": "The decision is current.",
    }


def test_proposal_extension_uses_a0_background_task():
    source = (PLUGIN / "extensions/python/monologue_end/_40_propose_exchange.py").read_text(encoding="utf-8")
    assert "DeferredTask(thread_name=THREAD_BACKGROUND)" in source
    assert "task.start_task(self._submit" in source
    assert "asyncio.create_task" not in source


def test_memory_tool_call_is_bounded_and_parses_json():
    class Config:
        async def call_tool(self, name, arguments):
            assert name == "arcrift.memory_propose"
            assert arguments == {"x": 1}
            return {"content": [{"text": '{"status":"shadow"}'}]}

    assert asyncio.run(call_memory_tool("memory_propose", {"x": 1}, config_override=Config(), timeout_seconds=0.1)) == {"status": "shadow"}

    class SlowConfig:
        async def call_tool(self, name, arguments):
            await asyncio.sleep(0.05)

    with pytest.raises(asyncio.TimeoutError):
        asyncio.run(call_memory_tool("memory_propose", {}, config_override=SlowConfig(), timeout_seconds=0.001))


def test_global_behaviour_layers_only_for_active_projects(monkeypatch):
    class Extension:
        def __init__(self, agent=None):
            self.agent = agent

    helper_module = types.ModuleType("helpers")
    extension_module = types.ModuleType("helpers.extension")
    extension_module.Extension = Extension
    helper_module.files = types.SimpleNamespace(
        get_abs_path=lambda *parts: "/".join(parts),
        exists=lambda path: True,
        read_file=lambda path: "GLOBAL RULES",
    )
    helper_module.plugins = types.SimpleNamespace(get_plugin_config=lambda *args, **kwargs: {"enabled": True})
    active = {"value": False}
    helper_module.projects = types.SimpleNamespace(get_context_project_name=lambda context: "project" if active["value"] else "")
    monkeypatch.setitem(sys.modules, "helpers", helper_module)
    monkeypatch.setitem(sys.modules, "helpers.extension", extension_module)
    module = load_module(PLUGIN / "extensions/python/system_prompt/_10_global_behaviour.py", "arcrift_global_behaviour_test")
    agent = types.SimpleNamespace(context=object(), read_prompt=lambda name, **kwargs: f"rendered:{kwargs['rules']}")
    extension = module.ArcRiftGlobalBehaviour(agent)
    prompts = []
    asyncio.run(extension.execute(prompts))
    assert prompts == []
    active["value"] = True
    asyncio.run(extension.execute(prompts))
    assert prompts == ["rendered:GLOBAL RULES"]


def install_smtp_stub(monkeypatch):
    plugins_pkg = types.ModuleType("plugins")
    email_pkg = types.ModuleType("plugins._email_integration")
    helpers_pkg = types.ModuleType("plugins._email_integration.helpers")
    smtp_module = types.ModuleType("plugins._email_integration.helpers.smtp_client")

    class SmtpConfig:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    smtp_module.SmtpConfig = SmtpConfig
    monkeypatch.setitem(sys.modules, "plugins", plugins_pkg)
    monkeypatch.setitem(sys.modules, "plugins._email_integration", email_pkg)
    monkeypatch.setitem(sys.modules, "plugins._email_integration.helpers", helpers_pkg)
    monkeypatch.setitem(sys.modules, "plugins._email_integration.helpers.smtp_client", smtp_module)


def test_digest_marks_only_after_smtp_success(tmp_path, monkeypatch):
    install_smtp_stub(monkeypatch)
    state_path = tmp_path / "state.json"
    conflicts = [{"pair_id": "p1", "old_text": "old", "new_text": "new"}]
    handler = {"smtp_server": "smtp.invalid", "smtp_port": 587, "username": "self@example.test", "password": "secret"}

    async def fail(**kwargs):
        return "smtp failed"

    assert not asyncio.run(deliver_digest(conflicts, handler, slot="2026-09-27T08:00", test=False, send=fail, state_path=state_path))
    assert not state_path.exists()

    async def succeed(**kwargs):
        assert kwargs["to"] == "self@example.test"
        return None

    assert asyncio.run(deliver_digest(conflicts, handler, slot="2026-09-27T08:00", test=False, send=succeed, state_path=state_path))
    assert load_state(state_path)["delivered_slots"]["2026-09-27T08:00"]["pair_ids"] == ["p1"]


def test_digest_slots_are_ct_and_twice_daily():
    assert current_slot(datetime.fromisoformat("2026-09-27T14:00:00+00:00"), "America/Chicago", [8, 18]) == "2026-09-27T08:00"
    assert current_slot(datetime.fromisoformat("2026-09-28T00:00:00+00:00"), "America/Chicago", [8, 18]) == "2026-09-27T18:00"


def test_digest_test_entrypoint_sends_at_most_once_and_caps_items(tmp_path, monkeypatch):
    state_path = tmp_path / "state.json"
    calls = []

    async def fake_send_digest(**kwargs):
        calls.append(kwargs)
        state_path.write_text('{"delivered_slots":{},"checked_empty_slots":{},"test_deliveries":[{"pair_ids":["p1"]}]}')
        return True

    monkeypatch.setattr(digest, "send_digest", fake_send_digest)
    assert asyncio.run(digest.send_test_digest_once(max_items=10, state_path=state_path))
    assert calls == [{"test": True, "max_items": 2, "state_path": state_path}]
    assert not asyncio.run(digest.send_test_digest_once(max_items=10, state_path=state_path))
    assert len(calls) == 1


def test_digest_claim_allows_only_one_overlapping_sender(tmp_path):
    state_path = tmp_path / "state.json"
    first = digest.claim_delivery(False, "2026-09-27T08:00", state_path=state_path)
    second = digest.claim_delivery(False, "2026-09-27T08:00", state_path=state_path)
    assert first
    assert second is None
    digest.release_claim(first, state_path=state_path)
    assert digest.claim_delivery(False, "2026-09-27T08:00", state_path=state_path)


def test_execute_entrypoint_adds_a0_root_before_plugin_import():
    source = (PLUGIN / "execute.py").read_text(encoding="utf-8")
    assert "Path(__file__).resolve().parents[3]" in source
    assert "!= PLUGIN_ROOT" in source
    assert 'MCPConfig.update(str(settings.get_settings().get("mcp_servers", "")))' in source
    assert source.index("sys.path.insert") < source.index("from usr.plugins.arcrift_memory")


def test_kernel_bytes_match_backend_surface():
    prompt_file = PLUGIN / "prompts/arcrift.memory.kernel.md"
    extension_file = PLUGIN / "extensions/python/system_prompt/_15_memory_kernel.py"
    if not prompt_file.exists():
        assert not extension_file.exists(), "a failed cleanroom eval must omit both A0 kernel surfaces"
        return
    backend = (ROOT.parents[1] / "backend/src/services/memory-kernel.ts").read_text(encoding="utf-8")
    match = re.search(r'MEMORY_KERNEL = "([^"]+)";', backend)
    assert match
    assert prompt_file.read_text(encoding="utf-8").rstrip("\n") == match.group(1)
    assert extension_file.exists()
