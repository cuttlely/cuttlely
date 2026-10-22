#!/usr/bin/env bash
# Create hermes/.venv for the vendored Hermes runtime with uv.
#
#   bash scripts/setup-hermes.sh          # Python from hermes/.python-version (3.14), downloaded if missing
#   bash scripts/setup-hermes.sh 3.12     # a version uv can find or download
#   bash scripts/setup-hermes.sh /usr/bin/python3.12
#
# Python 3.14 installs the locked set from hermes/uv.lock. Upstream locks 3.14 only and marks every
# runtime dependency `python_version >= '3.14'`, so 3.11-3.13 resolve those same requirements unfrozen.
# Both paths also install the Hermes mcp extra. The post-check imports aiohttp, cli, and mcp.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HERMES="$ROOT/hermes"
VENV="$HERMES/.venv"
PYTHON="$VENV/bin/python"
AIOHTTP="aiohttp==3.14.4"

if ! command -v uv >/dev/null 2>&1; then
    echo "uv is required. Install it with: curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
    exit 1
fi

cd "$HERMES"
if [[ $# -gt 0 ]]; then
    uv venv --clear --python "$1" "$VENV"
else
    uv venv --clear "$VENV"
fi

VERSION="$("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
if ! "$PYTHON" -c 'import sys; sys.exit(0 if (3, 11) <= sys.version_info[:2] < (3, 15) else 1)'; then
    echo "Hermes needs Python 3.11 to 3.14 (hermes/pyproject.toml); $PYTHON is $VERSION." >&2
    exit 1
fi

if [[ "$VERSION" == "3.14" ]]; then
    uv sync --frozen --extra mcp --python "$PYTHON"
else
    WORK="$(mktemp -d)"
    trap 'rm -rf "$WORK"' EXIT
    "$PYTHON" - "$WORK" <<'PY'
import re
import sys
import tomllib
from pathlib import Path

marker = r"python_version\s*>=\s*'3\.14'"

def unlock(requirement):
    requirement = re.sub(r"\s+and\s+" + marker, "", requirement)
    requirement = re.sub(marker + r"\s+and\s+", "", requirement)
    return re.sub(r"\s*;\s*" + marker + r"\s*$", "", requirement)

project = tomllib.loads(Path("pyproject.toml").read_text())
work = Path(sys.argv[1])
work.joinpath("requirements.txt").write_text(
    "\n".join(unlock(r) for r in project["project"]["dependencies"]) + "\n"
)
work.joinpath("overrides.txt").write_text(
    "\n".join(unlock(r) for r in project["tool"]["uv"].get("override-dependencies", [])) + "\n"
)
extras = project["project"].get("optional-dependencies", {})
work.joinpath("mcp.txt").write_text("\n".join(unlock(r) for r in extras.get("mcp", [])) + "\n")
PY
    echo "hermes/uv.lock covers Python 3.14 only; resolving hermes/pyproject.toml dependencies for $VERSION."
    uv pip install --python "$PYTHON" -r "$WORK/requirements.txt" --overrides "$WORK/overrides.txt"
    echo "Installing the Hermes mcp extra for $VERSION."
    uv pip install --python "$PYTHON" -r "$WORK/mcp.txt" --overrides "$WORK/overrides.txt"
fi

uv pip install --python "$PYTHON" "$AIOHTTP"

if ! IMPORT_ERROR="$("$PYTHON" -c 'import aiohttp, cli, mcp' 2>&1)"; then
    echo "hermes/.venv was created, but it cannot import Hermes:" >&2
    echo "    $(printf '%s\n' "$IMPORT_ERROR" | tail -n 1)" >&2
    exit 1
fi
echo "Hermes Python ready: $PYTHON (Python $VERSION, mcp extra)"
