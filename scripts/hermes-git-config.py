"""A repository-local git config must not run during the agent runtime's own git calls.

The fixture points core.fsmonitor, core.hooksPath, and a README clean/smudge filter at
commands that create marker files. The session snapshot, worktree create, and worktree
cleanup paths must leave those markers absent. The same fixture, driven the way those
paths called git before the hardening, does create them.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hermes"))

from agent.coding_context import build_coding_workspace_block  # noqa: E402
from hermes_cli._subprocess_compat import bounded_git_probe, noninteractive_git_env  # noqa: E402
from hermes_cli import kanban_db_workspace as kanban  # noqa: E402
from hermes_cli import worktree_gc, worktree_ops  # noqa: E402
from tools.async_delegation_recovery_hints import git_state_hint  # noqa: E402
from tools.subagent_worktree import create_subagent_worktree, finalize_subagent_worktree  # noqa: E402
import tui_gateway.methods_complete_helpers as complete_helpers  # noqa: E402

# The file-picker helper is rebound onto the API server, which already imports these.
complete_helpers.subprocess = subprocess
complete_helpers.os = os

SINKS = ("fsmonitor", "hook", "clean", "smudge")


def repo_config_env() -> dict[str, str]:
    """Environment that still reads the repository's own config and nothing else."""
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(
        {
            "PATH": os.environ.get("PATH", ""),
            "HOME": os.environ.get("HOME", ""),
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_TERMINAL_PROMPT": "0",
        }
    )
    return env


def markers(directory: Path) -> list[str]:
    return sorted(path.name for path in directory.glob("MARKER.*"))


def clear_markers(directory: Path) -> None:
    for path in directory.glob("MARKER.*"):
        path.unlink()


def make_repo(tmp: Path) -> tuple[Path, Path]:
    repo = tmp / "repo"
    marker = tmp / "MARKER"
    env = repo_config_env()
    subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True, env=env, capture_output=True, text=True)
    (repo / "README").write_text("hi\n")
    ident = ["-c", "user.email=a@b.invalid", "-c", "user.name=cuttlely", "-c", "commit.gpgsign=false"]
    subprocess.run(["git", "-C", str(repo), *ident, "add", "README"], check=True, env=env, capture_output=True, text=True)
    subprocess.run(["git", "-C", str(repo), *ident, "commit", "-qm", "init"], check=True, env=env, capture_output=True, text=True)

    hooks = repo / "hostile-hooks"
    hooks.mkdir()
    for name in ("post-checkout", "reference-transaction"):
        hook = hooks / name
        hook.write_text(f"#!/bin/sh\ntouch '{marker}.hook'\n")
        hook.chmod(0o755)

    commands = {
        "fsmonitor": f"#!/bin/sh\ntouch '{marker}.fsmonitor'\nprintf '\\0'\n",
        "clean": f"#!/bin/sh\ntouch '{marker}.clean'\ncat\n",
        "smudge": f"#!/bin/sh\ntouch '{marker}.smudge'\ncat\n",
    }
    paths = {}
    for name, body in commands.items():
        path = tmp / f"{name}.sh"
        path.write_text(body)
        path.chmod(0o755)
        paths[name] = path

    settings = {
        "core.fsmonitor": str(paths["fsmonitor"]),
        "core.hooksPath": str(hooks),
        "filter.evil.clean": str(paths["clean"]),
        "filter.evil.smudge": str(paths["smudge"]),
        "filter.evil.required": "true",
    }
    for key, value in settings.items():
        subprocess.run(["git", "-C", str(repo), "config", key, value], check=True, env=env, capture_output=True, text=True)
    (repo / ".gitattributes").write_text("README filter=evil\n")
    subprocess.run(["git", "-C", str(repo), *ident, "add", ".gitattributes"], check=True, env=env, capture_output=True, text=True)
    subprocess.run(["git", "-C", str(repo), *ident, "commit", "-qm", "attrs"], check=True, env=env, capture_output=True, text=True)
    return repo, marker


def retouch(path: Path) -> None:
    stamp = time.time() + 120
    os.utime(path, (stamp, stamp))


