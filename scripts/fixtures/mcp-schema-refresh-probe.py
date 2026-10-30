"""Real Hermes imports, connections and A -> B -> A profile scopes; no model calls."""
import copy
import json
import os
from pathlib import Path
import sys

root = Path(sys.argv[1])
home = Path(sys.argv[2])
os.environ["HERMES_HOME"] = str(home)
sys.path.insert(0, str(root / "hermes"))
from gateway.run import _profile_runtime_scope
from tools import mcp_tool as core
from tools.mcp_tool_discovery import register_mcp_servers, reconcile_mcp_servers_with_config
from tools.mcp_tool_scope import _server_key
from tools.mcp_tool_lifecycle import shutdown_mcp_servers
from tools.mcp_schema_cache import config_fingerprint, write_cache_entry
from tools.registry import registry

def tool(name, properties):
    return {"name": name, "description": "Fixture query", "inputSchema": {
        "type": "object", "properties": properties, "additionalProperties": False}}

def profile(name, revision, tools):
    directory = home / "profiles" / name
    directory.mkdir(parents=True)
    manifest = directory / "tools.json"
    manifest.write_text(json.dumps(tools))
    counter = directory / "starts"
    config = {"command": sys.executable, "cwd": str(root), "args": [str(root / "scripts/fixtures/mcp-schema-server.py"),
        str(manifest), str(counter), "--tool-revision", revision]}
    write_config(directory, config)
    return directory, manifest, counter, config

def write_config(directory, config):
    # JSON is YAML, so this exercises Hermes' real config loader too.
    (directory / "config.yaml").write_text(json.dumps({"mcp_servers": {"data": config}}))

old = tool("monthly", {"start_date": {"type": "string"}, "end_date": {"type": "string"}})
new = tool("monthly", {"month_count": {"type": "integer"}, "include_current": {"type": "boolean"}})
a, manifest, starts, cfg = profile("a", "old", [old, tool("old_alias", {})])
b, _, bstarts, bcfg = profile("b", "b", [tool("private_b", {"b": {"type": "string"}})])
name = "mcp__data__monthly"

