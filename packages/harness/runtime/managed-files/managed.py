"""Four file tools over one authenticated workspace snapshot. No host paths are accepted."""

import base64
import difflib
import hashlib
import json
import os
import re
import sys
from pathlib import Path, PurePosixPath

# Isolated mode excludes the launch directory and PYTHONPATH. Add only distribution-owned modules.
sys.path.insert(0, str(Path(__file__).resolve().parent))
decoder = Path(
    os.environ.get("CUTTLELY_NATIVE_FILE_DECODER", "/opt/cuttlely-file-decoder")
).resolve()
sys.path.insert(1, str(decoder))
from binary_extensions import has_binary_extension
from file_operations_common import (
    ReadResult,
    WriteResult,
    _detect_line_ending,
    _normalize_line_endings,
    _strip_bom,
)
from fuzzy_match import fuzzy_find_and_replace, is_already_applied
from lint import (
    _lint_python_inproc,
    _lint_toml_inproc,
    _lint_json_inproc,
    _lint_yaml_inproc,
)
from patch_parser import parse_v4a_patch, apply_v4a_operations
from read_extract import is_extractable_document
from read_page import page
from redact import redact_sensitive_text, _is_secret_file_arg
from confine import confine
import search

MAX_BYTES = 64 * 1024**2
MAX_ENTRIES = 256
PROTECTED = {
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
    ".env.test",
    ".env.staging",
    ".envrc",
}
CHECKS = {
    ".json": _lint_json_inproc,
    ".yaml": _lint_yaml_inproc,
    ".yml": _lint_yaml_inproc,
    ".toml": _lint_toml_inproc,
    ".py": _lint_python_inproc,
}


def key(value):
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 512
        or any(ord(c) < 32 for c in value)
    ):
        raise ValueError("Expected a managed relative file path.")
    if value.startswith(("/", "~")) or "\\" in value or re.match(r"^[A-Za-z]:", value):
        raise ValueError("Use a path relative to this specialist workspace.")
    if any(
        part in ("", ".", "..") or part.lower() in PROTECTED
        for part in value.split("/")
    ):
        raise ValueError("Unavailable managed workspace path.")
    return value


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate(files):
    if len(files) > MAX_ENTRIES or sum(map(len, files.values())) > MAX_BYTES:
        raise ValueError("Managed workspace quota exceeded.")
    existing = set(files)
    for name in files:
        if any(parent.as_posix() in existing for parent in PurePosixPath(name).parents):
            raise ValueError("A workspace file cannot also be a directory.")


