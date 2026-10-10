"""Child toolset resolution for delegate_task: what a child may and may never use."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import List, Optional

from toolsets import TOOLSETS, resolve_toolset
from tools.delegate_tool_config import _get_inherit_mcp_toolsets

logger = logging.getLogger("tools.delegate_tool")  # log-record parity with the origin module

# Tools that children must never have access to
DELEGATE_BLOCKED_TOOLS = frozenset(
    [
        "delegate_task",  # no recursive delegation
        "clarify",  # no user interaction
        "memory",  # no writes to shared MEMORY.md
        "send_message",  # no cross-platform side effects
        "cronjob_manage",  # no scheduling more work in the parent's name
    ]
)
DEFAULT_TOOLSETS = ["terminal", "file", "web"]

def _is_mcp_toolset_name(name: str) -> bool:
    """Return True for canonical MCP toolsets and their registered aliases."""
    if not name:
        return False
    if str(name).startswith("mcp-"):
        return True
    try:
        from tools.registry import registry
        target = registry.get_toolset_alias_target(str(name))
    except Exception:
        target = None
    return bool(target and str(target).startswith("mcp-"))

def _expand_parent_toolsets(parent_toolsets: set) -> set:
    """Add every toolset whose tools are a subset of the parent's tools: a parent on a composite like ``hermes-cli``
    must still let a child request ``web``/``terminal``; bare name intersection would reject them. Both sides use
    the RESOLVED static surface: a composite's ``includes`` (``debugging`` -> ``web``/``file``, ``safe``) are tools
    the parent genuinely holds, and the child never gains a tool the parent lacks."""
    parent_tool_names = {
        t for ts_name in parent_toolsets if ts_name in TOOLSETS for t in resolve_toolset(ts_name, include_registry=False)
    }
    expanded = set(parent_toolsets)
    if parent_tool_names:
        expanded.update(
            ts_name for ts_name in TOOLSETS
            if ts_name not in expanded
            and (resolved := resolve_toolset(ts_name, include_registry=False))
            and set(resolved).issubset(parent_tool_names)
        )
    return expanded

def _strip_blocked_tools(toolsets: List[str]) -> List[str]:
    """Remove toolsets whose tools are ALL blocked (derived from DELEGATE_BLOCKED_TOOLS so the two can't drift) plus
    composite toolsets children must never get (``delegation``, ``kanban``)."""
    blocked_toolset_names = {"delegation", "kanban"} | {
        name
        for name in TOOLSETS
        if (resolved_tools := resolve_toolset(name, include_registry=False))
        and all(tool in DELEGATE_BLOCKED_TOOLS for tool in resolved_tools)
    }
    return [t for t in toolsets if t not in blocked_toolset_names]

def _blocked_toolsets_for_role(role: str) -> List[str]:
    """One-tool deny toolsets for the role; passed as ``disabled_toolsets`` so
    blocked names inside mixed bundles are subtracted AFTER composite expansion."""
    blocked_names = set(DELEGATE_BLOCKED_TOOLS)
    if role == "orchestrator":
        blocked_names.discard("delegate_task")
    return sorted(
        name for name, defn in TOOLSETS.items() if defn.get("tools") and set(defn.get("tools", ())).issubset(blocked_names)
    )

_SPECIALIST_MARKER = re.compile(r"\[specialist:([A-Za-z][A-Za-z0-9_-]{0,63})\]")


def _load_harness_roster() -> Optional[dict]:
    """Roster compiled into the active Hermes profile. Missing file means stock Hermes behavior."""
    try:
        from hermes_constants import get_hermes_home
        roster_path = Path(get_hermes_home()) / "harness-roster.json"
    except Exception:
        return None
    try:
        if not roster_path.is_file():
            return None
        data = json.loads(roster_path.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("Cuttlely roster at %s could not be read", roster_path, exc_info=True)
        return None
    return data if isinstance(data, dict) else None


def _cuttlely_allowed_toolsets() -> set:
    roster = _load_harness_roster()
    if not roster:
        return set()
    allowed = set()
    for spec in roster.get("specialists") or []:
        if not isinstance(spec, dict):
            continue
        for name in spec.get("hermesToolsets") or []:
            allowed.add(str(name))
    return allowed


def cuttlely_toolsets_for_task(goal: str, context: Optional[str]) -> Optional[List[str]]:
    """Toolsets for one delegated specialist. The chief profile does not hold these tools.

    The marker ``[specialist:name]`` selects a roster row. Only toolsets listed on that
    row are returned, so a specialist cannot pick up another harness's allowlist or a
    tool the roster left off (shell, browser, and code execution stay off unless enabled).
    """
    roster = _load_harness_roster()
    if not roster:
        return None
    match = _SPECIALIST_MARKER.search(f"{goal or ''}\n{context or ''}")
    if not match:
        return None
    wanted = match.group(1)
    for spec in roster.get("specialists") or []:
        if isinstance(spec, dict) and spec.get("name") == wanted:
            toolsets = [str(name) for name in (spec.get("hermesToolsets") or [])]
            return toolsets or []
    return None


def _cuttlely_filter_toolsets(toolsets: Optional[List[str]]) -> Optional[List[str]]:
    """Accept an explicit child allowlist only when every name is on this profile's roster."""
    if not toolsets:
        return None
    allowed = _cuttlely_allowed_toolsets()
    if not allowed:
        return None
    names = [str(name) for name in toolsets]
    if names and all(name in allowed for name in names):
        return names
    return None


def _resolve_child_toolsets(
    parent_agent, toolsets: Optional[List[str]], effective_role: str
) -> tuple[List[str], List[str]]:
    """``(enabled_toolsets, disabled_toolsets)`` for a child. Children never gain tools the parent lacks: explicit
    ``toolsets`` are intersected with the parent's (composite-expanded) set, else the parent's enabled set is
    inherited. Blocked tools are stripped twice — whole blocked toolsets here, and exact one-tool deny toolsets via
    ``disabled_toolsets`` so blocked names inside mixed bundles (hermes-cli) are subtracted AFTER composite
    expansion and survive registry refreshes. Orchestrators get ``delegation`` re-added unconditionally
    (role-granted, not inherited).

    Cuttlely harness profiles are the exception. The chief only enables delegate_task, memory, and
    session_search. Specialist allowlists are stored on that profile's roster and granted to the
    matching child even though the parent does not hold them.
    """
    cuttlely_child = _cuttlely_filter_toolsets(toolsets)
    if cuttlely_child is not None:
        disabled = list(dict.fromkeys(_blocked_toolsets_for_role(effective_role) + ["kanban"]))
        return cuttlely_child, disabled

    # enabled_toolsets=None means "all tools", so derive from loaded tool names.
    parent_enabled = getattr(parent_agent, "enabled_toolsets", None)
    if parent_enabled is not None:
        parent_toolsets = set(parent_enabled)
    elif parent_agent and hasattr(parent_agent, "valid_tool_names"):
        import model_tools
        parent_toolsets = {
            ts for name in parent_agent.valid_tool_names if (ts := model_tools.get_toolset_for_tool(name)) is not None
        }
    else:
        parent_toolsets = set(DEFAULT_TOOLSETS)

    if toolsets:
        expanded_parent = _expand_parent_toolsets(parent_toolsets)
        child_toolsets = [t for t in toolsets if t in expanded_parent]
        if _get_inherit_mcp_toolsets():
            # Append any parent MCP toolsets missing from the narrowed child.
            child_toolsets += [
                name for name in sorted(parent_toolsets) if _is_mcp_toolset_name(name) and name not in child_toolsets
            ]
    elif parent_agent and parent_enabled is not None:
        child_toolsets = parent_enabled
    else:
        child_toolsets = sorted(parent_toolsets) or DEFAULT_TOOLSETS
    child_toolsets = _strip_blocked_tools(child_toolsets)

    raw_parent_disabled = getattr(parent_agent, "disabled_toolsets", None)
    inherited_disabled = (
        [str(name) for name in raw_parent_disabled] if isinstance(raw_parent_disabled, (list, tuple, set)) else []
    )
    if effective_role == "orchestrator":
        inherited_disabled = [name for name in inherited_disabled if name != "delegation"]
        if "delegation" not in child_toolsets:
            child_toolsets.append("delegation")
    child_disabled_toolsets = list(
        dict.fromkeys(inherited_disabled + _blocked_toolsets_for_role(effective_role) + ["kanban"])
    )
    return child_toolsets, child_disabled_toolsets
