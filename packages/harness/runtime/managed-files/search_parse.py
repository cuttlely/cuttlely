from typing import Optional
from file_operations_common import ExecuteResult, SearchResult, SearchMatch
import re
_SEARCH_TIMEOUT_MARKER_RE = re.compile(r"\n?\[Command timed out after \d+s\]\s*$")


def _search_stdout_and_limit(result: ExecuteResult) -> tuple[str, Optional[str]]:
    """Return stdout cleaned for parsing and a limit reason for search timeouts."""
    if result.exit_code == 124:
        return _SEARCH_TIMEOUT_MARKER_RE.sub("", result.stdout), "search_timeout"
    return result.stdout, None


# A real rg/grep output line is a whitespace-free path token followed by ``:``
# (match/count), ``-`` (context), or nothing (files_only); tool diagnostics
# ("rg: ...", indented carets) never match.
_SEARCH_OUTPUT_RE = re.compile(r'^([A-Za-z]:)?[^\s:][^\n]*?[:\-]\d|^[^\s:][^\s]*$')


def _split_tool_diagnostics(output: str) -> tuple[str, str]:
    """Separate rg/grep diagnostic lines from real match output → ``(diagnostics, payload)``.
    ``_exec`` merges stderr into stdout; classifying by SHAPE lets the exit-2 guard
    tell a pure failure (no payload) from a partial one (one unreadable file, others
    matched) and guarantees error text is never parsed as a match."""
    diagnostics: list[str] = []
    payload: list[str] = []
    for line in output.split('\n'):
        if not line.strip():
            continue
        # Prefix check first: a match path can contain "-<digit>" (".../pytest-686/...").
        if line.lstrip().startswith(("rg: ", "grep: ")):
            diagnostics.append(line)
        elif line == "--" or _SEARCH_OUTPUT_RE.match(line):
            payload.append(line)
        else:
            diagnostics.append(line)
    return '\n'.join(diagnostics), '\n'.join(payload)


def _parse_search_context_line(line: str) -> tuple[str, int, str] | None:
    """Parse a ``path-line-content`` context line using the RIGHTMOST numeric
    separator (filenames may contain ``-<digits>-`` segments):
    ``dir/file-12-name.py-8-context`` → (``dir/file-12-name.py``, 8, ``context``)."""
    if not line or line == "--":
        return None
    match = None
    for candidate in re.finditer(r'-(\d+)-', line):
        match = candidate
    if match is None or match.start() == 0:
        return None
    return line[:match.start()], int(match.group(1)), line[match.end():]


_REGEX_NEWLINE_ESCAPE_RE = re.compile(r"(?<!\\)(?:\\\\)*\\n")


def _pattern_has_regex_newline(pattern: str) -> bool:
    """True when a content regex wants to match a newline: a literal newline or a
    ``\\n`` escape with an ODD number of backslashes (``\\\\n`` is a literal
    backslash+n and must not count)."""
    return "\n" in pattern or bool(_REGEX_NEWLINE_ESCAPE_RE.search(pattern))


def _is_line_oriented_newline_error(error: Optional[str]) -> bool:
    """Return True for rg's hard error when multiline mode is required."""
    return bool(error) and "literal \"\\n\" is not allowed" in error and "--multiline" in error


def _maybe_warn_line_oriented_newline_pattern(result: SearchResult, pattern: str) -> SearchResult:
    """Attach a newline-regex warning only when search found no usable results."""
    if result.total_count != 0 or not _pattern_has_regex_newline(pattern):
        return result
    if result.error and not _is_line_oriented_newline_error(result.error):
        return result
    result.error = None
    result.warning = (
        "0 results found. Note: search_files content search is line-oriented "
        "and does not run ripgrep with -U/--multiline, so `\\n` in the regex "
        "does not match line breaks. Use context=N to inspect neighboring "
        "lines, or escape as `\\\\n` when searching for a literal backslash+n.")
    return result


# Match lines are "file:lineno:content". Windows paths carry a drive letter
# ("C:\path"), so a naive split(":") breaks — the regex handles both.
_MATCH_LINE_RE = re.compile(r'^([A-Za-z]:)?(.*?):(\d+):(.*)$')

# Output-mode → engine flag (identical for rg and grep).
_OUTPUT_MODE_FLAGS = {"files_only": "-l", "count": "-c"}


def _parse_search_output(result, output_mode: str, limit: int, offset: int,
                         context: int, warning: Optional[str] = None) -> SearchResult:
    """Parse rg/grep ``| head`` output into a SearchResult (shared by both engines).
    Exit codes: 0=matches, 1=none, 2=error — but both tools return 2 on PARTIAL
    errors (one unreadable file), so an error is surfaced only when exit==2 AND no
    usable payload remains. ``warning`` is attached to files_only/content results."""
    stdout, limit_reason = _search_stdout_and_limit(result)
    diagnostics, payload = _split_tool_diagnostics(stdout)
    if result.exit_code == 2 and not payload.strip():
        error_msg = diagnostics.strip() or result.stdout.strip() or "Search error"
        return SearchResult(error=f"Search failed: {error_msg}", total_count=0)
    lines = [ln for ln in payload.strip().split('\n') if ln]
    if output_mode == "files_only":
        return SearchResult(
            files=lines[offset:offset + limit], total_count=len(lines),
            truncated=bool(limit_reason), limit_reason=limit_reason, warning=warning)
    if output_mode == "count":
        counts = {}
        for line in lines:
            if ':' in line:
                path, n = line.rsplit(':', 1)
                try:
                    counts[path] = int(n)
                except ValueError:
                    pass
        return SearchResult(
            counts=counts, total_count=sum(counts.values()),
            truncated=bool(limit_reason), limit_reason=limit_reason)
    matches = []
    for line in lines:
        if line == "--":
            continue
        m = _MATCH_LINE_RE.match(line)
        if m:
            matches.append(SearchMatch(
                path=(m.group(1) or '') + m.group(2), line_number=int(m.group(3)), content=m.group(4)[:500],
            ))
            continue
        # Context lines only when requested, to avoid false positives on dashy paths.
        if context > 0:
            parsed = _parse_search_context_line(line)
            if parsed:
                matches.append(SearchMatch(path=parsed[0], line_number=parsed[1], content=parsed[2][:500]))
    total = len(matches)
    return SearchResult(
        matches=matches[offset:offset + limit], total_count=total,
        truncated=total > offset + limit or bool(limit_reason), limit_reason=limit_reason, warning=warning,
    )
