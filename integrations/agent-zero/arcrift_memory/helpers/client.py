import asyncio
import hashlib
import json
from typing import Any


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(part for part in (_text(item) for item in value) if part)
    if isinstance(value, dict):
        if "raw_content" in value:
            return _text(value["raw_content"])
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return "" if value is None else str(value)


def latest_exchange(messages: list[dict[str, Any]]) -> dict[str, str] | None:
    assistant_index = next((i for i in range(len(messages) - 1, -1, -1) if messages[i].get("ai") is True), None)
    if assistant_index is None:
        return None
    user_index = next((i for i in range(assistant_index - 1, -1, -1) if messages[i].get("ai") is False), None)
    if user_index is None:
        return None
    user = messages[user_index]
    assistant = messages[assistant_index]
    user_text = _text(user.get("content")).strip()
    assistant_text = _text(assistant.get("content")).strip()
    if not user_text or not assistant_text:
        return None
    return {
        "user_id": str(user.get("id") or user.get("sequence") or hashlib.sha256(user_text.encode()).hexdigest()[:16]),
        "assistant_id": str(assistant.get("id") or assistant.get("sequence") or hashlib.sha256(assistant_text.encode()).hexdigest()[:16]),
        "user": user_text,
        "assistant": assistant_text,
    }


def proposal_key(context_id: str, exchange: dict[str, str]) -> str:
    raw = f"{context_id}\0{exchange['user_id']}\0{exchange['assistant_id']}"
    return "a0:" + hashlib.sha256(raw.encode()).hexdigest()


def proposal_content(exchange: dict[str, str]) -> str:
    return json.dumps(
        {"user": exchange["user"], "assistant": exchange["assistant"]},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _result_text(result: Any) -> str:
    content = result.get("content", []) if isinstance(result, dict) else getattr(result, "content", [])
    parts: list[str] = []
    for item in content or []:
        text = item.get("text") if isinstance(item, dict) else getattr(item, "text", None)
        if isinstance(text, str):
            parts.append(text)
    return "\n".join(parts)


async def call_memory_tool(
    tool: str,
    arguments: dict[str, Any],
    *,
    agent: Any = None,
    timeout_seconds: float = 15,
    config_override: Any = None,
) -> Any:
    if config_override is None:
        from helpers import plugins
        from helpers.mcp_handler import MCPConfig

        settings = plugins.get_plugin_config("arcrift_memory", agent=agent) or {}
        server_name = str(settings.get("mcp_server_name", "arcrift")).strip() or "arcrift"
        config = MCPConfig.get_for_agent(agent) if agent is not None else MCPConfig.get_instance()
    else:
        config = config_override
        server_name = "arcrift"
    result = await asyncio.wait_for(config.call_tool(f"{server_name}.{tool}", arguments), timeout=timeout_seconds)
    text = _result_text(result)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text
