// A running mcp-bridge keeps the gateway token Hermes put in its environment. A profile
// recompile mints a new one, revokes the old, and writes the new one to the profile .env.
// The bridge is told that path (CUTTLELY_HARNESS_PROFILE_ENV) and re-reads it after a 401.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-bridge-token-'))
const hermesHome = path.join(dataDir, 'custom-hermes')
process.env.CUTTLELY_DATA_DIR = dataDir
process.env.CUTTLELY_HERMES_HOME = hermesHome
delete process.env.HERMES_API_URL
delete process.env.CUTTLELY_HARNESS_GATEWAY_URL
delete process.env.CUTTLELY_HARNESS_GATEWAY_TOKEN
delete process.env.CUTTLELY_HARNESS_GATEWAY_PORT
delete process.env.HERMES_HOME

const { saveHarness, deleteHarness } = await import('./store.mjs')
const { forgetProfileToken, registerProfileToken, setGatewayContext, startGateway } = await import('./gateway.mjs')
const { compileProfile } = await import('./profile.mjs')

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

let tail = Promise.resolve()
function serial(name, fn) {
    const previous = tail
    let release
    tail = new Promise((resolve) => {
        release = resolve
    })
    test(name, async () => {
        await previous.catch(() => {})
        try {
            await fn()
        } finally {
            release()
        }
    })
}

function mint() {
    const token = crypto.randomBytes(32).toString('base64url')
    assert.match(token, TOKEN_RE)
    return token
}

function writeEnvKey(file, token) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `OPENAI_API_KEY=${token}\n`, { mode: 0o600 })
}

function readEnvKey(file) {
    const text = fs.readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
        const trimmed = line.trim()
        const eq = trimmed.indexOf('=')
        if (eq === -1 || trimmed.slice(0, eq) !== 'OPENAI_API_KEY') continue
        return trimmed.slice(eq + 1).trim()
    }
    return ''
}

function bridgeEnvFromConfig(file) {
    const env = {}
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const match = line.match(/^\s+(CUTTLELY_HARNESS_[A-Z0-9_]+):\s*(.*)$/)
        if (!match) continue
        env[match[1]] = JSON.parse(match[2])
    }
    return env
}

function harnessRecord(name, specialistModel) {
    return {
        name,
        createdAt: '2026-01-01T00:00:00.000Z',
        chief: { instructions: 'Route.', model: { nodeName: 'chatXAI', inputs: { modelName: 'grok' } } },
        specialists: [
            {
                name: 'worker',
                instructions: 'Work.',
                // A specialist gets its own profile when it needs an agent loop (shell, browser, files, playbooks).
                // A different model then makes the compile mint a new gateway token.
                ...(specialistModel ? { shell: true, model: { nodeName: 'chatXAI', inputs: { modelName: specialistModel } } } : {}),
                modules: [{ nodeName: 'echoNode', label: 'Echo' }],
                mcpServers: []
            }
        ]
    }
}

function openBridge(harness, specialist, env, cwd) {
    const child = spawn(
        process.execPath,
        [path.join(root, 'packages', 'harness', 'mcp-bridge.mjs'), '--harness', harness, '--specialist', specialist],
        {
            cwd,
            env: {
                PATH: process.env.PATH || '',
                HOME: process.env.HOME || '',
                CUTTLELY_HARNESS_GATEWAY_URL: env.CUTTLELY_HARNESS_GATEWAY_URL,
                CUTTLELY_HARNESS_GATEWAY_TOKEN: env.CUTTLELY_HARNESS_GATEWAY_TOKEN,
                CUTTLELY_HARNESS_PROFILE_ENV: env.CUTTLELY_HARNESS_PROFILE_ENV
            },
            stdio: ['pipe', 'pipe', 'pipe']
        }
    )
    let buffer = ''
    let stderr = ''
    const pending = []
    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8')
    })
    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            newline = buffer.indexOf('\n')
            if (!line) continue
            const waiter = pending.shift()
            if (!waiter) continue
            try {
                waiter.resolve(JSON.parse(line))
            } catch (error) {
                waiter.reject(error)
            }
        }
    })
    child.on('exit', () => {
        const error = new Error('bridge exited')
        while (pending.length) pending.shift().reject(error)
    })
    let nextId = 1
    function rpc(method, params) {
        const id = nextId
        nextId += 1
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`bridge timed out on ${method}`)), 8000)
            pending.push({
                resolve(message) {
                    clearTimeout(timer)
                    resolve(message)
                },
                reject(error) {
                    clearTimeout(timer)
                    reject(error)
                }
            })
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
        })
    }
    return {
        rpc,
        stderr: () => stderr,
        async close() {
            if (child.exitCode != null || child.signalCode != null) return
            child.kill()
            await new Promise((resolve) => child.once('exit', resolve))
        }
    }
}

