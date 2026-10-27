"""cuttlely: empty MCP tool lists are retried, and expected analyst results do not open the breaker."""

import asyncio

from tools.mcp_tool_cuttlely import (
    CUTTLELY_TOOL_RETRY_DELAYS,
    analyst_call_arguments,
    breaker_scope_key,
    counts_toward_breaker,
    cuttlely_retry_tool_list,
    leaves_breaker_unchanged,
)


def test_empty_tool_list_retries_then_returns_tools():
    calls = {"n": 0}

    async def list_tools():
        calls["n"] += 1
        if calls["n"] < 3:
            return []
        return ["query"]

    slept = []

    async def sleep(delay):
        slept.append(delay)

    tools = asyncio.run(cuttlely_retry_tool_list(list_tools, sleep=sleep))
    assert tools == ["query"]
    assert calls["n"] == 3
    assert slept == list(CUTTLELY_TOOL_RETRY_DELAYS[:2])


def test_empty_tool_list_stops_after_the_delays():
    async def list_tools():
        return []

    async def sleep(_delay):
        return None

    tools = asyncio.run(cuttlely_retry_tool_list(list_tools, delays=(0.1, 0.2), sleep=sleep))
    assert tools == []


def test_five_expected_outcomes_do_not_pause_and_transport_failures_do():
    """Mirrors the handler: expected skips the count; transport strikes are per session."""
    counts = {}
    opened = set()

    def record(session, payload):
        if leaves_breaker_unchanged('{"error":"x","cuttlelyOutcome":"expected"}') and payload.get("cuttlelyOutcome") == "expected":
            assert counts_toward_breaker(payload) is False
            return
        assert counts_toward_breaker(payload) is True
        key = breaker_scope_key("analyst", session)
        counts[key] = counts.get(key, 0) + 1
        if counts[key] >= 3:
            opened.add(key)

    expected = {"error": "Analyst mode refused ATTACH or VACUUM.", "cuttlelyOutcome": "expected"}
    for _ in range(5):
        record("chat-a", expected)
    assert opened == set()

    transport = {"error": "connection refused", "cuttlelyOutcome": "transport"}
    record("chat-a", transport)
    record("chat-a", transport)
    assert opened == set()
    record("chat-b", transport)
    record("chat-b", transport)
    record("chat-b", transport)
    assert breaker_scope_key("analyst", "chat-a") not in opened
    assert breaker_scope_key("analyst", "chat-b") in opened
    record("chat-a", transport)
    assert breaker_scope_key("analyst", "chat-a") in opened


def test_analyst_page_scope_is_only_added_for_the_analyst_server():
    args = {"sql": "select 1"}
    scoped = analyst_call_arguments("analyst", args, "chief-of-staff--analyst:chat-9")
    assert scoped["_cuttlelyScope"] == "chief-of-staff--analyst:chat-9"
    assert scoped["sql"] == "select 1"
    assert "_cuttlelyScope" not in args
    assert analyst_call_arguments("other", args, "chat-9") is args
    assert analyst_call_arguments("analyst", args, "") is args


def test_page_scope_is_added_for_a_bridge_named_after_its_specialist():
    args = {"sql": "select 1"}
    bridge = {"command": "node", "env": {"CUTTLELY_ANALYST_BRIDGE": "1"}}
    scoped = analyst_call_arguments("data", args, "sales--data:chat-9", bridge)
    assert scoped["_cuttlelyScope"] == "sales--data:chat-9"
    assert "_cuttlelyScope" not in args
    assert analyst_call_arguments("data", args, "sales--data:chat-9", {"command": "node", "env": {}}) is args
    assert analyst_call_arguments("data", args, "sales--data:chat-9", None) is args
    assert analyst_call_arguments("data", args, "", bridge) is args


def test_expected_outcome_leaves_the_breaker_text_unchanged():
    assert leaves_breaker_unchanged('{"error":"no such table: missing_table_xyz","cuttlelyOutcome":"expected"}')
    assert counts_toward_breaker({"error": "no such table: missing_table_xyz", "cuttlelyOutcome": "expected"}) is False
    assert counts_toward_breaker({"error": "MCP server is unreachable"}) is True
    assert breaker_scope_key("analyst", "") == "analyst"
    assert breaker_scope_key("analyst", "chat-1") == ("analyst", "chat-1")
