import json
import os
import fcntl
import uuid
from contextlib import contextmanager
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
        return {"delivered_slots": {}, "checked_empty_slots": {}, "test_deliveries": [], "claims": {}}
    value = json.loads(path.read_text(encoding="utf-8"))
    value.setdefault("delivered_slots", {})
    value.setdefault("checked_empty_slots", {})
    value.setdefault("test_deliveries", [])
    value.setdefault("claims", {})
    return value


def save_state(state: dict[str, Any], path: Path = STATE_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    temporary.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)
    os.chmod(path, 0o600)


@contextmanager
def locked_state(path: Path = STATE_PATH):
    lock_path = path.with_name(f"{path.name}.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+", encoding="utf-8") as lock:
        os.chmod(lock_path, 0o600)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        state = load_state(path)
        try:
            yield state
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def claim_delivery(test: bool, slot: str, *, state_path: Path = STATE_PATH, now: datetime | None = None) -> dict[str, str] | None:
    now = now or datetime.now(tz=ZoneInfo("UTC"))
    key = "test" if test else slot
    with locked_state(state_path) as state:
        if test and state["test_deliveries"]:
            return None
        if not test and (slot in state["delivered_slots"] or slot in state["checked_empty_slots"]):
            return None
        existing = state["claims"].get(key)
        if existing:
            claimed_at = datetime.fromisoformat(existing["claimed_at"])
            if now - claimed_at < timedelta(minutes=15):
                return None
        token = {"key": key, "id": uuid.uuid4().hex, "claimed_at": now.isoformat(), "slot": slot, "test": str(test)}
        state["claims"][key] = token
        save_state(state, state_path)
        return token


def release_claim(token: dict[str, str], *, state_path: Path = STATE_PATH) -> None:
    with locked_state(state_path) as state:
        if state["claims"].get(token["key"], {}).get("id") == token["id"]:
            state["claims"].pop(token["key"], None)
            save_state(state, state_path)


def complete_claim(token: dict[str, str], entry: dict[str, Any], *, state_path: Path = STATE_PATH, empty: bool = False) -> None:
    with locked_state(state_path) as state:
        if state["claims"].get(token["key"], {}).get("id") != token["id"]:
            raise RuntimeError("digest delivery claim was lost")
        if token["test"] == "True":
            state["test_deliveries"].append(entry)
        elif empty:
            state["checked_empty_slots"][token["slot"]] = entry
        else:
            state["delivered_slots"][token["slot"]] = entry
        state["claims"].pop(token["key"], None)
        save_state(state, state_path)


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
    claim_token: dict[str, str] | None = None,
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
    entry = {
        "pair_ids": [str(pair.get("pair_id", "")) for pair in conflicts],
        "sent_at": (now or datetime.now(tz=ZoneInfo("UTC"))).isoformat(),
    }
    if test:
        entry["slot"] = slot
    if claim_token:
        complete_claim(claim_token, entry, state_path=state_path)
    else:
        with locked_state(state_path) as state:
            if test:
                state["test_deliveries"].append(entry)
            else:
                state["delivered_slots"][slot] = entry
            save_state(state, state_path)
    return True


async def send_digest(
    *,
    test: bool = False,
    max_items: int | None = None,
    now: datetime | None = None,
    state_path: Path = STATE_PATH,
) -> bool:
    from helpers import plugins
    from plugins._email_integration.helpers.smtp_client import send_reply

    config = plugins.get_plugin_config("arcrift_memory") or {}
    email_config = plugins.get_plugin_config("_email_integration") or {}
    timezone = str(config.get("digest_timezone", "America/Chicago"))
    hours = list(config.get("digest_hours", [8, 18]))
    now = now or datetime.now(tz=ZoneInfo("UTC"))
    slot = current_slot(now, timezone, hours)
    claim = claim_delivery(test, slot, state_path=state_path, now=now)
    if claim is None:
        return False
    try:
        configured_limit = max(1, min(int(config.get("digest_max_conflicts", 10)), 10))
        limit = max(1, min(max_items if max_items is not None else configured_limit, configured_limit))
        conflicts = await call_memory_tool("memory_conflicts", {"limit": limit}, timeout_seconds=15)
        if not isinstance(conflicts, list):
            raise ValueError("memory_conflicts returned a non-list result")
        conflicts = conflicts[:limit]
        if not conflicts:
            if not test:
                complete_claim(claim, {"checked_at": now.isoformat()}, state_path=state_path, empty=True)
            else:
                release_claim(claim, state_path=state_path)
            return False
        handler = select_handler(email_config, str(config.get("digest_handler_name", "")))
        sent = await deliver_digest(
            conflicts, handler, slot=slot, test=test, send=send_reply,
            state_path=state_path, now=now, claim_token=claim,
        )
        if not sent:
            release_claim(claim, state_path=state_path)
        return sent
    except Exception:
        release_claim(claim, state_path=state_path)
        raise


async def send_test_digest_once(*, max_items: int = 2, state_path: Path = STATE_PATH) -> bool:
    if load_state(state_path)["test_deliveries"]:
        return False
    return await send_digest(test=True, max_items=min(max_items, 2), state_path=state_path)


async def run_digest_tick(now: datetime | None = None) -> bool:
    from helpers import plugins

    config = plugins.get_plugin_config("arcrift_memory") or {}
    if not config.get("enabled", True) or not config.get("digest_enabled", False):
        return False
    return await send_digest(now=now)
