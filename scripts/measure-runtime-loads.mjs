#!/usr/bin/env node
// Records which files under hermes/ the agent runtime opens for Cuttlely.
//
//   node scripts/measure-runtime-loads.mjs           write hermes/CUTTLELY_LOADED.txt
//   node scripts/measure-runtime-loads.mjs --check   fail if a measured module is not on disk
//
// The run imports the modules the server boots and the harness toolsets a profile can enable,
// then closes over import statements and importlib string literals, including lazy imports.
// No new dependencies. Uses HERMES_PYTHON, else hermes/.venv, else python3 for the static pass.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HERMES = path.join(ROOT, 'hermes')
const OUT = path.join(HERMES, 'CUTTLELY_LOADED.txt')

function pythonBin() {
    if (process.env.HERMES_PYTHON && fs.existsSync(process.env.HERMES_PYTHON)) return process.env.HERMES_PYTHON
    const venv = path.join(HERMES, '.venv', 'bin', 'python')
    if (fs.existsSync(venv)) return venv
    return 'python3'
}

const DRIVER = String.raw`
import ast, json, os, sys, traceback
from pathlib import Path

hermes = Path(sys.argv[1]).resolve()
mode = sys.argv[2]
home = Path(sys.argv[3])
report_path = Path(sys.argv[4])

opened = set()
def _audit(event, args):
    if event != "open" or not args:
        return
    raw = args[0]
    if isinstance(raw, bytes):
        try:
            raw = raw.decode()
        except Exception:
            return
    if not isinstance(raw, str):
        return
    try:
        path = Path(raw).resolve()
    except Exception:
        return
    try:
        rel = path.relative_to(hermes).as_posix()
    except ValueError:
        return
    if rel.startswith("..") or rel in {".git", ".venv"} or rel.startswith((".git/", ".venv/", "__pycache__/")):
        return
    if "/__pycache__/" in rel or "site-packages" in rel or rel.endswith(".pyc"):
        return
    opened.add(rel)
sys.addaudithook(_audit)

# --- static graph ------------------------------------------------------------------------------------------

def module_of(path):
    rel = path.relative_to(hermes).with_suffix("")
    parts = list(rel.parts)
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)

files = {}
for path in hermes.rglob("*.py"):
    if any(part in {".venv", "__pycache__", "node_modules"} for part in path.parts):
        continue
    files[module_of(path)] = path

def parse(path):
    source = path.read_text(encoding="utf-8", errors="replace")
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return [], []
    top, nested = [], []
    def handle(node, bucket):
        if isinstance(node, ast.Import):
            bucket.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                bucket.append(("rel", node.level, node.module or "", [alias.name for alias in node.names]))
            elif node.module:
                bucket.append(node.module)
                bucket.extend(f"{node.module}.{alias.name}" for alias in node.names)
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            handle(node, top)
        else:
            for sub in ast.walk(node):
                if isinstance(sub, (ast.Import, ast.ImportFrom)):
                    handle(sub, nested)
    return top, nested

parsed = {}
for name, path in files.items():
    parsed[name] = parse(path)

def resolve_rel(current, level, module):
    parts = current.split(".") if current else []
    base = parts[:-level] if level <= len(parts) else []
    if module:
        base.extend(module.split("."))
    return ".".join(base)

def realize(current, item):
    if isinstance(item, tuple):
        name = resolve_rel(current, item[1], item[2])
        cands = [name, *[f"{name}.{part}" for part in item[3]]]
    else:
        cands = [item]
    found = []
    for cand in cands:
        parts = cand.split(".")
        while parts and ".".join(parts) not in files:
            parts.pop()
        if parts:
            found.append(".".join(parts))
    return found

def close(seeds, nested_ok):
    seen = set()
    stack = [name for name in seeds if name in files]
    while stack:
        name = stack.pop()
        if name in seen or name not in parsed:
            continue
        seen.add(name)
        top, nested = parsed[name]
        items = list(top)
        if nested_ok(name):
            items.extend(nested)
        for item in items:
            for target in realize(name, item):
                if target not in seen:
                    stack.append(target)
    return seen

# Lazy imports inside these modules can run on a harness turn. The rest of the tree is kept
# from modules that actually import during startup, not from every function in the CLI.
NESTED = set()
def hot_nested(name):
    if name in NESTED:
        return True
    return name == "agent" or name.startswith("agent.") or name in {
        "run_agent", "model_tools", "toolsets", "gateway.platforms.api_server",
    }

def cli_functions(names):
    path = files.get("cli")
    if path is None:
        return []
    tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    extra = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names:
            for sub in ast.walk(node):
                if isinstance(sub, (ast.Import, ast.ImportFrom)):
                    if isinstance(sub, ast.Import):
                        extra.extend(alias.name for alias in sub.names)
                    elif sub.module:
                        extra.append(sub.module)
    return extra

# Tool modules discovery imports: a module-level registry.register call.
registering = []
for name, path in files.items():
    if not (name == "tools" or name.startswith("tools.")):
        continue
    source = path.read_text(encoding="utf-8", errors="replace")
    if "registry" not in source or "register" not in source:
        continue
    try:
        tree = ast.parse(source)
    except SyntaxError:
        continue
    for node in tree.body:
        hit = False
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            func = node.value.func
            hit = isinstance(func, ast.Attribute) and func.attr == "register"
        elif isinstance(node, ast.For):
            hit = any(isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call) and isinstance(stmt.value.func, ast.Attribute) and stmt.value.func.attr == "register" for stmt in node.body)
        if hit:
            registering.append(name)
            break

# Bundled backend plugins load when the gateway discovers plugins. Platform plugins stay deferred
# until a messaging platform is enabled, which this server does not do. Model providers other than
# custom are selected by profile config; harness profiles set provider custom.
backend_modules = []
custom_provider = []
for manifest in (hermes / "plugins").rglob("plugin.yaml"):
    kind = ""
    text = manifest.read_text(encoding="utf-8", errors="replace")
    for line in text.splitlines():
        if line.startswith("kind:"):
            kind = line.split(":", 1)[1].strip().strip("'\"")
    init = manifest.parent / "__init__.py"
    if not init.exists():
        continue
    mod = module_of(init)
    if kind == "backend":
        backend_modules.append(mod)
    elif "model-providers/custom" in manifest.as_posix() or manifest.parent.name == "custom" and "model-providers" in manifest.as_posix():
        custom_provider.append(mod)

seeds = [
    "cli", "hermes_yaml", "run_agent", "model_tools", "toolsets", "tools.registry",
    "tools.delegate_tool", "tools.delegate_tool_toolsets", "tools.mcp_tool", "tools.mcp_tool_cuttlely",
    "tools.skills_tool", "gateway.run", "gateway.platforms.api_server", "hermes_cli.main",
    "tui_gateway.server", "hermes_constants", "hermes_logging", "providers", "providers.base",
    *registering, *backend_modules, *custom_provider,
]
static_mods = close(seeds, hot_nested)
# The gateway entry calls two functions on cli. Follow only those lazy imports, not the whole CLI.
static_mods |= close(cli_functions({"main", "_run_legacy_gateway"}), lambda name: False)
static_mods |= close(list(static_mods), lambda name: False)

# --- dynamic ------------------------------------------------------------------------------------------------

dynamic_notes = []
dynamic_mods = set()
os.environ["HERMES_HOME"] = str(home)
os.environ["API_SERVER_ENABLED"] = "true"
os.environ["API_SERVER_HOST"] = "127.0.0.1"
os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
sys.path.insert(0, str(hermes))
os.chdir(hermes)

def try_import(name):
    try:
        return __import__(name, fromlist=["*"])
    except Exception as error:
        dynamic_notes.append(f"import {name} failed: {type(error).__name__}: {error}")
        return None

for name in (
    "hermes_yaml", "cli", "run_agent", "model_tools", "toolsets", "tools.registry",
    "tools.delegate_tool", "tools.delegate_tool_toolsets", "tools.mcp_tool", "tools.mcp_tool_cuttlely",
    "tools.skills_tool", "gateway.run", "gateway.platforms.api_server", "hermes_cli.main",
    "hermes_cli.tools_config", "tui_gateway.server",
):
    try_import(name)

# Boot the API server the way scripts/cuttlely-hermes-api.py does, long enough for startup imports.
port = "8765"
os.environ["API_SERVER_PORT"] = port
(home / ".env").write_text(
    "\n".join([
        "API_SERVER_ENABLED=true",
        "API_SERVER_HOST=127.0.0.1",
        f"API_SERVER_PORT={port}",
        "API_SERVER_KEY=measure",
        "",
    ]),
    encoding="utf-8",
)
(home / "config.yaml").write_text(
    "\n".join([
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
        "model_catalog:",
        "  enabled: false",
        "security:",
        "  tirith_enabled: false",
        "",
    ]),
    encoding="utf-8",
)
import socket, threading, time
def _boot_gateway():
    try:
        import cli
        cli.main(gateway=True)
    except Exception as error:
        dynamic_notes.append(f"gateway boot failed: {type(error).__name__}: {error}")
threading.Thread(target=_boot_gateway, name="measure-gateway", daemon=True).start()
deadline = time.monotonic() + 90
while time.monotonic() < deadline:
    try:
        socket.create_connection(("127.0.0.1", int(port)), timeout=1).close()
        dynamic_notes.append("gateway port opened")
        break
    except OSError:
        time.sleep(0.5)
else:
    dynamic_notes.append("gateway port did not open")

try:
    from tools.registry import discover_builtin_tools, registry
    discover_builtin_tools()
except Exception as error:
    dynamic_notes.append(f"discover_builtin_tools failed: {type(error).__name__}: {error}")
    registry = None

try:
    from hermes_cli.plugins import discover_plugins
    discover_plugins()
except Exception as error:
    dynamic_notes.append(f"discover_plugins failed: {type(error).__name__}: {error}")

try:
    from providers import get_provider_profile
    get_provider_profile("custom")
except Exception as error:
    dynamic_notes.append(f"custom provider failed: {type(error).__name__}: {error}")

# Toolsets a harness profile can enable. Invoke the ones that only touch the temp home.
ENABLED = {
    "terminal", "process_manage", "execute_code", "read_file", "write_file", "patch", "search_files",
    "skills_list", "skill_view", "delegate_task", "memory", "session_search",
}
browser_names = set()
if registry is not None:
    try:
        entries = list(registry._tools.values())
    except Exception:
        entries = []
    for entry in entries:
        name = getattr(entry, "name", "")
        if name.startswith("browser_"):
            browser_names.add(name)
        handler = getattr(entry, "handler", None)
        module = getattr(handler, "__module__", "") or ""
        if module:
            dynamic_mods.add(module)
            if name in ENABLED or name.startswith("browser_"):
                NESTED.add(module)
        if name not in ENABLED and name not in browser_names:
            continue
        check = getattr(entry, "check_fn", None)
        if callable(check):
            try:
                check()
            except Exception:
                pass
        if not callable(handler):
            continue
        args = {}
        if name == "skills_list":
            args = {}
        elif name == "memory":
            args = {"action": "read", "target": "memory"}
        elif name == "session_search":
            args = {"query": "hello"}
        elif name == "read_file":
            sample = home / "sample.txt"
            sample.write_text("hello\n")
            args = {"path": str(sample)}
        elif name == "terminal":
            args = {"command": "echo ok"}
        elif name == "execute_code":
            args = {"code": "print(1)"}
        else:
            continue
        try:
            handler(args)
        except Exception as error:
            dynamic_notes.append(f"tool {name} call failed: {type(error).__name__}: {error}")

for module in list(sys.modules.values()):
    file = getattr(module, "__file__", None)
    if not file:
        continue
    try:
        rel = Path(file).resolve().relative_to(hermes).as_posix()
    except ValueError:
        continue
    if rel.endswith(".py"):
        dynamic_mods.add(module_of(Path(file).resolve()))

for name in files:
    if name.startswith("tools.mcp_") or name.startswith("gateway.platforms.api_server"):
        NESTED.add(name)

# Follow imports of modules the run actually loaded. Lazy imports are followed only for the
# agent loop, the API server and the toolsets a harness can enable.
followed = close(list(dynamic_mods), hot_nested)
followed |= close(list(followed), lambda name: False)

keep_mods = set(static_mods) | set(dynamic_mods) | set(followed)
# Directory scans import every model provider and every bundled backend because the directory
# exists. Harness profiles use provider custom, and the browser toolset sets backend off.
# Keep custom, every backend the browser toolset can select, and every module the closure
# imported for another reason. Drop the rest of the scanned plugins only when nothing else
# in the closure imports them.
scanned_optional = set()
for manifest in (hermes / "plugins").rglob("plugin.yaml"):
    rel_dir = manifest.parent.relative_to(hermes).as_posix()
    kind = ""
    for line in manifest.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("kind:"):
            kind = line.split(":", 1)[1].strip().strip("'\"")
    keep_plugin = kind == "backend" and (rel_dir.startswith("plugins/browser") or rel_dir.startswith("plugins/web"))
    keep_plugin = keep_plugin or rel_dir == "plugins/model-providers/custom"
    if keep_plugin or kind not in {"backend", "model-provider", "platform"}:
        continue
    for path in manifest.parent.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(hermes).as_posix()
        if path.suffix == ".py":
            scanned_optional.add(module_of(path))
        scanned_optional.add(rel)

# A scanned plugin stays when a module outside that plugin imports it.
outside = set()
for name in keep_mods:
    path = files.get(name)
    if path is None:
        continue
    rel = path.relative_to(hermes).as_posix()
    if rel not in scanned_optional and name not in scanned_optional:
        outside.add(name)
anchored = close(list(outside | {m for m in keep_mods if m not in scanned_optional}), hot_nested)
# Re-add the plugins we decided to keep, with their own imports.
explicit = []
for name in list(keep_mods):
    path = files.get(name)
    if path is None:
        continue
    rel = path.relative_to(hermes).as_posix()
    if name in scanned_optional or rel in scanned_optional:
        continue
    explicit.append(name)
for name in backend_modules:
    if name.startswith("plugins.browser") or name.startswith("plugins.web"):
        explicit.append(name)
explicit.extend(custom_provider)
keep_mods = close(explicit, hot_nested) | {name for name in anchored if name not in scanned_optional}
keep_mods |= close([name for name in keep_mods], lambda name: False)

keep = set()
for name in keep_mods:
    path = files.get(name)
    if path is None:
        continue
    keep.add(path.relative_to(hermes).as_posix())
for rel in opened:
    # Ignore files the scan opened only inside a plugin we are not keeping.
    if rel in scanned_optional:
        continue
    top = rel.split("/", 1)[0]
    if top in {"plugins"} and any(rel == item or rel.startswith(item) for item in scanned_optional):
        continue
    keep.add(rel)

tracked = set()
try:
    import subprocess
    raw = subprocess.check_output(
        ["git", "-C", str(hermes.parent), "ls-files", "-z", "--", "hermes"],
        stderr=subprocess.DEVNULL,
    )
    for item in raw.split(b"\0"):
        if item.startswith(b"hermes/"):
            tracked.add(item[len(b"hermes/"):].decode())
except Exception as error:
    dynamic_notes.append(f"git file list failed: {error}")
if tracked:
    keep = {path for path in keep if path in tracked}

missing = []
for name in sorted(keep_mods):
    path = files.get(name)
    if path is None or not path.exists():
        missing.append(name)

report = {
    "keep": sorted(path for path in keep if not path.startswith((".git", ".venv")) and "site-packages" not in path and "/__pycache__/" not in path),
    "missing": missing,
    "notes": dynamic_notes[:80],
    "modules": len(keep_mods),
    "opened": len(opened),
}
report_path.write_text(json.dumps(report), encoding="utf-8")
os._exit(0)
`

