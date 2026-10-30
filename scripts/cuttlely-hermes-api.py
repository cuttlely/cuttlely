#!/usr/bin/env python3
"""Boot the vendored Hermes API server on 127.0.0.1 and nothing else.

Messaging platforms, the TUI, and chat UIs are not started. The Cuttlely harness
client is the only caller, via POST /v1/runs.
"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HERMES = ROOT / "hermes"
HOST = "127.0.0.1"

os.environ["API_SERVER_ENABLED"] = "true"
os.environ["API_SERVER_HOST"] = HOST
os.environ.setdefault("HERMES_HOME", str(Path(os.environ.get("CUTTLELY_DATA_DIR", ROOT / ".cuttlely")) / "hermes"))

if os.environ.get("API_SERVER_HOST") != HOST:
    sys.stderr.write("Refusing to start Hermes on a non-loopback host.\n")
    sys.exit(1)

home = Path(os.environ["HERMES_HOME"])
home.mkdir(parents=True, exist_ok=True)
env_file = home / ".env"
if not env_file.exists():
    import secrets

    env_file.write_text(
        "\n".join(
            [
                "API_SERVER_ENABLED=true",
                f"API_SERVER_HOST={HOST}",
                f"API_SERVER_PORT={os.environ.get('API_SERVER_PORT', '8642')}",
                f"API_SERVER_KEY={secrets.token_hex(32)}",
                "",
            ]
        )
    )
    os.chmod(env_file, 0o600)

config = home / "config.yaml"
if not config.exists():
    config.write_text(
        "\n".join(
            [
                "gateway:",
                "  multiplex_profiles: true",
                "platform_toolsets:",
                "  api_server:",
                "    - delegation",
                "    - memory",
                "    - session_search",
                "agent:",
                "  disabled_toolsets:",
                "    - terminal",
                "    - browser",
                "    - code_execution",
                "",
            ]
        )
    )

sys.path.insert(0, str(HERMES))

# The agent runtime's own network calls that a harness never needs stay off: the model picker catalogs
# (polled every 20 minutes from Nous Research, GitHub and OpenRouter) and the tirith command scanner,
# which is downloaded from GitHub on first start and only guards the terminal toolset Cuttlely disables.
# A value already in config.yaml wins. models.dev lookups are off in the vendored code itself
# (hermes/patches/0005; CUTTLELY_MODELS_DEV=1 turns them on). See "What Cuttlely connects to" in SECURITY.md.
CUTTLELY_OFFLINE_DEFAULTS = {"model_catalog": {"enabled": False}, "security": {"tirith_enabled": False}}


def apply_offline_defaults(path):
    import hermes_yaml

    data = hermes_yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        return
    changed = False
    for section, values in CUTTLELY_OFFLINE_DEFAULTS.items():
        block = data.get(section)
        if block is None:
            block = data[section] = {}
        if not isinstance(block, dict):
            continue
        for key, value in values.items():
            if key not in block:
                block[key] = value
                changed = True
    if changed:
        path.write_text(hermes_yaml.safe_dump(data, sort_keys=False), encoding="utf-8")


try:
    apply_offline_defaults(config)
except Exception as error:  # noqa: BLE001
    sys.stderr.write(f"[Cuttlely] Could not apply the offline defaults to {config}: {error}\n")

# Admin > Server settings > Agent runtime > Limits > Maximum concurrent agent runs. The agent runtime reads
# gateway.api_server.max_concurrent_runs once when it starts, so the value is written here before it starts and
# a change applies on the next restart. Only that one key is touched. A marker file remembers the value Cuttlely
# wrote, so clearing the setting removes it again (back to the runtime default, 10) while a value an operator
# typed into config.yaml by hand is left alone.
MAX_CONCURRENT_RUNS_ENV = "CUTTLELY_HERMES_MAX_CONCURRENT_RUNS"
MAX_CONCURRENT_RUNS_LIMIT = 50
MAX_CONCURRENT_RUNS_MARKER = ".cuttlely-max-concurrent-runs"


def parse_max_concurrent_runs(raw):
    """A whole number from 0 to 50, or None (unset or unusable)."""
    text = (raw or "").strip()
    if not text.isdigit():
        return None
    value = int(text)
    return value if value <= MAX_CONCURRENT_RUNS_LIMIT else None


def write_text_atomic(path, text):
    import tempfile

    mode = None
    try:
        mode = path.stat().st_mode & 0o777
    except FileNotFoundError:
        pass
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def apply_max_concurrent_runs(path, raw, load, dump):
    """Merge the saved limit into config.yaml. Returns the value in effect from Cuttlely, or None."""
    marker = path.parent / MAX_CONCURRENT_RUNS_MARKER
    wanted = parse_max_concurrent_runs(raw)
    if (raw or "").strip() and wanted is None:
        sys.stderr.write(f"[Cuttlely] {MAX_CONCURRENT_RUNS_ENV} must be a whole number from 0 to {MAX_CONCURRENT_RUNS_LIMIT}. Leaving config.yaml as it is.\n")
        return None
    data = load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        return None
    try:
        written = int(marker.read_text(encoding="utf-8").strip())
    except (FileNotFoundError, ValueError):
        written = None
    gateway = data.get("gateway")
    api = gateway.get("api_server") if isinstance(gateway, dict) else None
    current = api.get("max_concurrent_runs") if isinstance(api, dict) else None
    if wanted is None:
        if written is not None and isinstance(api, dict) and current == written:
            del api["max_concurrent_runs"]
            if not api:
                del gateway["api_server"]
            write_text_atomic(path, dump(data))
        if written is not None:
            marker.unlink(missing_ok=True)
        return None
    if gateway is None:
        gateway = data["gateway"] = {}
    if not isinstance(gateway, dict):
        return None
    if api is None:
        api = gateway["api_server"] = {}
    if not isinstance(api, dict):
        return None
    if current != wanted or type(current) is not int:
        api["max_concurrent_runs"] = wanted
        write_text_atomic(path, dump(data))
    if written != wanted:
        write_text_atomic(marker, f"{wanted}\n")
    return wanted


def apply_saved_max_concurrent_runs(path):
    import hermes_yaml

    apply_max_concurrent_runs(
        path,
        os.environ.get(MAX_CONCURRENT_RUNS_ENV),
        hermes_yaml.safe_load,
        lambda data: hermes_yaml.safe_dump(data, sort_keys=False),
    )


try:
    apply_saved_max_concurrent_runs(config)
except Exception as error:  # noqa: BLE001
    sys.stderr.write(f"[Cuttlely] Could not apply {MAX_CONCURRENT_RUNS_ENV} to {config}: {error}\n")

os.chdir(HERMES)
sys.argv = ["hermes", "gateway"]


class QuietNousPortal:
    """Drop Hermes' "Nous Portal not configured" warnings.

    Cuttlely runs every model call through its own gateway, never Nous Portal, so these lines (about ten on each
    start) only tell a new user to run a login they do not need. Every other warning still shows.
    """

    def filter(self, record):
        message = record.getMessage()
        return not ("Nous" in message and ("hermes auth" in message or "hermes model" in message or "nous_auth_missing" in message))


def quiet_nous_portal():
    import logging

    for name in ("agent.auxiliary_client", "agent.auxiliary_unavailable"):
        logging.getLogger(name).addFilter(QuietNousPortal())


if os.environ.get("CUTTLELY_HERMES_NOUS_WARNINGS") != "show":
    quiet_nous_portal()


def preload_agent_modules():
    """Import the agent runtime once the gateway listens.

    The gateway imports run_agent and the tool registry on the first run, which took about
    10 s on a Windows-mounted checkout. Waiting for the port keeps these imports off the
    gateway's own startup path.
    """
    import importlib
    import socket
    import time

    port = int(os.environ.get("API_SERVER_PORT", "8642"))
    while True:
        try:
            socket.create_connection((HOST, port), timeout=1).close()
            break
        except OSError:
            time.sleep(1)
    started = time.monotonic()
    for name in ("run_agent", "model_tools", "hermes_cli.tools_config"):
        try:
            importlib.import_module(name)
        except Exception as error:  # noqa: BLE001
            sys.stderr.write(f"[Cuttlely] Could not preload {name}: {error}\n")
    sys.stderr.write(f"[Cuttlely] Hermes agent modules loaded in {time.monotonic() - started:.1f}s\n")


if os.environ.get("CUTTLELY_PRELOAD_HERMES", "true") != "false":
    import threading

    threading.Thread(target=preload_agent_modules, name="cuttlely-preload", daemon=True).start()

import cli  # noqa: E402

if hasattr(cli, "main"):
    cli.main(gateway=True)
else:
    sys.stderr.write("Vendored Hermes CLI has no main(). Install its Python dependencies from hermes/ and retry.\n")
    sys.exit(1)
