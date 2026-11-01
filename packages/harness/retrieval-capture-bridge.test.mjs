import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { beginRetrievedSources, takeRetrievedSources, endRetrievedSources, citedRetrievedGuidance } from './retrieval-capture.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieved-guidance-'))
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
const { saveHarness } = await import('./store.mjs')
const { compileProfile } = await import('./profile.mjs')
const { setGatewayContext, startGateway, registerProfileToken, forgetProfileToken } = await import('./gateway.mjs')
after(() => fs.rmSync(dir, { recursive: true, force: true }))

for (const browser of [false, true])
    test(`the actual gateway captures ${
        browser ? 'browser' : 'retriever'
    } evidence only for the token profile and active turn`, async () => {
        const name = 'retrieved-guidance-bridge' + (browser ? '-browser' : ''),
            specialist = 'docs',
            profileName = `${name}--${specialist}`
        const token = crypto.randomBytes(32).toString('base64url')
        const source = 'https://example.org/docs/auth'
        const document = { pageContent: 'Use the identity provider and mapped application policies.', metadata: { source } }
        const response = browser
            ? 'Fetched page summary.'
            : 'Retrieved documentation.\n\n----FLOWISE_SOURCE_DOCUMENTS----\n\n' + JSON.stringify([document])
        const binding = {
            nodeName: browser ? 'webBrowser' : 'retrieverTool',
            nodeId: 'docs-tool',
            inputs: { name: 'Retrieve_docs', returnSourceDocuments: true }
        }
        const record = saveHarness({
            name,
            chief: { model: { nodeName: 'unused' } },
            specialists: [{ name: specialist, modules: [binding], playbooks: [{ name: 'docs', content: 'Use documentation.' }] }]
        })
        compileProfile(record)
        const config = fs.readFileSync(path.join(dir, 'runtime', 'profiles', profileName, 'config.yaml'), 'utf8')
        assert.match(config, /CUTTLELY_ANALYST_BRIDGE/)
        let revoke = false
        const prior = setGatewayContext(async () => ({
            flowOptions: { appDataSource: {} },
            loadNode: async () =>
                class {
                    async init() {
                        return {
                            name: 'Retrieve_docs',
                            async invoke() {
                                if (revoke) forgetProfileToken(token)
                                return response
                            }
                        }
                    }
                }
        }))
        registerProfileToken({ token, harnessName: name, specialistName: specialist, profileName, modelKey: 'synthetic-model-key' })
        const gateway = await startGateway({ port: 0 })
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        const scope = { harness: name, specialist, sourceTurn: `${profileName}:chat#turn-one` }
        const other = { ...scope, sourceTurn: 'another-profile:chat#turn-one' }
        try {
            const list = await fetch(`http://127.0.0.1:${gateway.port}/harness/tools/list`, { method: 'POST', headers, body: '{}' })
            assert.equal(list.status, 200)
            const tools = (await list.json()).tools
            assert.equal(tools.length, 1)
            for (const current of [scope, other]) {
                beginRetrievedSources(current)
                const result = await fetch(`http://127.0.0.1:${gateway.port}/harness/tools/call`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        name: tools[0].name,
                        scope: current.sourceTurn,
                        arguments: { input: source, _cuttlelyCallId: 'actual-call' }
                    })
                })
                const payload = await result.json()
                assert.equal(result.status, 200, JSON.stringify(payload))
                assert.equal(payload.result, browser ? 'Fetched page summary.' : 'Retrieved documentation.')
                const sources = takeRetrievedSources(current)
                assert.equal(sources.length, current === scope ? 1 : 0)
                if (current === scope) assert.ok(citedRetrievedGuidance({ modules: [binding] }, `[Authentication](${source})`, sources))
            }
            // The real runtime injects the turn scope, and the real stdio bridge has
            // no model call ID. The gateway assigns an identity to this actual call.
            const root = fileURLToPath(new URL('../../', import.meta.url))
            const helper = spawnSync(
                process.env.HERMES_PYTHON || 'python3',
                [
                    '-c',
                    [
                        'import importlib.util,json,sys',
                        's=importlib.util.spec_from_file_location("scope_helper",sys.argv[1])',
                        'm=importlib.util.module_from_spec(s);s.loader.exec_module(m)',
                        'print(json.dumps(m.analyst_call_arguments("docs",{"input":sys.argv[3],"_cuttlelyScope":"forged"},sys.argv[2],{"env":{"CUTTLELY_ANALYST_BRIDGE":"1"}})))'
                    ].join('\n'),
                    path.join(root, 'hermes/tools/mcp_tool_cuttlely.py'),
                    scope.sourceTurn,
                    source
                ],
                { encoding: 'utf8', timeout: 5000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }
            )
            assert.equal(helper.status, 0, helper.stderr)
            const args = JSON.parse(helper.stdout)
            assert.equal(args._cuttlelyScope, scope.sourceTurn)
            assert.equal(args._cuttlelyCallId, undefined)
            beginRetrievedSources(scope)
            const child = spawn(
                process.execPath,
                [path.join(root, 'packages/harness/mcp-bridge.mjs'), '--harness', name, '--specialist', specialist],
                {
                    env: {
                        PATH: process.env.PATH,
                        CUTTLELY_DATA_DIR: dir,
                        CUTTLELY_HERMES_HOME: path.join(dir, 'runtime'),
                        CUTTLELY_ANALYST_BRIDGE: '1',
                        CUTTLELY_HARNESS_GATEWAY_URL: `http://127.0.0.1:${gateway.port}/`,
                        CUTTLELY_HARNESS_GATEWAY_TOKEN: token
                    },
                    stdio: ['pipe', 'pipe', 'pipe']
                }
            )
            let timer
            try {
                const reply = await new Promise((resolve, reject) => {
                    let output = ''
                    timer = setTimeout(() => reject(Error('The test bridge did not reply.')), 10000)
                    child.once('error', reject)
                    child.stdout.on('data', (chunk) => {
                        output += chunk
                        if (output.includes('\n')) {
                            try {
                                resolve(JSON.parse(output.split('\n')[0]))
                            } catch (error) {
                                reject(error)
                            }
                        }
                    })
                    child.stdin.end(
                        JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: tools[0].name, arguments: args } }) +
                            '\n'
                    )
                })
                assert.equal(reply.error, undefined)
                assert.equal(reply.result.content[0].text, browser ? 'Fetched page summary.' : 'Retrieved documentation.')
                assert.equal(takeRetrievedSources(scope).length, 1)
            } finally {
                clearTimeout(timer)
                child.kill()
            }
            revoke = true
            beginRetrievedSources(scope)
            const revoked = await fetch(`http://127.0.0.1:${gateway.port}/harness/tools/call`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ name: tools[0].name, scope: scope.sourceTurn, arguments: { input: source } })
            })
            assert.notEqual(revoked.status, 200)
            assert.deepEqual(takeRetrievedSources(scope), [])
        } finally {
            endRetrievedSources(scope)
            endRetrievedSources(other)
            forgetProfileToken(token)
            await gateway.close()
            setGatewayContext(prior)
        }
    })
