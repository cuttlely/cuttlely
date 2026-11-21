"""Background gateway MCP discovery and profile-local first-run readiness."""

import asyncio
import threading
import time
from contextlib import nullcontext
from contextvars import copy_context
from pathlib import Path

from hermes_constants import hermes_home_key

# Published before adapters start, including profiles queued behind the concurrency cap.
_pending = {}


def wait_for_gateway_mcp_discovery() -> bool:
    """Wait only for this profile's boot pass, within the existing API-run wait bound.

    Return False when boot no longer owns discovery so the normal on-demand gate can
    handle new or changed servers. A timed-out boot wait must not start a duplicate pass.
    """
    event = _pending.get(hermes_home_key())
    if event is None:
        return False
    from hermes_cli.mcp_startup import _resolve_discovery_timeout
    event.wait(_resolve_discovery_timeout(None, single_query=True))
    return True


class GatewayMCPDiscovery:
    def __init__(self, profiles, profile_scope, logger):
        self.profiles = profiles
        self.profile_scope = profile_scope
        self.logger = logger
        self.events = {hermes_home_key(home): threading.Event() for _, home in profiles}
        _pending.update(self.events)
        self.task = None

    def start(self):
        self.task = asyncio.create_task(self._run(), name="gateway-mcp-discovery")

    def _discover(self, name, home):
        started = time.monotonic()
        status = []
        self.logger.info("MCP discovery start for profile '%s'", name)
        try:
            from tools.mcp_oauth import suppress_interactive_oauth
            from tools.mcp_tool_discovery import discover_mcp_tools, get_mcp_status

            scope = self.profile_scope(Path(home)) if self.profile_scope else nullcontext()
            with scope, suppress_interactive_oauth():
                try:
                    discover_mcp_tools()
                finally:
                    status = get_mcp_status()
        except Exception:
            self.logger.warning("MCP discovery failed for profile '%s'", name, exc_info=True)
        finally:
            failed = [s["name"] for s in status
                      if not s["disabled"] and s["status"] not in ("connected", "lazy")]
            for server in failed:
                self.logger.warning("MCP discovery failed for profile '%s', server '%s'", name, server)
            self.logger.info(
                "MCP discovery end for profile '%s': %d tools, failed servers: %s, elapsed %.2fs",
                name, sum(s["tools"] for s in status), ", ".join(failed) or "none",
                time.monotonic() - started)
            key = hermes_home_key(home)
            if _pending.get(key) is self.events[key]:
                _pending.pop(key, None)
            self.events[key].set()

    async def _run(self):
        semaphore = asyncio.Semaphore(4)

        async def discover(name, home):
            async with semaphore:
                await asyncio.get_running_loop().run_in_executor(
                    None, copy_context().run, self._discover, name, home)

        try:
            await asyncio.gather(*(discover(name, home) for name, home in self.profiles))
        except Exception:
            self.logger.warning("Gateway MCP discovery task failed", exc_info=True)

    async def stop(self):
        if self.task is not None:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        for key, event in self.events.items():
            event.set()
            if _pending.get(key) is event:
                _pending.pop(key, None)