try:
    with _profile_runtime_scope(a):
        register_mcp_servers({"data": cfg})
        assert set(registry.get_schema(name)["parameters"]["properties"]) == {"start_date", "end_date"}
    with _profile_runtime_scope(b):
        register_mcp_servers({"data": bcfg})
        assert registry.get_schema("mcp__data__private_b") is not None
        assert registry.get_schema(name) is None
    with _profile_runtime_scope(a):
        register_mcp_servers({"data": cfg})
        assert starts.read_text() == "1", "Unchanged profile must reuse its live connection"
        manifest.write_text(json.dumps([new, tool("explicit", {})]))
        updated = copy.deepcopy(cfg)
        updated["args"][-1] = "new"
        write_config(a, updated)
        register_mcp_servers({"data": updated})
        refreshed = registry.get_schema(name)
        assert refreshed is not None, "Changed own connection left the profile tool-less"
        assert set(refreshed["parameters"]["properties"]) == {"month_count", "include_current"}, "Changed same-name query still exposes stale parameters"
        assert registry.get_schema("mcp__data__old_alias") is None, "Removed alias survived refresh"
        assert registry.get_schema("mcp__data__explicit") is not None
        assert starts.read_text() == "2"
        register_mcp_servers({"data": updated})
        assert starts.read_text() == "2"
        # Housekeeping reconciliation must also notice an edited, already-connected server.
        manifest.write_text(json.dumps([tool("monthly", {"newer": {"type": "number"}})]))
        newer = copy.deepcopy(updated)
        newer["args"][-1] = "newer"
        write_config(a, newer)
        result = reconcile_mcp_servers_with_config()
        assert result["removed"] == ["data"] and result["added"] == ["data"], result
        assert set(registry.get_schema(name)["parameters"]["properties"]) == {"newer"}
        assert starts.read_text() == "3"
        # A stored manifest can be reused lazily, but a changed revision must discard
        # its old parameter definitions before the first call, without an inference retry.
        shutdown_mcp_servers(scope=core._mcp_registry_scope(), names={"data"})
        # Arrange a prior-process manifest through the production disk-cache writer.
        write_cache_entry("data", config_fingerprint(newer), tools=json.loads(manifest.read_text()))
        lazy = copy.deepcopy(newer)
        lazy["lazy"] = True
        write_config(a, lazy)
        register_mcp_servers({"data": lazy})
        assert _server_key("data") in core._lazy_server_configs
        assert starts.read_text() == "3"
        # The schema fingerprint intentionally excludes credentials, but the pending
        # connection config must still pick up new authentication before it connects.
        reauthed = copy.deepcopy(lazy)
        reauthed["env"] = {"FIXTURE_ACCOUNT": "new-account"}
        write_config(a, reauthed)
        register_mcp_servers({"data": reauthed})
        assert core._lazy_server_configs[_server_key("data")]["env"] == reauthed["env"]
        manifest.write_text(json.dumps([tool("monthly", {"latest": {"type": "string"}})]))
        latest = copy.deepcopy(reauthed)
        latest["args"][-1] = "latest"
        write_config(a, latest)
        register_mcp_servers({"data": latest})
        assert set(registry.get_schema(name)["parameters"]["properties"]) == {"latest"}
        assert starts.read_text() == "4"
    with _profile_runtime_scope(b):
        register_mcp_servers({"data": bcfg})
        assert registry.get_schema("mcp__data__private_b") is not None
        assert registry.get_schema(name) is None
        assert bstarts.read_text() == "1", "Changing A must not disconnect independently configured B"
        reply = registry.dispatch("mcp__data__private_b", {"b": "still-b"})
        body = json.loads(json.loads(reply)["result"])
        assert body["profile"] == "b" and body["call"]["arguments"] == {"b": "still-b"}, body
    # C can adopt B's identical connection. Moving C to its own revision must
    # detach only C's overlay, leaving the original owner B connected and callable.
    c, cmanifest, cstarts, ccfg = profile("c", "c", [tool("c_only", {})])
    write_config(c, bcfg)
    with _profile_runtime_scope(c):
        register_mcp_servers({"data": bcfg})
        assert registry.get_schema("mcp__data__private_b") is not None
        assert _server_key("data") not in core._servers, "Fixture did not adopt B's existing connection"
        write_config(c, ccfg)
        register_mcp_servers({"data": ccfg})
        assert registry.get_schema("mcp__data__private_b") is None
        assert registry.get_schema("mcp__data__c_only") is not None
        assert cstarts.read_text() == "1"
    with _profile_runtime_scope(b):
        register_mcp_servers({"data": bcfg})
        assert bstarts.read_text() == "1"
        assert registry.get_schema("mcp__data__private_b") is not None
        assert registry.get_schema("mcp__data__c_only") is None
    # D adopts C's connection. Replacing the owner's route may transiently
    # orphan D, but lifecycle recovery must restore D from D's old definition,
    # never from C's changed schema/config. No accepted RPC is retried.
    d, _, _, _ = profile("d", "unused", [])
    write_config(d, ccfg)
    with _profile_runtime_scope(d):
        register_mcp_servers({"data": ccfg})
        assert _server_key("data") not in core._servers
        assert registry.get_schema("mcp__data__c_only") is not None
    cnext = copy.deepcopy(ccfg)
    next_manifest = c / "next-tools.json"
    next_manifest.write_text(json.dumps([tool("c_new", {})]))
    cnext["args"][1] = str(next_manifest)
    cnext["args"][-1] = "c-next"
    write_config(c, cnext)
    with _profile_runtime_scope(c):
        register_mcp_servers({"data": cnext})
        assert registry.get_schema("mcp__data__c_new") is not None
        assert registry.get_schema("mcp__data__c_only") is None
    with _profile_runtime_scope(d):
        register_mcp_servers({"data": ccfg})
        assert registry.get_schema("mcp__data__c_only") is not None
        assert registry.get_schema("mcp__data__c_new") is None
    print(json.dumps({"ok": True, "a_connections": 4, "b_connections": 1, "real_profile_scopes": "A-B-A-B"}))
finally:
    shutdown_mcp_servers()
