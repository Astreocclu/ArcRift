import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Awaitable, Callable
from zoneinfo import ZoneInfo

from .client import call_memory_tool


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
STATE_PATH = PLUGIN_ROOT / "state.json"


def current_slot(now: datetime, timezone: str, hours: list[int]) -> str:
    local = now.astimezone(ZoneInfo(timezone))
    normalized = sorted({int(hour) for hour in hours if 0 <= int(hour) <= 23})
    if not normalized:
        raise ValueError("digest_hours must contain at least one hour")
    eligible = [hour for hour in normalized if hour <= local.hour]
    if eligible:
        slot_date, slot_hour = local.date(), eligible[-1]
    else:
        slot_date, slot_hour = (local - timedelta(days=1)).date(), normalized[-1]
    return f"{slot_date.isoformat()}T{slot_hour:02d}:00"


def load_state(path: Path = STATE_PATH) -> dict[str, Any]:
    if not path.exists():
        return {"delivered_slots": {}, "checked_empty_slots": {}, "test_deliveries": []}
    value = json.loads(path.read_text(encoding="utf-8"))
    value.setdefault("delivered_slots", {})
    value.setdefault("checked_empty_slots", {})
    value.setdefault("test_deliveries", [])
    return value


def save_state(state: dict[str, Any], path: Path = STATE_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    temporary.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)
    os.chmod(path, 0o600)


def select_handler(email_config: dict[str, Any], name: str) -> dict[str, Any]:
    handlers = email_config.get("handlers", [])
    matches = [handler for handler in handlers if handler.get("name") == name] if name else []
    if len(matches) != 1:
        raise ValueError("digest_handler_name must identify exactly one configured email handler")
    handler = matches[0]
    if not handler.get("smtp_server") or not handler.get("username") or not handler.get("password"):
        raise ValueError("selected email handler has incomplete SMTP settings")
    return handler


def format_digest(conflicts: list[dict[str, Any]], slot: str, *, test: bool) -> str:
    heading = "ArcRift conflict digest test" if test else f"ArcRift conflict digest for {slot} CT"
    lines = [heading, "", "Resolve these through the authenticated memory_resolve_conflict tool."]
    for index, pair in enumerate(conflicts, start=1):
        lines.extend([
            "",
            f"{index}. Pair {pair.get('pair_id', '')}",
            f"OLD: {str(pair.get('old_text', ''))[:1200]}",
            f"NEW: {str(pair.get('new_text', ''))[:1200]}",
        ])
    return "\n".join(lines)


async def deliver_digest(
    conflicts: list[dict[str, Any]],
    handler: dict[str, Any],
    *,
    slot: str,
    test: bool,
    send: Callable[..., Awaitable[str | None]],
    state_path: Path = STATE_PATH,
    now: datetime | None = None,
) -> bool:
    from plugins._email_integration.helpers.smtp_client import SmtpConfig

    subject = "[ArcRift] Conflict digest test" if test else f"[ArcRift] Conflict digest {slot} CT"
    smtp = SmtpConfig(
        server=handler.get("smtp_server", handler.get("imap_server", "")),
        port=int(handler.get("smtp_port", 587)),
        username=handler["username"],
        password=handler["password"],
    )
    error = await send(config=smtp, to=handler["username"], subject=subject, body=format_digest(conflicts, slot, test=test))
    if error is not None:
        return False
    state = load_state(state_path)
    entry = {
        "pair_ids": [str(pair.get("pair_id", "")) for pair in conflicts],
        "sent_at": (now or datetime.now(tz=ZoneInfo("UTC"))).isoformat(),
    }
    if test:
        entry["slot"] = slot
        state["test_deliveries"].append(entry)
    else:
        state["delivered_slots"][slot] = entry
    save_state(state, state_path)
    return True


async def send_digest(*, test: bool = False, max_items: int | None = None, now: datetime | None = None) -> bool:
    from helpers import plugins
    from plugins._email_integration.helpers.smtp_client import send_reply

    config = plugins.get_plugin_config("arcrift_memory") or {}
    email_config = plugins.get_plugin_config("_email_integration") or {}
    timezone = str(config.get("digest_timezone", "America/Chicago"))
    hours = list(config.get("digest_hours", [8, 18]))
    now = now or datetime.now(tz=ZoneInfo("UTC"))
    slot = current_slot(now, timezone, hours)
    state = load_state()
    if not test and (slot in state["delivered_slots"] or slot in state["checked_empty_slots"]):
        return False
    configured_limit = max(1, min(int(config.get("digest_max_conflicts", 10)), 10))
    limit = max(1, min(max_items if max_items is not None else configured_limit, configured_limit))
    conflicts = await call_memory_tool("memory_conflicts", {"limit": limit}, timeout_seconds=15)
    if not isinstance(conflicts, list):
        raise ValueError("memory_conflicts returned a non-list result")
    conflicts = conflicts[:limit]
    if not conflicts:
        if not test:
            state["checked_empty_slots"][slot] = {"checked_at": now.isoformat()}
            save_state(state)
        return False
    handler = select_handler(email_config, str(config.get("digest_handler_name", "")))
    return await deliver_digest(conflicts, handler, slot=slot, test=test, send=send_reply, now=now)


async def run_digest_tick(now: datetime | None = None) -> bool:
    from helpers import plugins

    config = plugins.get_plugin_config("arcrift_memory") or {}
    if not config.get("enabled", True) or not config.get("digest_enabled", False):
        return False
    return await send_digest(now=now)
