"""cuttlely patch: startup retries for an MCP server that lists no tools or cannot be reached,
and the flag that keeps an expected analyst result off the circuit breaker.

The harness gateway can be a couple of seconds behind Hermes. A tools/list in that window
used to register zero tools for the life of the process. Expected analyst results (a refusal
or an ordinary SQL error) carry ``cuttlelyOutcome: "expected"`` so they are not server failures.
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable, Optional, Sequence

# Five tries. The first list is immediate; these are the waits after an empty or failed list.
CUTTLELY_TOOL_RETRY_DELAYS = (0.5, 1.0, 2.0, 4.0, 8.0)


def breaker_scope_key(base: Any, session_id: Optional[str]) -> Any:
    """Per chat when the call has a session id. Calls without one keep the server-wide key."""
    session = str(session_id or "").strip()
    if not session:
        return base
    return (base, session)


def outcome_from_structured(structured: Any) -> str:
    if not isinstance(structured, dict):
        return ""
    outcome = structured.get("cuttlelyOutcome")
    if outcome in ("expected", "transport"):
        return outcome
    return ""


def counts_toward_breaker(payload: Any) -> bool:
    """True when a rendered tool payload is a transport or server failure.

    An expected analyst outcome has an error text for the model and does not strike.
    """
    if not isinstance(payload, dict) or "error" not in payload:
        return False
    if payload.get("cuttlelyOutcome") == "expected":
        return False
    return True


def analyst_call_arguments(server_name: str, args: dict, session_id: Optional[str]) -> dict:
    """cuttlely: a page cursor is scoped to this chat.

    The analyst bridge reads ``_cuttlelyScope`` and drops it before the tool schema.
    Other MCP servers keep the model's arguments unchanged.
    """
    if server_name != "analyst":
        return args
    session = str(session_id or "").strip()
    if not session:
        return args
    merged = dict(args or {})
    merged["_cuttlelyScope"] = session
    return merged


def leaves_breaker_unchanged(result_text: str) -> bool:
    """Expected outcomes neither open the breaker nor clear a real failure streak."""
    import json

    try:
        payload = json.loads(result_text)
    except (json.JSONDecodeError, TypeError):
        return False
    return isinstance(payload, dict) and payload.get("cuttlelyOutcome") == "expected"


async def cuttlely_retry_tool_list(
    list_tools: Callable[[], Awaitable[Sequence[Any]]],
    *,
    delays: Sequence[float] = CUTTLELY_TOOL_RETRY_DELAYS,
    sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
) -> list:
    """Call ``list_tools`` until it returns a non-empty list or ``delays`` run out."""
    tools = list(await list_tools() or [])
    if tools:
        return tools
    for delay in delays:
        await sleep(delay)
        tools = list(await list_tools() or [])
        if tools:
            return tools
    return []