class Files:
    def __init__(self, record):
        self.files = {
            key(name): base64.b64decode(body, validate=True)
            for name, body in record["files"].items()
        }
        validate(self.files)
        self.known = record.get("known", {})
        self.revision = record.get("modified", {})
        self.changed = set()
        self.removed = set()

    def mark(self, name):
        self.changed.add(name)
        self.removed.discard(name)
        self.revision[name] = max(self.revision.values(), default=0) + 1
        self.known[name] = digest(self.files[name])

    def read_file_raw(self, path):
        path = key(path)
        if path not in self.files:
            return ReadResult(error="File not found", not_found=True)
        return ReadResult(content=self.files[path].decode("utf8", "surrogateescape"))

    def write_file(self, path, content, pre_content=None, *, csv_output=False):
        path = key(path)
        if not isinstance(content, str):
            return WriteResult(error="A text file needs string content.")
        old = self.files.get(path, b"")
        suffix = PurePosixPath(path).suffix.lower()
        if (
            is_extractable_document(path) and suffix != ".ipynb"
        ) or has_binary_extension(path):
            return WriteResult(error="Use a text filename for text writes.")
        raw = old.decode("utf8", "surrogateescape")
        if csv_output:
            # The CSV writer already serialized the exact UTF-8 bytes, including quoted newlines.
            if not path.startswith("output/") or suffix != ".csv" or len(content.encode("utf8")) > 8192:
                return WriteResult(error="Use a managed CSV output of at most 8192 bytes.")
            text = content
        else:
            ending = _detect_line_ending(raw)
            text = _normalize_line_endings(content, ending) if ending else content
            if raw.startswith("\ufeff") and not text.startswith("\ufeff"):
                text = "\ufeff" + text
        checker = CHECKS.get(suffix)
        if checker:
            ok, detail = checker(content)
            if not ok and suffix in (".json", ".yaml", ".yml", ".toml"):
                return WriteResult(error="File was not written: " + detail)
            previous_ok, previous_detail = checker(raw)
            lint = (
                {"status": "error", "output": detail}
                if not ok and (previous_ok or detail != previous_detail)
                else {"status": "ok", "output": ""}
            )
            if detail == "__SKIP__":
                lint = {"status": "skipped", "message": "Syntax decoder unavailable."}
        else:
            lint = {
                "status": "skipped",
                "message": "No syntax checker available for " + suffix + " files",
            }
        self.files[path] = text.encode("utf8", "surrogateescape")
        validate(self.files)
        self.mark(path)
        return WriteResult(
            bytes_written=len(self.files[path]), verified=True, lint=lint
        )

    def delete_file(self, path):
        path = key(path)
        if path not in self.files:
            return WriteResult(error="File not found.")
        del self.files[path]
        self.removed.add(path)
        self.changed.discard(path)
        self.known.pop(path, None)
        self.revision.pop(path, None)
        return WriteResult()

    def move_file(self, source, target):
        source, target = key(source), key(target)
        if source not in self.files or target in self.files:
            return WriteResult(error="Unavailable source or occupied target.")
        self.files[target] = self.files[source]
        self.delete_file(source)
        validate(self.files)
        self.mark(target)
        return WriteResult()

    def call(self, name, args):
        if name == "search_files":
            return search.search(self.files, args, self.revision)
        if name == "patch" and args.get("mode") == "patch":
            operations, error = parse_v4a_patch(args["patch"])
            if error:
                return {"error": error}
            result = apply_v4a_operations(operations, self)
            out = result.to_dict()
            if out.get("diff"):
                out["diff"] = redact_sensitive_text(out["diff"], file_read=True)
            if result.success:
                out["files_modified"] = [
                    op.file_path for op in operations if op.operation.name != "MOVE"
                ] + [
                    name
                    for op in operations
                    if op.operation.name == "MOVE"
                    for name in (op.file_path, op.new_path)
                ]
            return out
        p = key(args["path"])
        if name in ("write_file", "write_csv_output"):
            if p in self.files and self.known.get(p) != digest(self.files[p]):
                return {
                    "error": "Read the full current file before replacing its contents. Use patch for a targeted edit."
                }
            result = self.write_file(p, args["content"], csv_output=name == "write_csv_output")
            return (
                result.to_dict()
                if result.error
                else dict(result.to_dict(), resolved_path=p, files_modified=[p])
            )
        if p not in self.files:
            out = {"error": "File not found: " + p}
            if name == "read_file":
                wanted = PurePosixPath(p)
                nearby = sorted(PurePosixPath(n).name for n in self.files
                                if PurePosixPath(n).parent == wanted.parent and not PurePosixPath(n).name.startswith("."))[:50]
                choices = difflib.get_close_matches(wanted.name, nearby, n=5, cutoff=0.55)
                out["not_found"] = True
                if choices:
                    out["similar_files"] = [str(wanted.with_name(c)) for c in choices]
            return out
        if name == "read_file":
            body = self.files[p]
            if has_binary_extension(p) and not is_extractable_document(p):
                return {"error": "Cannot read binary file."}
            result = page(body, p, args.get("offset", 1), args.get("limit", 2000))
            redacted = result.pop("_redacted", False)
            if (
                not redacted
                and not result.get("error")
                and int(args.get("offset", 1)) <= 1
                and not result.get("truncated")
                and not result.get("truncated_lines")
                and not result.get("extracted_document")
            ):
                self.known[p] = digest(body)
            return result
        if name != "patch" or args.get("mode", "replace") != "replace":
            return {"error": "Unknown managed file operation."}
        old = _strip_bom(self.files[p].decode("utf8", "surrogateescape"))[0]
        text, count, strategy, error = fuzzy_find_and_replace(
            old, args["old_string"], args["new_string"], args.get("replace_all", False)
        )
        if error:
            if is_already_applied(old, args["old_string"], args["new_string"]):
                return {
                    "success": True,
                    "no_change": True,
                    "note": "The edit is already present.",
                }
            return {"error": error}
        result = self.write_file(p, text, pre_content=old)
        if result.error:
            return {"error": result.error}
        difference = "".join(
            difflib.unified_diff(
                old.splitlines(True),
                text.splitlines(True),
                fromfile="a/" + p,
                tofile="b/" + p,
            )
        )
        return {
            "success": True,
            "diff": redact_sensitive_text(
                difference, file_read=True, secret_file=_is_secret_file_arg(p)
            ),
            "resolved_path": p,
            "files_modified": [p],
            "lint": result.lint,
        }


def main():
    rg = Path(os.environ.get("CUTTLELY_NATIVE_FILE_SEARCH", "/usr/bin/rg")).resolve(
        strict=True
    )
    pdf = Path("/usr/bin/pdftotext")
    # Both are distribution assets. Missing dependencies disable this deployment's full file-tool grant.
    import anydoc

    root = Path.cwd()
    confine(root, rg, pdf if pdf.is_file() else None)
    search.rg = rg
    if "--check" in sys.argv:
        if not callable(anydoc.to_markdown_bytes):
            raise RuntimeError("Unsupported document decoder.")
        print("ready")
        return
    record = json.load(sys.stdin)
    workspace = Files(record)
    try:
        result = workspace.call(record["name"], record["args"])
    except (ValueError, TypeError, KeyError, OSError) as error:
        result = {"error": str(error)[:1500]}
    if result.get("error") or result.get("success") is False:
        print(json.dumps({"result": result}))
        return
    print(
        json.dumps(
            {
                "result": result,
                "known": workspace.known,
                "modified": workspace.revision,
                "changed": {
                    name: base64.b64encode(workspace.files[name]).decode()
                    for name in workspace.changed
                },
                "removed": sorted(workspace.removed),
            }
        )
    )


if __name__ == "__main__":
    main()
