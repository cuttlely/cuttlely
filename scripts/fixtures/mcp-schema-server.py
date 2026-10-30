"""Tiny deterministic stdio MCP server used by the schema-refresh integration test."""
import json
from pathlib import Path
import sys

manifest = Path(sys.argv[1])
counter = Path(sys.argv[2])
counter.write_text(str(int(counter.read_text()) + 1) if counter.exists() else "1")
for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request.get("method")
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                  "serverInfo": {"name": "schema-fixture", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": json.loads(manifest.read_text())}
    elif method == "tools/call":
        result = {"content": [{"type": "text", "text": json.dumps({
            "profile": manifest.parent.name, "call": request.get("params", {})})}]}
    elif method == "ping":
        result = {}
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Unknown method"}}), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