function shown(message, tokens) {
    let text = String(message?.result?.content?.[0]?.text || '')
    for (const token of tokens) {
        if (token) text = text.split(token).join('[key]')
    }
    return text.slice(0, 180)
}

function assertToolOk(message, tokens) {
    assert.equal(message.result?.isError, false, shown(message, tokens))
    assert.equal(message.result?.content?.[0]?.text, 'tool-ok')
}

function assertNoToken(stderr, tokens) {
    for (const token of tokens) {
        if (token && stderr.includes(token)) throw new Error('bridge stderr contains a gateway token')
    }
}

async function withHarness(name, fn) {
    const previous = setGatewayContext(async () => ({
        flowOptions: { appDataSource: { ready: true } },
        loadNode: async (nodeName) => {
            if (nodeName !== 'echoNode') throw new Error('unexpected node')
            return class {
                async run() {
                    return 'tool-ok'
                }
            }
        }
    }))
    const gateway = await startGateway({ port: 0 })
    const url = `http://127.0.0.1:${gateway.port}/`
    const workspace = path.join(dataDir, 'workspaces', `${name}--worker`)
    fs.mkdirSync(workspace, { recursive: true })
    try {
        await fn({ url, workspace, port: gateway.port })
    } finally {
        setGatewayContext(previous)
        await gateway.close()
        deleteHarness(name)
        fs.rmSync(path.join(hermesHome, 'profiles', name), { recursive: true, force: true })
        fs.rmSync(path.join(hermesHome, 'profiles', `${name}--worker`), { recursive: true, force: true })
        fs.rmSync(workspace, { recursive: true, force: true })
    }
}

serial('a recompiled profile token is picked up by the running bridge', async () => {
    const first = mint()
    const next = mint()
    const envFile = path.join(dataDir, 'bridge-env', 'tokrefresh.env')
    await withHarness('tokrefresh', async ({ url, workspace }) => {
        saveHarness(harnessRecord('tokrefresh'), { overwrite: true })
        writeEnvKey(envFile, first)
        registerProfileToken({
            token: first,
            harnessName: 'tokrefresh',
            specialistName: 'worker',
            modelKey: 'k',
            profileName: 'tokrefresh--worker'
        })
        const bridge = openBridge(
            'tokrefresh',
            'worker',
            {
                CUTTLELY_HARNESS_GATEWAY_URL: url,
                CUTTLELY_HARNESS_GATEWAY_TOKEN: first,
                CUTTLELY_HARNESS_PROFILE_ENV: envFile
            },
            workspace
        )
        try {
            const before = await bridge.rpc('tools/call', { name: 'echoNode', arguments: { input: 'ping' } })
            assertToolOk(before, [first, next])
            writeEnvKey(envFile, next)
            registerProfileToken({
                token: next,
                harnessName: 'tokrefresh',
                specialistName: 'worker',
                modelKey: 'k',
                profileName: 'tokrefresh--worker'
            })
            const rotated = await bridge.rpc('tools/call', { name: 'echoNode', arguments: { input: 'ping' } })
            assertToolOk(rotated, [first, next])
            fs.rmSync(envFile, { force: true })
            const cached = await bridge.rpc('tools/call', { name: 'echoNode', arguments: { input: 'ping' } })
            assertToolOk(cached, [first, next])
            assertNoToken(bridge.stderr(), [first, next])
        } finally {
            forgetProfileToken(first)
            forgetProfileToken(next)
            await bridge.close()
        }
    })
})

