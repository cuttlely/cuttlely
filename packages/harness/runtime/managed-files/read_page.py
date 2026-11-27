def _truncate_to_char_budget(content: str, max_chars: int) -> tuple[str, int, bool]:
    """Trim line-numbered ``read_file`` content to the last COMPLETE line within *max_chars*.

    Returns ``(kept_text, lines_kept, truncated)`` so the caller can offer a
    ``next_offset`` instead of rejecting the read. If not even the first line
    fits it is clamped mid-line so the read is never empty and the cursor advances.

    Ported in spirit from nearai/ironclaw#5029 (dual line/byte cap on ``read_file``). Where hermes
    previously hard-rejected an oversized read (forcing the model to guess a smaller ``limit`` and burn a
    round-trip returning nothing), this trims the content to the last *complete line* that fits within
    ``max_chars`` and reports how many lines were kept so the caller can offer a ``next_offset``
    continuation.
    """
    if len(content) <= max_chars:
        return content, (content.count("\n") + 1 if content else 0), False

    lines = content.split("\n")
    kept: list[str] = []
    running = 0
    for line in lines:
        addition = len(line) + (1 if kept else 0)  # +1 for the rejoining "\n"
        if running + addition > max_chars:
            break
        kept.append(line)
        running += addition
    if not kept:
        kept.append(lines[0][:max_chars])
    return "\n".join(kept), len(kept), True


def _apply_char_budget(
    result_dict: dict, content: str, offset: int, total_lines, max_chars: int
) -> str:
    """Trim *content* to the char budget, annotate *result_dict* with the
    continuation hint, and return the trimmed text."""
    trimmed, lines_kept, _ = _truncate_to_char_budget(content, max_chars)
    next_offset = offset + lines_kept
    result_dict["content"] = trimmed
    result_dict["truncated"] = True
    result_dict["truncated_by"] = "bytes"
    result_dict["next_offset"] = next_offset
    result_dict["hint"] = (
        f"Output truncated at the {max_chars:,}-char read budget after "
        f"{lines_kept} line(s) (showing lines {offset}-{next_offset - 1} of "
        f"{total_lines}). Use offset={next_offset} to continue."
    )
    if len(trimmed.split("\n", 1)[0]) >= max_chars:
        result_dict["truncated_lines"] = True
        result_dict["hint"] += (
            " Note: the first line alone exceeded the budget and was "
            "clamped mid-line; its remainder is not retrievable via offset."
        )
    return trimmed


from pathlib import PurePosixPath
from file_operations_common import ReadResult, _strip_bom
from redact import _is_secret_file_arg, redact_sensitive_text
from read_extract import (
    extract_document_bytes,
    is_extractable_document,
    ExtractionError,
)


def page(body, path, input_offset, input_limit):
    offset = max(1, int(input_offset))
    limit = min(2000, max(1, int(input_limit)))
    end = offset + limit - 1
    doc = is_extractable_document(path)
    if doc:
        try:
            text = extract_document_bytes(body, path)
        except ExtractionError as e:
            if PurePosixPath(path).suffix.lower() != ".ipynb":
                return {
                    "error": f"Cannot read '{path}' ({PurePosixPath(path).suffix.lower()}): document extraction failed — {e}. Use terminal utilities to inspect or convert the file."
                }
            doc = False
    if not doc:
        encoding = "utf-8"
        if body.startswith(b"\xff\xfe") or body.startswith(b"\xfe\xff"):
            encoding = "utf-16"
        try:
            text = body.decode(encoding)
        except UnicodeDecodeError:
            return dict(error="Cannot read binary file.")
        if "\0" in text:
            return dict(error="Cannot read binary file.")
        text = _strip_bom(text)[0]
    lines = text.splitlines()
    part = lines[offset - 1 : end]
    shown = "\n".join(
        str(i) + "|" + (line[:2000] + "... [truncated]" if len(line) > 2000 else line)
        for i, line in enumerate(part, offset)
    )
    if doc:
        res = dict(
            content=shown,
            total_lines=len(lines),
            file_size=len(body),
            truncated=len(lines) > end,
            extracted_document=True,
        )
    else:
        res = ReadResult(
            content=shown,
            total_lines=len(lines),
            file_size=len(body),
            truncated=len(lines) > end,
        ).to_dict()
    if len(lines) > end:
        res["hint"] = (
            f"Use offset={end + 1} to continue reading (showing {offset}-{end} of {len(lines)} lines)"
        )
    elif not doc and len(body) == 0:
        res["hint"] = "File is empty (0 bytes)."
    elif not doc and offset > len(lines) > 0:
        res["hint"] = (
            f"Note: offset {offset} is beyond the end of the file ({len(lines)} lines total). Retry with offset <= {len(lines)}."
        )
    if len(shown) > 100000:
        _apply_char_budget(res, shown, offset, len(lines), 100000)
    if any(len(line) > 2000 for line in part):
        res["truncated_lines"] = True
    before_redaction = res["content"]
    res["content"] = redact_sensitive_text(
        res["content"], file_read=True, secret_file=_is_secret_file_arg(path)
    )
    res["_redacted"] = res["content"] != before_redaction
    return res
