"""Inventory tracked source references or mounted data roots, without opening deployment files."""
import argparse
from collections import defaultdict
import csv
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

SOURCE = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".sh", ".ps1", ".sql", ".rs", ".go", ".swift", ".rb", ".yml", ".yaml"}
NAMES = re.compile(r"""(?<![\w.-])(?:[\w.$/{}@+-]+\.(?:sqlite3?|db|ya?ml|toml|conf|cfg|ini|jsonl?|secret|key|enc|pem|lock)|\.env(?:\.[\w-]+)?|jwt-issuer|jwt-audience|setup-instance\.id|harness-(?:parent|compiler|try(?:-owner|-session|-flow|-keep)?)|SOUL\.md|SKILL\.md)(?![\w.-])""", re.I)
SINK = re.compile(r"""\b(?:DatabaseSync|SqliteSaver|DataSource|SQLDatabase|open_db|sqlite3\.connect|aiosqlite\.connect|writeFile(?:Sync|Atomic)?|appendFile(?:Sync)?|createWriteStream|appendFile|writeFileAtomic|atomic_config_write|write_if_changed|atomic_write_json|writeIfChanged|write_text|write_bytes|atomic_write\w*|save_config|safe_dump|json\.dump|copyFile(?:Sync)?|rename(?:Sync)?|shutil\.(?:copy\w*|move)|os\.replace|set_key)\b|\bopen\([^\n]*?['"][wax][bt+]*['"]|^\s*(?:cat|echo|printf|tee|cp|install)\s""")
SECRETS = {"jwt-issuer", "jwt-audience", "setup-instance.id", ".env"}
CONFIG = {".conf", ".ini", ".toml", ".json", ".jsonl", ".yaml", ".yml", ".cfg"}

def category(path):
    name = path.name.lower()
    normalized = path.as_posix().lower()
    base = re.sub(r"-(wal|shm|journal)$|\.migrated$", "", name)
    if re.search(r"\.(sqlite3?|db)$", base):
        if base in {"etl.sqlite", "harness-queue.sqlite", "sessions.sqlite", "dashflows.sqlite"} or "/vectors/" in "/" + normalized:
            return "Cuttlely side store or companion; migrate only after verified copy"
        if base.startswith("analyst") and base.endswith(".db"):
            return "Analyst area or companion; verify owner and configured Analyst backend"
        if base == "database.sqlite":
            return "application or node-owned tables; inventory both before cutover"
        if "hermes" in path.parts or base in {"state.db", "kanban.db", "shared-state.db", "executions.db", "response_store.db", "runs_idempotency.db"}:
            return "runtime database or companion; retain with runtime home"
        return "unclassified database; retain pending ownership review"
    if name in SECRETS or name.startswith(".env.") or path.suffix.lower() in {".key", ".secret", ".enc", ".pem"}:
        return "identity or secret material; retain under access control"
    if ".git" in path.parts or "versions" in path.parts:
        return "version repository or snapshot; retain history"
    if "skills" in path.parts:
        return "skill bundle code, instructions or configuration; retain with runtime"
    if "settings" in path.parts:
        return "server settings, history or coordination; reconcile with settings allowlist"
    if name.startswith("server.log.") or "logs" in path.parts or name.endswith((".log", ".log.jsonl")) or name.startswith(".audit-"):
        return "runtime logs; retain per logging policy"
    if "cache" in path.parts or "plugin-update-checks" in path.parts:
        return "runtime cache or update report; record separately from configuration"
    if "backups" in path.parts:
        return "backup copy; preserve until recovery verified"
    if name in {"config.yaml", "channel_directory.json", "install_id", "soul.md"}:
        return "runtime configuration, identity or instructions; retain with profile"
    if name.endswith((".lock", ".pid", ".stop")) or name.startswith(("hermes-supervisor", "gateway_state", "gateway.lifecycle", "gateway.heartbeat", "ticker_", ".clean_shutdown")):
        return "runtime coordination or status; reconcile against running processes"
    if path.suffix.lower() in CONFIG or name == "config":
        return "structured file; retain pending owner review"
    if name.startswith("harness-") or name == "skill.md":
        return "profile control or instructions; retain with profile"
    return "other file; retain pending owner review"

def disk(roots, writer):
    writer.writerow(("root", "relative_path", "entry_type", "bytes", "mode", "disposition"))
    def failed(error):
        raise error
    for root in roots:
        root = Path(root).absolute()
        if root.is_symlink() or not root.is_dir():
            raise ValueError(f"Expected a directory, not a link: {root}")
        for directory, dirs, files in os.walk(root, onerror=failed, followlinks=False):
            for name in sorted(dirs + files):
                entry = Path(directory, name)
                info = entry.lstat()
                if stat.S_ISDIR(info.st_mode):
                    continue
                kind = "regular" if stat.S_ISREG(info.st_mode) else "link" if stat.S_ISLNK(info.st_mode) else "special"
                writer.writerow((root, entry.relative_to(root), kind, info.st_size, oct(stat.S_IMODE(info.st_mode)), category(entry.relative_to(root)) if kind == "regular" else "inspect separately; target not followed"))

def source(writer, families=False):
    references = defaultdict(set)
    if not families:
        writer.writerow(("scope", "source_file", "line", "evidence", "name_or_operation"))
    root = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
    for item in subprocess.check_output(["git", "ls-files", "-z"], cwd=root).split(b"\0"):
        if not item:
            continue
        path = Path(os.fsdecode(item))
        file = root / path
        if path.suffix.lower() not in SOURCE and not path.name.startswith("Dockerfile"):
            continue
        if file.is_symlink() or not file.is_file() or path.name.startswith(".env"):
            continue
        scope = "vendored runtime" if path.parts[0] == "hermes" else path.parts[0]
        if re.search(r"(?:^|/)(?:tests?|fixtures?|check)(?:/|\.)|\.(?:test|spec)\.", str(path)):
            scope = "test or fixture"
        for number, line in enumerate(file.read_text(errors="replace").splitlines(), 1):
            for label, pattern in (("path reference", NAMES), ("writer or database API", SINK)):
                for match in sorted(set(pattern.findall(line))):
                    if families:
                        if label == "path reference":
                            references[(scope, match)].add(str(path))
                    else:
                        writer.writerow((scope, path, number, label, match.strip()))
    if families:
        writer.writerow(("scope", "literal_path_candidate", "source_file_count", "source_files", "upgrade_policy"))
        for (scope, name), locations in sorted(references.items()):
            policy = "fixture only" if scope == "test or fixture" else "retain if present; confirm writer and role against inventory before migration"
            writer.writerow((scope, name, len(locations), " | ".join(sorted(locations)), policy))

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("source", "families", "disk"))
    parser.add_argument("roots", nargs="*")
    args = parser.parse_args()
    output = csv.writer(sys.stdout)
    if args.mode in {"source", "families"} and not args.roots:
        source(output, families=args.mode == "families")
    elif args.mode == "disk" and args.roots:
        disk(args.roots, output)
    else:
        parser.error("Pass explicit directories for disk mode only")