serial('a model change recompile is picked up without restarting the bridge', async () => {
    await withHarness('tokmodel', async ({ workspace, port }) => {
        const previousPort = process.env.CUTTLELY_HARNESS_GATEWAY_PORT
        process.env.CUTTLELY_HARNESS_GATEWAY_PORT = String(port)
        const firstRecord = harnessRecord('tokmodel', 'grok-a')
        saveHarness(firstRecord, { overwrite: true })
        let bridge
        const tokens = []
        try {
            compileProfile(firstRecord)
            const profileDir = path.join(hermesHome, 'profiles', 'tokmodel--worker')
            const compiled = bridgeEnvFromConfig(path.join(profileDir, 'config.yaml'))
            assert.equal(compiled.CUTTLELY_HARNESS_PROFILE_ENV, path.join(profileDir, '.env'))
            assert.equal(path.isAbsolute(compiled.CUTTLELY_HARNESS_PROFILE_ENV), true)
            assert.match(compiled.CUTTLELY_HARNESS_GATEWAY_TOKEN, TOKEN_RE)
            tokens.push(compiled.CUTTLELY_HARNESS_GATEWAY_TOKEN)
            bridge = openBridge('tokmodel', 'worker', compiled, workspace)
            const before = await bridge.rpc('tools/call', { name: 'echoNode', arguments: { input: 'ping' } })
            assertToolOk(before, tokens)
            const changed = harnessRecord('tokmodel', 'grok-b')
            saveHarness(changed, { overwrite: true })
            compileProfile(changed)
            const rotated = readEnvKey(compiled.CUTTLELY_HARNESS_PROFILE_ENV)
            if (!TOKEN_RE.test(rotated) || rotated === tokens[0]) throw new Error('recompile did not mint a new gateway token')
            tokens.push(rotated)
            const after = await bridge.rpc('tools/call', { name: 'echoNode', arguments: { input: 'ping' } })
            assertToolOk(after, tokens)
            assertNoToken(bridge.stderr(), tokens)
        } finally {
            if (previousPort == null) delete process.env.CUTTLELY_HARNESS_GATEWAY_PORT
            else process.env.CUTTLELY_HARNESS_GATEWAY_PORT = previousPort
            for (const token of tokens) forgetProfileToken(token)
            if (bridge) await bridge.close()
        }
    })
})

serial('a revoked token with no replacement still fails unauthorized', async () => {
    const token = mint()
    const envFile = path.join(dataDir, 'bridge-env', 'tokrevoke.env')
    await withHarness('tokrevoke', async ({ url, workspace }) => {
        saveHarness(harnessRecord('tokrevoke'), { overwrite: true })
        writeEnvKey(envFile, token)
        registerProfileToken({
            token,
            harnessName: 'tokrevoke',
            specialistName: 'worker',
            modelKey: 'k',
            profileName: 'tokrevoke--worker'
        })
        const bridge = openBridge(
            'tokrevoke',
            'worker',
            {
                CUTTLELY_HARNESS_GATEWAY_URL: url,
                CUTTLELY_HARNESS_GATEWAY_TOKEN: token,
                CUTTLELY_HARNESS_PROFILE_ENV: envFile
            },
            workspace
        )
        try {
            const before = await bridge.rpc('tools/call', { name: 'echoNode', arguments: { input: 'ping' } })
            assertToolOk(before, [token])
            forgetProfileToken(token)
            const revoked = await bridge.rpc('tools/call', { name: 'echoNode', arguments: { input: 'ping' } })
            assert.equal(revoked.result?.isError, true)
            assert.equal(revoked.result?.content?.[0]?.text, 'Unauthorized')
            assertNoToken(bridge.stderr(), [token])
        } finally {
            forgetProfileToken(token)
            await bridge.close()
        }
    })
})

serial('a token retired while the tool executes is not retried', async () => {
    const first = mint()
    const next = mint()
    const envFile = path.join(dataDir, 'bridge-env', 'tokduring.env')
    let runs = 0
    await withHarness('tokduring', async ({ url, workspace }) => {
        saveHarness(harnessRecord('tokduring'), { overwrite: true })
        writeEnvKey(envFile, first)
        registerProfileToken({
            token: first,
            harnessName: 'tokduring',
            specialistName: 'worker',
            modelKey: 'k',
            profileName: 'tokduring--worker'
        })
        // Retiring the live token inside run, and leaving a new one on disk, is the rotation a plain 401 would follow.
        // The tool has already started, so a retry would execute it a second time.
        setGatewayContext(async () => ({
            flowOptions: { appDataSource: { ready: true } },
            loadNode: async (nodeName) => {
                if (nodeName !== 'echoNode') throw new Error('unexpected node')
                return class {
                    async run() {
                        runs += 1
                        writeEnvKey(envFile, next)
                        registerProfileToken({
                            token: next,
                            harnessName: 'tokduring',
                            specialistName: 'worker',
                            modelKey: 'k',
                            profileName: 'tokduring--worker'
                        })
                        return 'tool-ok'
                    }
                }
            }
        }))
        const bridge = openBridge(
            'tokduring',
            'worker',
            {
                CUTTLELY_HARNESS_GATEWAY_URL: url,
                CUTTLELY_HARNESS_GATEWAY_TOKEN: first,
                CUTTLELY_HARNESS_PROFILE_ENV: envFile
            },
            workspace
        )
        try {
            const retired = await bridge.rpc('tools/call', { name: 'echoNode', arguments: { input: 'ping' } })
            assert.equal(runs, 1)
            assert.equal(retired.result?.isError, true)
            assert.equal(retired.result?.content?.[0]?.text, 'Unauthorized')
            assertNoToken(bridge.stderr(), [first, next])
        } finally {
            forgetProfileToken(first)
            forgetProfileToken(next)
            await bridge.close()
        }
    })
})
