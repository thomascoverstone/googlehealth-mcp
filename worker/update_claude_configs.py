"""
Point Claude Code at the remote Google Health MCP worker.  Called by
deploy.ps1; safe to run by hand:

    python update_claude_configs.py https://<worker>/mcp/<key>

Claude Desktop chat and the phone app pick the server up through the claude.ai
custom connector instead, so nothing is written to claude_desktop_config.json.
"""
from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path


def main(mcp_url: str) -> int:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    cc = Path.home() / ".claude.json"
    if not cc.exists():
        print(f"  Claude Code config not found at {cc}; skipped")
        return 0
    shutil.copy2(cc, cc.with_name(f".claude.json.bak-{stamp}"))
    data = json.loads(cc.read_text(encoding="utf-8"))
    data.setdefault("mcpServers", {})["googlehealth"] = {"type": "http", "url": mcp_url}
    cc.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  Claude Code: mcpServers.googlehealth -> {mcp_url}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2 or not sys.argv[1].startswith("https://"):
        print("usage: update_claude_configs.py https://<worker>/mcp/<access-key>")
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
