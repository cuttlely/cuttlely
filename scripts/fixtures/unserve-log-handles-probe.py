"""Probe for scripts/hermes-unserve-log-handles.test.mjs. Isolated HOME/HERMES_HOME required."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, sys.argv[1])

from hermes_constants import hermes_home_key, set_hermes_home_override, reset_hermes_home_override
import hermes_logging as hl
from gateway.run_profile_reconcile import GatewayProfileReconcileMixin
import gateway.run as gateway_run
from tools.mcp_tool_config import _get_mcp_stderr_log, _mcp_stderr_log_fh
import tools.mcp_tool as mcp_tool
from tools.mcp_tool_lifecycle import shutdown_mcp_servers

CYCLES = 8
LOG_NAMES = ("agent.log", "gateway.log", "mcp-stderr.log")


def log_targets(root: Path) -> list[str]:
    hits = []
    prefix = str(root.resolve())
    for name in os.listdir("/proc/self/fd"):
        try:
            target = os.readlink(f"/proc/self/fd/{name}")
        except OSError:
            continue
        if not (target == prefix or target.startswith(prefix + "/") or target.startswith(prefix + " ")):
            continue
        base = target.split(" (deleted)", 1)[0]
        if Path(base).name in LOG_NAMES:
            hits.append(target)
    return sorted(hits)


def count_named(targets: list[str], home: Path, filename: str) -> int:
    needle = str((home / "logs" / filename).resolve())
    return sum(1 for t in targets if t == needle or t.startswith(needle + " "))


def drain() -> None:
    # Flush routed handlers. Do not call drain_log_queue(): it stops the
    # QueueListener and is meant for process-exit paths, not live emits.
    time.sleep(0.1)
    for handler in list(getattr(hl, "_queued_file_handlers", [])):
        try:
            handler.flush()
        except Exception:
            pass
        inners = getattr(handler, "_profile_handlers", None)
        if isinstance(inners, dict):
            for inner in list(inners.values()):
                try:
                    inner.flush()
                except Exception:
                    pass
    time.sleep(0.05)


def emit(home: Path, logger_name: str, message: str) -> None:
    logger = logging.getLogger(logger_name)
    record = logger.makeRecord(logger_name, logging.INFO, __file__, 0, message, (), None)
    record.hermes_home = str(home)
    logger.handle(record)
    drain()


def open_mcp_stderr(home: Path):
    token = set_hermes_home_override(str(home))
    try:
        return _get_mcp_stderr_log()
    finally:
        reset_hermes_home_override(token)


class DummyServer:
    def __init__(self, name: str):
        self.name = name
        self.closed = False

    async def shutdown(self):
        self.closed = True


class Runner(GatewayProfileReconcileMixin):
    def __init__(self, launch: Path):
        self._running = True
        self._primary_profile_name = "default"
        self._served_profile_homes = {"default": launch}
        self._served_profile_signatures = {}
        self._profile_adapters = {}
        self._agent_cache = {}
        self._profile_failed_platforms = {}
        self.config = SimpleNamespace(multiplex_profiles=True)

    def _multiplex_on(self):
        return True

    def _adapter_disconnect_timeout_secs(self):
        return 0.1

    async def _bounded_adapter_teardown(self, adapter, platform, profile=None):
        return None

    def _evict_cached_agent(self, key):
        if isinstance(self._agent_cache, dict):
            self._agent_cache.pop(key, None)

    def _record_served_profiles(self, active, items):
        self._note_served_profiles(items)

    def _live_resource_claims(self, active):
        return {}


def prepare_home(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    (path / "logs").mkdir(exist_ok=True)
    (path / ".env").write_text("", encoding="utf-8")
    if not (path / "config.yaml").exists():
        (path / "config.yaml").write_text("gateway: {}\n", encoding="utf-8")
    return path


def register_server(name: str, home: Path) -> DummyServer:
    scope = hermes_home_key(home)
    key = (scope, name)
    server = DummyServer(name)
    with mcp_tool._lock:
        mcp_tool._servers[key] = server
        mcp_tool._server_scope_keys[key] = scope
    return server


def server_present(name: str, home: Path) -> bool:
    scope = hermes_home_key(home)
    key = (scope, name)
    with mcp_tool._lock:
        return key in mcp_tool._servers and mcp_tool._server_scope_keys.get(key) == scope


def start_mcp_loop() -> None:
    if getattr(mcp_tool, "_mcp_loop", None) is not None and mcp_tool._mcp_loop.is_running():
        return
    loop = asyncio.new_event_loop()

    def run():
        asyncio.set_event_loop(loop)
        loop.run_forever()

    thread = threading.Thread(target=run, name="mcp-test-loop", daemon=True)
    thread.start()
    # Wait until the loop is running so shutdown_mcp_servers can schedule work.
    deadline = time.time() + 2
    while not loop.is_running() and time.time() < deadline:
        time.sleep(0.01)
    mcp_tool._mcp_loop = loop


def serve_profile(runner: Runner, name: str, home: Path) -> DummyServer:
    prepare_home(home)
    runner._served_profile_homes[name] = home
    runner._profile_adapters.setdefault(name, {})
    hl.enable_profile_log_routing([Path(h) for h in runner._served_profile_homes.values()])
    open_mcp_stderr(home)
    emit(home, "gateway", f"serve {name}")
    emit(home, "hermes.test", f"serve {name} agent")
    return register_server(f"{name}-server", home)


async def unserve(runner: Runner, name: str) -> Path:
    home = runner._served_profile_homes[name]
    await runner._unserve_profile(name, home)
    return home


async def unserve_via_reconcile(runner: Runner, name: str) -> Path:
    home = runner._served_profile_homes[name]
    current = {n: p for n, p in runner._served_profile_homes.items() if n != name}
    await runner._apply_profile_changes(current, [], [name], [], reason="test-reconcile")
    return home


def close_and_remove(home: Path) -> None:
    drain()
    shutil.rmtree(home, ignore_errors=True)


async def main() -> None:
    root = Path(os.environ["HERMES_HOME"]).resolve()
    launch = root
    sibling = root / "profiles" / "sibling"
    prepare_home(launch)
    prepare_home(sibling)

    gateway_run._write_runtime_status_quiet = lambda *a, **k: None
    hl.setup_logging(hermes_home=launch, mode="gateway", force=True)
    start_mcp_loop()

    runner = Runner(launch)
    sibling_server = serve_profile(runner, "sibling", sibling)
    open_mcp_stderr(launch)
    drain()

    # Warm the routing handlers and MCP loop once, then discard a scratch profile.
    warm = root / "profiles" / "trywarm"
    serve_profile(runner, "trywarm", warm)
    await unserve(runner, "trywarm")
    close_and_remove(warm)
    drain()
    baseline = log_targets(root)
    baseline_counts = {
        "all": len(baseline),
        "sibling_agent": count_named(baseline, sibling, "agent.log"),
        "sibling_gateway": count_named(baseline, sibling, "gateway.log"),
        "sibling_mcp": count_named(baseline, sibling, "mcp-stderr.log"),
    }

    cycle_growth = []
    for i in range(CYCLES):
        name = f"try{i:04d}"
        home = root / "profiles" / name
        serve_profile(runner, name, home)
        await unserve(runner, name)
        close_and_remove(home)
        drain()
        after = log_targets(root)
        cycle_growth.append(
            {
                "left": [t for t in after if f"/profiles/{name}/" in t],
                "all": len(after) - baseline_counts["all"],
            }
        )

    after_cycles = log_targets(root)
    leftover = [t for t in after_cycles if "/profiles/try" in t and "/profiles/trywarm/" not in t]

    # Sibling must still be writable and its MCP server must still be connected.
    def sibling_wrote(marker: str) -> bool:
        emit(sibling, "gateway", marker)
        log_path = sibling / "logs" / "gateway.log"
        for _ in range(30):
            drain()
            if log_path.exists() and marker in log_path.read_text(encoding="utf-8", errors="replace"):
                return True
            time.sleep(0.05)
        return False


    sibling_after = log_targets(root)
    sibling_alive = {
        "server_connected": server_present("sibling-server", sibling) and not sibling_server.closed,
        "stderr_open": count_named(sibling_after, sibling, "mcp-stderr.log") >= 1,
        "agent_open": count_named(sibling_after, sibling, "agent.log") >= 1,
        "gateway_open": count_named(sibling_after, sibling, "gateway.log") >= 1,
        "log_grew": sibling_wrote(f"sibling-after-cycles-{time.time_ns()}"),
    }

    # Reconcile path: serve a victim, unserve through _apply_profile_changes, rmtree.
    victim_name = "tryreconcile"
    victim = root / "profiles" / victim_name
    victim_server = serve_profile(runner, victim_name, victim)
    await unserve_via_reconcile(runner, victim_name)
    close_and_remove(victim)
    drain()
    after_recon = log_targets(root)
    reconcile = {
        "victim_left": [t for t in after_recon if f"/profiles/{victim_name}/" in t],
        "victim_server_gone": not server_present("tryreconcile-server", victim) and victim_server.closed,
        "sibling_server_connected": server_present("sibling-server", sibling) and not sibling_server.closed,
        "sibling_log_grew": sibling_wrote(f"sibling-after-reconcile-{time.time_ns()}"),
        "sibling_stderr_open": count_named(after_recon, sibling, "mcp-stderr.log") >= 1,
    }

    # Safety: a scoped shutdown must not be callable as a wildcard from this path.
    # Re-read the production source and confirm the call site always passes scope=.
    source = Path(sys.argv[1], "gateway/run_profile_reconcile.py").read_text(encoding="utf-8")
    start = source.index("async def _unserve_profile")
    end = source.index("\n    def _profile_lifecycle_verb", start) if "\n    def _profile_lifecycle_verb" in source else source.index("def _profile_lifecycle_verb", start)
    body = source[start:end]
    calls = [line.strip() for line in body.splitlines() if "shutdown_mcp_servers(" in line and not line.strip().startswith("#")]
    safety = {
        "calls_release": "release_profile_log_handlers(home)" in body,
        "scoped_shutdown": "shutdown_mcp_servers(scope=hermes_home_key(home))" in body,
        "no_bare_shutdown": all("shutdown_mcp_servers()" not in line for line in calls),
        "no_scope_none": all("scope=None" not in line for line in calls),
    }

    final = log_targets(root)
    print(
        json.dumps(
            {
                "baseline": baseline_counts,
                "final_all": len(final),
                "growth": len(final) - baseline_counts["all"],
                "leftover": leftover,
                "cycle_growth": cycle_growth,
                "sibling": sibling_alive,
                "reconcile": reconcile,
                "safety": safety,
            }
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
