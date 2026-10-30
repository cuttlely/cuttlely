import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-output-bridge-'))
process.env.CUTTLELY_DATA_DIR = dataDir
process.env.CUTTLELY_HERMES_HOME = path.join(dataDir, 'runtime')
process.env.CUTTLELY_PINNED_QUERIES = '1'
const { saveHarness, deleteHarness } = await import('./store.mjs')
const { setGatewayContext, startGateway, registerProfileToken, forgetProfileToken } = await import('./gateway.mjs')
const { beginAnalystCalls, endAnalystCalls, takeAnalystResults, resetAnalystCapture } = await import('./analyst-capture.mjs')
const { compilePinned } = await import('./runtime/pinned-query.mjs')
const { renderTrustedOutputs } = await import('./trusted-output.mjs')
const { specialistSessionId } = await import('./specialist-run.mjs')
after(() => fs.rmSync(dataDir, { recursive: true, force: true }))

const entry = {
    id: 'bridge-report',
    name: 'pq_bridge_report',
    version: 1,
    testedStamp: 'ab'.repeat(32),
    sql: 'SELECT :label AS report LIMIT 100',
    params: [{ name: 'label', type: 'text' }]
}
const statementHash = compilePinned(entry).statementHash
const contract = { pin: entry.name, hash: statementHash, mode: 'markdown', fields: [{ path: 'rows.0.report' }] }
const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
const reports = {
    a:
        'YTD period (UTC): [2026-01-01, 2026-10-30).\r\nScope: Example North; eligible count 8.\r\n\r\n' +
        'Exact source text — Ω.\n'.repeat(100) +
        '\nSee [source][record-a].  \n\n[record-a]: https://example.org/records/a "Source A"\n',
    b: 'Pipeline scope (UTC): [2026-10-30, 2027-01-01); eligible count 3.\n\nSee [source][record-b].\n\n[record-b]: https://example.org/records/b\n',
    wrong: 'Other turn source, never the requested turn.'
}

// Run the real runtime helper: it overwrites the model's reserved scope with the
// active specialist session ID before handing arguments to the MCP transport.
function runtimeArguments(sourceTurn, argumentsFromModel) {
    const script = [
        'import importlib.util,json,sys',
        'spec=importlib.util.spec_from_file_location("scope_helper",sys.argv[1])',
        'module=importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(module)',
        'print(json.dumps(module.analyst_call_arguments("fixture",json.loads(sys.argv[3]),sys.argv[2],{"env":{"CUTTLELY_ANALYST_BRIDGE":"1"}})))'
    ].join('\n')
    const out = spawnSync(
        process.env.HERMES_PYTHON || 'python3',
        ['-c', script, path.join(root, 'hermes/tools/mcp_tool_cuttlely.py'), sourceTurn, JSON.stringify(argumentsFromModel)],
        { encoding: 'utf8', timeout: 5000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }
    )
    assert.equal(out.status, 0, out.stderr)
    return JSON.parse(out.stdout)
}

// JSON-RPC's numeric id is only the stdio request ID. No model tool-call ID is
// supplied anywhere: this is the protocol the existing runtime actually emits.
async function askBridge(fixture, args) {
    const child = spawn(
        process.execPath,
        [path.join(root, 'packages/harness/mcp-bridge.mjs'), '--harness', fixture.name, '--specialist', fixture.specialist],
        {
            env: {
                PATH: process.env.PATH || '',
                CUTTLELY_DATA_DIR: dataDir,
                CUTTLELY_HERMES_HOME: path.join(dataDir, 'runtime'),
                CUTTLELY_ANALYST_BRIDGE: '1',
                CUTTLELY_HARNESS_GATEWAY_URL: `http://127.0.0.1:${fixture.gateway.port}/`,
                CUTTLELY_HARNESS_GATEWAY_TOKEN: fixture.token
            },
            stdio: ['pipe', 'pipe', 'pipe']
        }
    )
    let stdout = '',
        stderr = ''
    const closed = new Promise((resolve) => child.once('close', resolve))
    let timer
    try {
        const response = await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('The local test bridge did not reply.')), 10000)
            child.once('error', reject)
            child.once('close', (code) => reject(new Error(`The local test bridge exited before replying (${code}): ${stderr}`)))
            child.stderr.on('data', (chunk) => {
                stderr = (stderr + chunk).slice(-4000)
            })
            child.stdout.on('data', (chunk) => {
                stdout += chunk
                const newline = stdout.indexOf('\n')
                if (newline === -1) return
                try {
                    resolve(JSON.parse(stdout.slice(0, newline)))
                } catch (error) {
                    reject(error)
                }
            })
            child.stdin.end(
                JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: entry.name, arguments: args } }) + '\n'
            )
        })
        assert.equal(response.id, 0)
        assert.equal(response.error, undefined)
        return response.result
    } finally {
        clearTimeout(timer)
        child.kill()
        await closed
    }
}

