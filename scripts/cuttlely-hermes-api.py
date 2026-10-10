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
