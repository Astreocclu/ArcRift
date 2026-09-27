import asyncio
import json
import sys
from pathlib import Path


A0_ROOT = str(Path(__file__).resolve().parents[3])
PLUGIN_ROOT = str(Path(__file__).resolve().parent)
sys.path = [entry for entry in sys.path if str(Path(entry or ".").resolve()) != PLUGIN_ROOT]
if A0_ROOT not in sys.path:
    sys.path.insert(0, A0_ROOT)


def main() -> None:
    from helpers import settings
    from helpers.mcp_handler import MCPConfig
    from usr.plugins.arcrift_memory.helpers.digest import send_test_digest_once

    MCPConfig.update(str(settings.get_settings().get("mcp_servers", "")))
    sent = asyncio.run(send_test_digest_once(max_items=2))
    print(json.dumps({"ok": True, "sent": sent}))


if __name__ == "__main__":
    main()