let sequence = 0
async function withGateway(run) {
    const name = `trusted-bridge-${++sequence}`,
        specialist = 'data',
        profileName = `${name}--${specialist}`,
        chatId = 'shared-chat'
    const token = crypto.randomBytes(32).toString('base64url')
    const calls = []
    const prior = setGatewayContext(async () => ({
        flowOptions: { appDataSource: {} },
        loadNode: async (nodeName) => {
            assert.equal(nodeName, 'postgreSQLMCP')
            return class {
                async init() {
                    return [
                        {
                            name: entry.name,
                            description: 'Synthetic tested source report',
                            schema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
                            async invoke(args) {
                                assert.deepEqual(Object.keys(args), ['label'])
                                calls.push(args)
                                assert.ok(Object.hasOwn(reports, args.label))
                                return JSON.stringify({
                                    rows: [{ report: reports[args.label] }],
                                    summary: 'returned 1 of 1 rows',
                                    pinned: { id: entry.id, name: entry.name, version: entry.version, statementHash },
                                    _cuttlelyTraceSql: compilePinned(entry).runText
                                })
                            }
                        }
                    ]
                }
            }
        }
    }))
    let gateway
    try {
        saveHarness({
            name,
            chief: { model: { nodeName: 'unusedModel' } },
            specialists: [
                {
                    name: specialist,
                    trustedOutputs: [contract],
                    mcpServers: [
                        {
                            nodeName: 'postgreSQLMCP',
                            category: 'Tools (MCP)',
                            inputs: { pinnedQueries: JSON.stringify([entry]), analystRowCap: 100 }
                        }
                    ]
                }
            ]
        })
        registerProfileToken({ token, harnessName: name, specialistName: specialist, profileName, modelKey: 'synthetic-model-key' })
        gateway = await startGateway({ port: 0 })
        beginAnalystCalls(name, specialist, chatId)
        return await run({ name, specialist, profileName, chatId, token, gateway, calls })
    } finally {
        endAnalystCalls(name, specialist, chatId)
        resetAnalystCapture()
        forgetProfileToken(profileName)
        if (gateway) await gateway.close()
        setGatewayContext(prior)
        deleteHarness(name)
    }
}

test('real runtime scope helper and spawned bridge deliver a small receipt while retaining exact stamped source bytes', async () => {
    await withGateway(async (fixture) => {
        const sourceTurn = specialistSessionId(fixture.profileName, fixture.chatId, '00000000-0000-4000-8000-000000000001')
        const args = runtimeArguments(sourceTurn, { label: 'a', _cuttlelyScope: 'forged-model-scope' })
        assert.equal(args._cuttlelyScope, sourceTurn)
        const reply = await askBridge(fixture, args)
        assert.equal(reply.isError, false)
        const text = reply.content[0].text,
            receipt = JSON.parse(text)
        assert.equal(receipt.status, 'source_captured')
        assert.equal(receipt.pin, entry.name)
        assert.equal(receipt.hash, statementHash)
        assert.equal(receipt.outputMode, 'markdown')
        assert.ok(receipt.callId)
        assert.ok(text.length < 1000)
        assert.ok(!text.includes('Exact source text'))
        assert.ok(!text.includes('record-a'))
        const captures = takeAnalystResults({ harness: fixture.name, specialist: fixture.specialist, chatId: fixture.chatId, sourceTurn })
        assert.equal(captures.length, 1)
        assert.equal(captures[0].sourceTurn, sourceTurn)
        assert.equal(captures[0].callId, receipt.callId)
        assert.equal(captures[0].pinned.hash, statementHash)
        assert.equal(captures[0].result.rows[0].report, reports.a)
        assert.equal(sha(captures[0].result.rows[0].report), sha(reports.a))
        const rendered = await renderTrustedOutputs({ name: fixture.specialist, trustedOutputs: [contract] }, captures)
        assert.equal(rendered.text, reports.a)
        assert.equal(sha(rendered.text), sha(reports.a))
        assert.deepEqual(fixture.calls, [{ label: 'a' }])
    })
})