def show_legacy_writes_markers(tmp: Path) -> None:
    """The calls these paths made before the hardening execute the repository config."""
    repo, _marker = make_repo(tmp)
    env = repo_config_env()
    retouch(repo / "README")
    bounded_git_probe(
        ["git", "-C", str(repo), "status", "--porcelain=2", "--branch"],
        timeout=15,
    )
    assert "MARKER.clean" in markers(tmp), markers(tmp)

    clear_markers(tmp)
    added = subprocess.run(
        ["git", "worktree", "add", "-b", "legacy-sub", str(tmp / "legacy-sub"), "HEAD"],
        cwd=repo,
        capture_output=True,
        text=True,
        env=noninteractive_git_env(env),
        stdin=subprocess.DEVNULL,
    )
    assert added.returncode == 0, added.stderr
    assert "MARKER.smudge" in markers(tmp), markers(tmp)

    clear_markers(tmp)
    status = subprocess.run(
        ["git", "-C", str(repo), "status", "--porcelain"],
        capture_output=True,
        text=True,
        env=env,
        stdin=subprocess.DEVNULL,
    )
    assert status.returncode == 0, status.stderr
    assert "MARKER.fsmonitor" in markers(tmp), markers(tmp)

    clear_markers(tmp)
    hooked = subprocess.run(
        ["git", "-C", str(repo), "worktree", "add", "-b", "legacy-hook", str(tmp / "legacy-hook"), "HEAD"],
        capture_output=True,
        text=True,
        env=env,
        stdin=subprocess.DEVNULL,
    )
    assert hooked.returncode == 0, hooked.stderr
    assert "MARKER.hook" in markers(tmp), markers(tmp)

    # The worktree still holds legacy-hook. A branch that is not checked out is what
    # the cleanup path deletes, and that ref update runs reference-transaction.
    subprocess.run(
        ["git", "-C", str(repo), "-c", "core.hooksPath=/dev/null", "branch", "pr-1"],
        check=True,
        env=env,
    )
    clear_markers(tmp)
    deleted = subprocess.run(
        ["git", "-C", str(repo), "branch", "-D", "pr-1"],
        capture_output=True,
        text=True,
        env=env,
        stdin=subprocess.DEVNULL,
    )
    assert deleted.returncode == 0, deleted.stderr
    assert "MARKER.hook" in markers(tmp), markers(tmp)


def hardened_paths_leave_markers_unwritten(tmp: Path) -> None:
    repo, _marker = make_repo(tmp)
    # Building the fixture runs git itself, so the hostile config fires there.
    # Everything after this clear is an agent-runtime call.
    clear_markers(tmp)
    retouch(repo / "README")
    block = build_coding_workspace_block(repo)
    assert "- Branch: main" in block, block
    assert "- Status:" in block, block

    status = worktree_gc._git(["status", "--porcelain"], cwd=str(repo))
    assert status.returncode == 0, status.stderr
    hint = git_state_hint(str(repo))
    assert hint is not None and hint.startswith("main @"), hint

    created = create_subagent_worktree(str(repo), "safe")
    assert created is not None, "subagent worktree was not created"
    assert (Path(created["path"]) / "README").read_text() == "hi\n"

    kanban_tree = tmp / "kanban-wt"
    kanban_add = kanban._git(repo, "worktree", "add", "-b", "kanban-safe", str(kanban_tree), "HEAD", timeout=60)
    assert kanban_add.returncode == 0, kanban_add.stderr
    assert (kanban_tree / "README").read_text() == "hi\n"

    session_tree = tmp / "session-wt"
    added = worktree_ops._worktree_add(str(repo), session_tree, "hermes/safe", "HEAD", "HEAD")
    assert added, "hermes -w worktree was not created"
    assert (session_tree / "README").read_text() == "hi\n"

    retouch(Path(created["path"]) / "README")
    retouch(kanban_tree / "README")
    finalized = finalize_subagent_worktree(created, prune=False)
    assert "inspection_failed" not in finalized, finalized
    assert worktree_ops._worktree_is_dirty(str(kanban_tree)) is False

    files = list(complete_helpers._git_repo_files(str(repo)))
    assert "README" in files, files

    worktree_ops._cleanup_failed_worktree_add(str(repo), session_tree, "hermes/safe")
    pruned = worktree_gc._git(["worktree", "prune"], cwd=str(repo))
    assert pruned.returncode == 0, pruned.stderr
    assert markers(tmp) == [], markers(tmp)


def main() -> None:
    home = Path(tempfile.mkdtemp(prefix="cuttlely-hermes-home-"))
    os.environ["HOME"] = str(home)
    os.environ["HERMES_HOME"] = str(home / "hermes")
    with tempfile.TemporaryDirectory(prefix="cuttlely-git-config-legacy-") as legacy:
        show_legacy_writes_markers(Path(legacy))
    with tempfile.TemporaryDirectory(prefix="cuttlely-git-config-fixed-") as fixed:
        hardened_paths_leave_markers_unwritten(Path(fixed))
    print("legacy git calls wrote the markers; hardened snapshot, create, and cleanup did not")


if __name__ == "__main__":
    main()
