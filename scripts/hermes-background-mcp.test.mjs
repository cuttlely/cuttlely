// Real gateway boot with a stdio peer that never answers initialize. Model traffic stays on a local fake endpoint.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENV_PYTHON = path.join(ROOT, 'hermes', '.venv', 'bin', 'python')
const PYTHON = process.env.HERMES_PYTHON || (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3')
const available = spawnSync(PYTHON, ['-c', 'import aiohttp, mcp']).status === 0
if (!available && (process.env.CUTTLELY_REQUIRE_HERMES_RUNTIME === '1' || process.env.HERMES_PYTHON || fs.existsSync(VENV_PYTHON))) {
    assert.fail('The configured Hermes Python must import aiohttp and mcp; repair the runtime instead of skipping live boot tests.')
}
const integrationSkip = available ? false : 'Hermes Python with aiohttp and mcp is required for the live boot tests'

const CONCURRENCY_PROBE = String.raw`
import asyncio, contextlib, logging, sys, threading, time, types
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / "hermes"))
from hermes_constants import get_hermes_home, set_hermes_home_override, reset_hermes_home_override
from gateway.cuttlely_mcp_startup import GatewayMCPDiscovery, _pending, wait_for_gateway_mcp_discovery

root = Path(sys.argv[2])
homes = [root / str(i) for i in range(6)]
for home in homes:
    home.mkdir()
entered = [threading.Event() for _ in homes]
release = [threading.Event() for _ in homes]
guard = threading.Lock()
active = maximum = 0

@contextlib.contextmanager
def scope(home):
    token = set_hermes_home_override(str(home))
    try:
        yield
    finally:
        reset_hermes_home_override(token)

def discover():
    global active, maximum
    index = homes.index(get_hermes_home())
    with guard:
        active += 1
        maximum = max(maximum, active)
    entered[index].set()
    assert release[index].wait(5), "test did not release discovery"
    with guard:
        active -= 1
    if index == 2:
        raise RuntimeError("failed peer")

oauth = types.ModuleType("tools.mcp_oauth")
oauth.suppress_interactive_oauth = contextlib.nullcontext
transport = types.ModuleType("tools.mcp_tool_discovery")
transport.discover_mcp_tools = discover
transport.get_mcp_status = lambda: []
startup = types.ModuleType("hermes_cli.mcp_startup")
startup._resolve_discovery_timeout = lambda *args, **kwargs: 0.05
sys.modules.update({"tools.mcp_oauth": oauth, "tools.mcp_tool_discovery": transport,
                    "hermes_cli.mcp_startup": startup})

async def pulse():
    # Keep the test loop ticking even on hosts that suppress cross-thread socket wakeups.
    while True:
        await asyncio.sleep(0.01)

async def main():
    asyncio.create_task(pulse())
    discovery = GatewayMCPDiscovery([(str(i), h) for i, h in enumerate(homes)], scope, logging.getLogger("probe"))
    assert len(_pending) == 6  # queued profiles have their own gate before serving starts
    discovery.start()
    for event in entered[:4]:
        assert await asyncio.to_thread(event.wait, 2)
    assert maximum == 4
    assert not entered[4].is_set() and not entered[5].is_set()
    with scope(homes[5]):
        started = time.monotonic()
        assert await asyncio.to_thread(wait_for_gateway_mcp_discovery)
        assert 0.04 <= time.monotonic() - started < 2
    release[0].set()
    assert await asyncio.to_thread(discovery.events[str(homes[0])].wait, 2)
    with scope(homes[0]):
        assert not wait_for_gateway_mcp_discovery()  # completed profile ignores other pending profiles
    assert await asyncio.to_thread(entered[4].wait, 2)
    for event in release:
        event.set()
    await discovery.task
    assert maximum == 4 and not _pending
    await discovery.stop()

    for event in release + entered:
        event.clear()
    cancelled = GatewayMCPDiscovery([(str(i), h) for i, h in enumerate(homes)], scope, logging.getLogger("probe"))
    cancelled.start()
    for event in entered[:4]:
        assert await asyncio.to_thread(event.wait, 2)
    await cancelled.stop()
    assert cancelled.task.cancelled() and not _pending
    assert not entered[4].is_set() and not entered[5].is_set()
    for event in release:
        event.set()

loop = asyncio.new_event_loop()
asyncio.set_event_loop(loop)
loop.run_until_complete(main())
loop.run_until_complete(loop.shutdown_default_executor())
remaining = asyncio.all_tasks(loop)
for task in remaining:
    task.cancel()
loop.run_until_complete(asyncio.gather(*remaining, return_exceptions=True))
loop.close()
print("profile concurrency, bounded gates, failure isolation and cancellation passed")
`

test('boot discovery caps profiles at four, gates queued profiles individually, and cancels queued work', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-mcp-concurrency-'))
    try {
        const result = spawnSync(PYTHON, ['-c', CONCURRENCY_PROBE, ROOT, directory], {
            encoding: 'utf8',
            timeout: 15_000,
            env: { ...process.env, HOME: directory, DATABASE_PATH: directory, HERMES_HOME: directory, CUTTLELY_DATA_DIR: directory }
        })
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
        assert.match(result.stdout, /failure isolation and cancellation passed/)
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

const SERVER = String.raw`
import json, sys
for line in sys.stdin:
    request = json.loads(line)
    if sys.argv[1] == "silent" or "id" not in request:
        continue
    method = request.get("method")
    if method == "initialize":
        result = {"protocolVersion": request["params"]["protocolVersion"],
                  "capabilities": {"tools": {}}, "serverInfo": {"name": "good", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "hello", "description": "Test tool", "inputSchema": {"type": "object"}}]}
    else:
        result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
`

const DRIVER = String.raw`
import json, os, runpy, sys, threading, time
from pathlib import Path
root = Path(sys.argv[1])
home = Path(os.environ["HERMES_HOME"])
sys.path.insert(0, str(root / "hermes"))

# Observe the real API discovery gate without replacing discovery or agent construction.
import gateway.cuttlely_mcp_startup as startup
from hermes_constants import hermes_home_key
original_wait = startup.wait_for_gateway_mcp_discovery
def report_gate(name, value):
    tmp = home / (name + ".tmp")
    tmp.write_text(json.dumps(value))
    os.replace(tmp, home / (name + ".json"))

def observed_wait():
    if hermes_home_key() != hermes_home_key(home / "profiles" / "pending"):
        return original_wait()
    report_gate("run-wait", {
        "pending": hermes_home_key() in startup._pending,
        "off_loop": threading.current_thread() is not threading.main_thread()})
    started = time.monotonic()
    try:
        return original_wait()
    finally:
        report_gate("run-wait-done", {"elapsed": time.monotonic() - started})
startup.wait_for_gateway_mcp_discovery = observed_wait

def monitor():
    # The module is imported above for the run-gate probe, so wait until the runtime has
    # started discovery (and finished its own imports) before importing from this thread.
    while not startup._pending:
        time.sleep(0.05)
    from gateway.cuttlely_mcp_startup import _pending, wait_for_gateway_mcp_discovery
    from hermes_constants import hermes_home_key
    from gateway.run import _profile_runtime_scope
    from tools.mcp_tool_discovery import get_mcp_status
    gate = None
    while True:
        snapshot = {}
        for name, directory in [("default", home), ("ready", home / "profiles" / "ready")]:
            with _profile_runtime_scope(directory):
                snapshot[name] = get_mcp_status()
        if (gate is None and _pending and any(s["connected"] for s in snapshot["ready"])
                and hermes_home_key(home / "profiles" / "ready") not in _pending):
            with _profile_runtime_scope(home / "profiles" / "ready"):
                started = time.monotonic()
                ready_waited = wait_for_gateway_mcp_discovery()
                ready_elapsed = time.monotonic() - started
            with _profile_runtime_scope(home):
                started = time.monotonic()
                waited = wait_for_gateway_mcp_discovery()
                gate = {"ready_elapsed": ready_elapsed, "ready_waited": ready_waited, "pending_elapsed": time.monotonic() - started, "waited": waited}
        snapshot["gate"] = gate
        snapshot["pending"] = list(_pending)
        tmp = home / "report.tmp"
        tmp.write_text(json.dumps(snapshot))
        os.replace(tmp, home / "report.json")
        time.sleep(0.05)

threading.Thread(target=monitor, daemon=True).start()
runpy.run_path(str(root / "scripts" / "cuttlely-hermes-api.py"), run_name="__main__")
`

async function waitFor(check, timeout, diagnostics) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        const value = await check()
        if (value) return value
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.fail(`Timed out: ${diagnostics()}`)
}

async function boot(t, shortTimeout) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-background-mcp-'))
    const home = path.join(directory, 'hermes')
    fs.mkdirSync(path.join(home, 'profiles', 'ready'), { recursive: true })
    fs.mkdirSync(path.join(home, 'profiles', 'pending'), { recursive: true })
    const modelServer = http.createServer((_request, response) => {
        response.writeHead(400, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'Local test endpoint: no model', type: 'invalid_request_error' } }))
    })
    modelServer.listen(0, '127.0.0.1')
    await once(modelServer, 'listening')
    t.after(() => new Promise((resolve) => modelServer.close(resolve)))
    const server = path.join(directory, 'server.py')
    fs.writeFileSync(server, SERVER)
    const peer = (mode) => ({ command: PYTHON, args: [server, mode], ...(shortTimeout && mode === 'silent' ? { connect_timeout: 1 } : {}) })
    const config = {
        gateway: { multiplex_profiles: true },
        model: { provider: 'custom', default: 'test-model', base_url: `http://127.0.0.1:${modelServer.address().port}/v1` },
        platform_toolsets: { api_server: [] },
        model_catalog: { enabled: false },
        security: { tirith_enabled: false },
        ...(shortTimeout ? { mcp_single_query_discovery_timeout: 0.3 } : {}),
        mcp_servers: { bad: peer('silent'), good: peer('good') }
    }
    fs.writeFileSync(path.join(home, 'config.yaml'), JSON.stringify(config))
    fs.writeFileSync(path.join(home, 'profiles', 'pending', 'config.yaml'), JSON.stringify(config))
    fs.writeFileSync(
        path.join(home, 'profiles', 'ready', 'config.yaml'),
        JSON.stringify({ ...config, mcp_servers: { other: peer('good') } })
    )
    const socket = net.createServer()
    socket.listen(0, '127.0.0.1')
    await once(socket, 'listening')
    const port = socket.address().port
    await new Promise((resolve) => socket.close(resolve))
    let output = ''
    const started = Date.now()
    const apiKey = randomBytes(32).toString('hex')
    fs.writeFileSync(path.join(home, 'profiles', 'pending', '.env'), `API_SERVER_KEY=${apiKey}\n`, { mode: 0o600 })
    const child = spawn(PYTHON, ['-u', '-c', DRIVER, ROOT], {
        cwd: ROOT,
        env: {
            ...process.env,
            HOME: directory,
            DATABASE_PATH: directory,
            SECRETKEY_PATH: directory,
            BLOB_STORAGE_PATH: directory,
            CUTTLELY_DATA_DIR: directory,
            LOG_PATH: directory,
            HERMES_HOME: home,
            HERMES_RUNTIME_DIR: path.join(directory, 'runtime'),
            API_SERVER_PORT: String(port),
            API_SERVER_KEY: apiKey,
            CUTTLELY_PRELOAD_HERMES: 'false',
            PYTHONDONTWRITEBYTECODE: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', (data) => (output += data))
    child.stderr.on('data', (data) => (output += data))
    const closed = once(child, 'close')
    t.after(async () => {
        child.kill('SIGTERM')
        const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
        const [code, signal] = await closed
        clearTimeout(timer)
        assert.equal(signal, null, output)
        assert.equal(code, 0, output)
        fs.rmSync(directory, { recursive: true, force: true })
    })
    await waitFor(
        async () => {
            try {
                const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })
                return response.ok
            } catch {
                return false
            }
        },
        29_000,
        () => output
    )
    const healthMs = Date.now() - started
    assert.ok(healthMs < 30_000, output)
    t.diagnostic(
        `Hermes /health with never-answering initialize: ${healthMs} ms (${
            shortTimeout ? 'short stub timeout' : 'default 60s server timeout'
        })`
    )
    const report = () => {
        try {
            return JSON.parse(fs.readFileSync(path.join(home, 'report.json'), 'utf8'))
        } catch {
            return null
        }
    }
    return {
        report,
        home,
        url: `http://127.0.0.1:${port}`,
        apiKey,
        diagnostics: () => {
            let logs = ''
            for (const name of ['gateway.log', 'hermes.log']) {
                try {
                    logs += fs.readFileSync(path.join(home, 'logs', name), 'utf8')
                } catch {
                    /* Not created yet. */
                }
            }
            return output + logs
        }
    }
}

