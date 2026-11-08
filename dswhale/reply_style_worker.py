"""One request, one response: the isolated regex worker.

Only stdlib and ``reply_style_ops`` are imported here. The parent process never
executes a user-supplied regular expression; it starts this file with a hard
deadline and kills/reaps it on timeout.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dswhale import reply_style_ops  # noqa: E402


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    try:
        request = json.loads(sys.stdin.read() or "{}")
    except Exception:
        print(json.dumps({"ok": False, "error": "invalid"}))
        return 2
    try:
        op = request.get("op")
        if op == "custom":
            value = reply_style_ops.custom_plan(
                request.get("text", ""),
                request.get("regex", ""),
                request.get("cleanup", ""),
                int(request.get("maxBubbles", 3)),
            )
        elif op == "host":
            value = reply_style_ops.host_preview(request.get("text", ""), request.get("host"))
        else:
            raise ValueError("unsupported operation")
        print(json.dumps({"ok": True, "value": value}, ensure_ascii=False))
        return 0
    except Exception as error:
        print(
            json.dumps(
                {"ok": False, "error": type(error).__name__, "message": str(error)[:500]},
                ensure_ascii=False,
            )
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
