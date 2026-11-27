from pathlib import Path
import tempfile, subprocess, os
from file_operations_common import SearchResult, ExecuteResult
from search_parse import _parse_search_output, _pattern_has_regex_newline

# The deployment supplies this fixed executable. Model input only supplies data arguments.
rg = Path("/usr/bin/rg")


def search(files, args, revision):
    root = args.get("path") or "."
    from managed import key

    if root != ".":
        root = key(root)
    mode = args.get("output_mode", "content")
    limit = min(500, max(1, args.get("limit", 50)))
    offset = min(2000, max(0, args.get("offset", 0)))
    context = min(100, max(0, args.get("context", 0)))
    pattern = args["pattern"]
    if len(pattern) > 8000 or "\0" in pattern:
        raise ValueError("invalid search pattern")
    target = args.get("target", "content")
    directory = target in ["find", "files"]
    with tempfile.TemporaryDirectory(prefix="scoped-catalog-") as local:
        for name, body in files.items():
            f = Path(local) / key(name)
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(body)
            stamp = revision.get(name, 0) + 1700000000
            os.utime(f, (stamp, stamp))
        if root != "." and not (Path(local) / root).exists():
            return dict(error="Path not found: " + root, total_count=0)
        cmd = [str(rg), "--no-config", "--no-ignore-global", "--no-ignore-parent"]
        if directory:
            order = args.get("order", "discovery")
            if order not in ("discovery", "modified"):
                raise ValueError("unknown discovery order")
            cmd += [
                "--files",
                "--glob",
                ("*" if "/" not in pattern and not pattern.startswith("*") else "")
                + pattern,
            ]
            if order == "modified":
                cmd += ["--sortr", "modified"]
        else:
            cmd += ["--line-number", "--no-heading", "--with-filename"]
            if mode == "files_only":
                cmd += ["-l"]
            elif mode == "count":
                cmd += ["-c"]
            elif mode == "content":
                cmd += ["--max-columns", "2000", "--max-columns-preview"]
            else:
                raise ValueError("unknown search mode")
            if _pattern_has_regex_newline(pattern):
                cmd += ["--multiline"]
            if context:
                cmd += ["-C", str(context)]
            if args.get("file_glob"):
                cmd += ["-g", args["file_glob"]]
            cmd += ["-e", pattern]
        cmd += ["--", root]
        # A regular scratch file bounds output through RLIMIT_FSIZE in the independent worker.
        with tempfile.TemporaryFile() as stdout:
            call = subprocess.run(
                cmd,
                cwd=local,
                env={"LANG": "C.UTF-8"},
                timeout=3,
                stdout=stdout,
                stderr=subprocess.STDOUT,
            )
            stdout.seek(0)
            cap = offset + limit + (200 if context else 0) + (1 if directory else 0)
            lines = []
            while len(lines) < cap:
                row = stdout.readline(13000)
                if not row:
                    break
                lines.append(
                    row.removeprefix(b"./").decode(errors="replace").rstrip("\n")
                )
        if directory:
            result = SearchResult(
                files=lines[offset : offset + limit],
                total_count=len(lines),
                truncated=len(lines) > offset + limit,
            )
        else:
            result = _parse_search_output(
                ExecuteResult(stdout="\n".join(lines), exit_code=call.returncode),
                mode,
                limit,
                offset,
                context,
            )
        from redact import redact_sensitive_text, _is_secret_file_arg

        for row in result.matches:
            row.content = redact_sensitive_text(
                row.content, file_read=True, secret_file=_is_secret_file_arg(row.path)
            )
        return result.to_dict(densify=True)