test(
    'health serves before default-timeout discovery; a ready profile never waits for another profile',
    { skip: integrationSkip },
    async (t) => {
        const { report, diagnostics, home, url, apiKey } = await boot(t, false)
        const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
        const response = await fetch(`${url}/p/pending/v1/runs`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ input: 'Test pending discovery' }),
            signal: AbortSignal.timeout(2000)
        })
        assert.equal(response.status, 202, diagnostics())
        const { run_id: runId } = await response.json()
        await waitFor(() => fs.existsSync(path.join(home, 'run-wait.json')), 5000, diagnostics)
        const gate = JSON.parse(fs.readFileSync(path.join(home, 'run-wait.json'), 'utf8'))
        assert.equal(gate.pending, true)
        let polls = 0
        await waitFor(
            async () => {
                const started = performance.now()
                const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })
                assert.equal(health.status, 200)
                assert.ok(performance.now() - started < 1000, diagnostics())
                polls += 1
                return fs.existsSync(path.join(home, 'run-wait-done.json'))
            },
            30_000,
            diagnostics
        )
        assert.ok(polls > 10, `Only ${polls} health polls during discovery`)
        assert.equal(gate.off_loop, true)
        const completedGate = JSON.parse(fs.readFileSync(path.join(home, 'run-wait-done.json'), 'utf8'))
        assert.ok(completedGate.elapsed >= 14 && completedGate.elapsed < 30, JSON.stringify(completedGate))
        await waitFor(
            async () => {
                const status = await fetch(`${url}/p/pending/v1/runs/${runId}`, { headers, signal: AbortSignal.timeout(1000) })
                assert.equal(status.status, 200)
                return (await status.json()).status === 'failed'
            },
            5000,
            diagnostics
        )
        t.diagnostic(`${polls} /health polls answered under 1 s during the pending profile's run`)
        const result = await waitFor(
            () => {
                const value = report()
                return value?.gate?.waited && value.default.some((s) => s.name === 'good' && s.connected) && value
            },
            // The pending profile's run waits the full 15 s bound; leave room for a loaded CI host.
            60_000,
            diagnostics
        )
        assert.ok(result.pending.length > 0)
        assert.equal(result.gate.ready_waited, false)
        assert.ok(result.gate.ready_elapsed < 2, JSON.stringify(result))
        assert.ok(result.gate.pending_elapsed >= 14 && result.gate.pending_elapsed < 30, JSON.stringify(result))
        assert.equal(result.default.find((s) => s.name === 'bad').tools, 0)
        assert.ok(result.ready.find((s) => s.name === 'other').tools > 0)
    }
)

test('a timed-out MCP peer drops only its own tools and logs profile and server', { skip: integrationSkip }, async (t) => {
    const { report, diagnostics } = await boot(t, true)
    const result = await waitFor(
        () => {
            const value = report()
            return value && !value.pending.length && value.default.some((s) => s.name === 'bad' && s.status === 'failed') && value
        },
        30_000,
        diagnostics
    )
    assert.equal(result.default.find((s) => s.name === 'bad').tools, 0)
    assert.ok(result.default.find((s) => s.name === 'good').tools > 0, diagnostics())
    assert.ok(result.ready.find((s) => s.name === 'other').tools > 0)
    assert.match(diagnostics(), /MCP discovery start for profile 'default'/)
    assert.match(diagnostics(), /MCP discovery end for profile 'default': .*failed servers: bad, elapsed/)
    assert.match(diagnostics(), /MCP discovery failed for profile 'default', server 'bad'/)
})