test('two real bridge turns in the same chat keep separate captures; a wrong filter cannot claim either source', async () => {
    await withGateway(async (fixture) => {
        const turnA = specialistSessionId(fixture.profileName, fixture.chatId, '00000000-0000-4000-8000-000000000002')
        const turnB = specialistSessionId(fixture.profileName, fixture.chatId, '00000000-0000-4000-8000-000000000003')
        const wrong = specialistSessionId(fixture.profileName, fixture.chatId, '00000000-0000-4000-8000-000000000099')
        for (const [label, sourceTurn] of [
            ['a', turnA],
            ['b', turnB]
        ]) {
            const reply = await askBridge(fixture, runtimeArguments(sourceTurn, { label }))
            assert.equal(JSON.parse(reply.content[0].text).status, 'source_captured')
        }
        const take = (sourceTurn) =>
            takeAnalystResults({ harness: fixture.name, specialist: fixture.specialist, chatId: fixture.chatId, sourceTurn })
        assert.deepEqual(take(wrong), [])
        const a = take(turnA)
        assert.equal(a.length, 1)
        assert.equal(a[0].result.rows[0].report, reports.a)
        assert.equal(a[0].sourceTurn, turnA)
        assert.deepEqual(take(turnA), [])
        const b = take(turnB)
        assert.equal(b.length, 1)
        assert.equal(b[0].result.rows[0].report, reports.b)
        assert.equal(b[0].sourceTurn, turnB)
        assert.notEqual(a[0].callId, b[0].callId)
        assert.deepEqual(fixture.calls, [{ label: 'a' }, { label: 'b' }])
    })
})

test('absent, foreign-profile and stale turn scopes never satisfy the expected protected source filter', async () => {
    await withGateway(async (fixture) => {
        const expected = specialistSessionId(fixture.profileName, fixture.chatId, '00000000-0000-4000-8000-000000000004')
        const foreign = specialistSessionId('unrelated-profile', fixture.chatId, '00000000-0000-4000-8000-000000000005')
        for (const args of [
            { label: 'a' },
            { label: 'a', _cuttlelyScope: foreign },
            { label: 'a', _cuttlelyScope: `${fixture.profileName}:${fixture.chatId}` }
        ]) {
            const reply = await askBridge(fixture, args)
            assert.equal(reply.isError, true)
            assert.match(reply.content[0].text, /turn-scoped source call/)
        }
        assert.deepEqual(fixture.calls, [])
        assert.deepEqual(
            takeAnalystResults({ harness: fixture.name, specialist: fixture.specialist, chatId: fixture.chatId, sourceTurn: expected }),
            []
        )
        const stale = specialistSessionId(fixture.profileName, fixture.chatId, '00000000-0000-4000-8000-000000000006')
        const reply = await askBridge(fixture, runtimeArguments(stale, { label: 'wrong' }))
        assert.equal(JSON.parse(reply.content[0].text).status, 'source_captured')
        assert.deepEqual(
            takeAnalystResults({ harness: fixture.name, specialist: fixture.specialist, chatId: fixture.chatId, sourceTurn: expected }),
            []
        )
        const captured = takeAnalystResults({
            harness: fixture.name,
            specialist: fixture.specialist,
            chatId: fixture.chatId,
            sourceTurn: stale
        })
        assert.equal(captured.length, 1)
        assert.equal(captured[0].result.rows[0].report, reports.wrong)
        assert.equal(fixture.calls.length, 1)
    })
})