function header(count) {
    return [
        '# Files of the vendored agent runtime that Cuttlely loads, one path per line.',
        '# Generated by: node scripts/measure-runtime-loads.mjs',
        '# Method: import the server entry (cli gateway, API server, agent loop, tool registry),',
        '# discover built-in tools, discover bundled plugins, load the custom model provider,',
        '# and call the harness toolsets a profile can enable (terminal, browser, code execution,',
        '# file, skills_read, delegation, memory, session_search, MCP). Then close over import',
        '# statements and importlib literals, including lazy imports inside gateway, agent and tool modules.',
        '# Messaging platform plugins and adapters stay out: the server only enables the API server.',
        '# Model-provider plugins other than custom stay out: harness profiles set provider custom.',
        '# Directory-scanned backends other than browser and web stay out: no harness toolset selects them.',
        '# pnpm hermes:vendor also keeps package __init__ files, license files, data files named by a',
        '# kept module, and files a local patch edits. Re-measure after an upstream bump, then re-vendor the same pin.',
        `# modules recorded: ${count}`,
        ''
    ].join('\n')
}

function main() {
    const check = process.argv.includes('--check')
    const bin = pythonBin()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-runtime-measure-'))
    const driver = path.join(home, 'measure.py')
    const reportFile = path.join(home, 'report.json')
    fs.writeFileSync(driver, DRIVER)
    const res = spawnSync(bin, [driver, HERMES, check ? 'check' : 'write', home, reportFile], {
        encoding: 'utf8',
        timeout: 150000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', HERMES_HOME: home }
    })
    if (res.stderr) process.stderr.write(res.stderr)
    if (res.status !== 0 || !fs.existsSync(reportFile)) {
        console.error((res.stderr || res.stdout || `${bin} failed`).trim())
        process.exit(res.status || 1)
    }
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
    const keep = report.keep.filter((file) => file && !file.startsWith('.venv/'))
    if (check) {
        const missing = keep.filter((file) => !fs.existsSync(path.join(HERMES, file)))
        if (missing.length || report.missing.length) {
            for (const file of missing.slice(0, 40)) console.error(`missing file: ${file}`)
            for (const name of report.missing.slice(0, 40)) console.error(`missing module: ${name}`)
            console.error(`measure-runtime-loads: ${missing.length + report.missing.length} missing`)
            process.exit(1)
        }
        console.log(`measure-runtime-loads: no missing module (${keep.length} files).`)
        return
    }
    const body = `${header(report.modules)}${keep.join('\n')}\n`
    fs.writeFileSync(OUT, body)
    console.log(`measure-runtime-loads: wrote ${keep.length} paths (${report.modules} modules, ${report.opened} opens).`)
    if (report.notes.length) {
        console.log('Notes:')
        for (const note of report.notes) console.log(`  ${note}`)
    }
}

main()
