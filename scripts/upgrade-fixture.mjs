#!/usr/bin/env node
/* eslint-disable no-console -- command-line tool; output is the interface */
// Makes the upgrade fixture that scripts/upgrade-check.mjs starts the current server on.
// Run it against a built checkout of an older Cuttlely (the baseline):
//
//   node scripts/upgrade-fixture.mjs --server-root <built checkout> [--out scripts/fixtures/upgrade]
//
// It starts that server on an empty data folder laid out like the Docker volume, creates demo
// data through the API (a credential, a chatflow saved twice, an agentflow, and a harness canvas,
// which also writes its harness record), stops the server, and writes baseline.tar.gz and baseline.json.
// Demo data only. The credential value is a placeholder, and the account exists only in the fixture.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setupCodeFromLogs } from './smoke-server.mjs'
import { dataEnv, freePort, login, nodeCount, request, startServer, versionList, waitForPing } from './upgrade-check.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ACCOUNT = { name: 'Upgrade Fixture', email: 'upgrade-fixture@example.com', password: 'UpgradeFixture1!' }

function git(cwd, args) {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
    if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
    return res.stdout.trim()
}

function chatflowData(credentialId, template) {
    const modelType = 'ChatOpenAI | BaseChatModel | BaseLanguageModel | Runnable'
    const promptType = 'PromptTemplate | BaseStringPromptTemplate | BasePromptTemplate'
    return {
        nodes: [
            {
                id: 'promptTemplate_0',
                type: 'customNode',
                position: { x: 0, y: 0 },
                data: {
                    id: 'promptTemplate_0',
                    label: 'Prompt Template',
                    name: 'promptTemplate',
                    type: 'PromptTemplate',
                    category: 'Prompts',
                    inputParams: [],
                    inputAnchors: [],
                    inputs: { template, promptValues: '{"question":"{{question}}"}' },
                    outputAnchors: [
                        {
                            id: `promptTemplate_0-output-promptTemplate-${promptType}`,
                            name: 'promptTemplate',
                            label: 'PromptTemplate',
                            type: promptType
                        }
                    ],
                    outputs: {}
                }
            },
            {
                id: 'chatOpenAI_0',
                type: 'customNode',
                position: { x: 0, y: 200 },
                data: {
                    id: 'chatOpenAI_0',
                    label: 'OpenAI',
                    name: 'chatOpenAI',
                    type: 'ChatOpenAI',
                    category: 'Chat Models',
                    credential: credentialId,
                    inputParams: [],
                    inputAnchors: [],
                    inputs: { modelName: 'gpt-4.1-mini', temperature: '0', streaming: false },
                    outputAnchors: [
                        { id: `chatOpenAI_0-output-chatOpenAI-${modelType}`, name: 'chatOpenAI', label: 'ChatOpenAI', type: modelType }
                    ],
                    outputs: {}
                }
            },
            {
                id: 'llmChain_0',
                type: 'customNode',
                position: { x: 400, y: 80 },
                data: {
                    id: 'llmChain_0',
                    label: 'LLM Chain',
                    name: 'llmChain',
                    type: 'LLMChain',
                    category: 'Chains',
                    inputParams: [],
                    inputAnchors: [
                        { id: 'llmChain_0-input-model-BaseLanguageModel', name: 'model', type: 'BaseLanguageModel' },
                        { id: 'llmChain_0-input-prompt-BasePromptTemplate', name: 'prompt', type: 'BasePromptTemplate' }
                    ],
                    inputs: { model: '{{chatOpenAI_0.data.instance}}', prompt: '{{promptTemplate_0.data.instance}}' },
                    outputAnchors: [
                        {
                            id: 'llmChain_0-output-llmChain-LLMChain|BaseChain|Runnable',
                            name: 'llmChain',
                            label: 'LLMChain',
                            type: 'LLMChain | BaseChain | Runnable'
                        }
                    ],
                    outputs: { output: 'llmChain' }
                }
            }
        ],
        edges: [
            {
                source: 'promptTemplate_0',
                sourceHandle: `promptTemplate_0-output-promptTemplate-${promptType}`,
                target: 'llmChain_0',
                targetHandle: 'llmChain_0-input-prompt-BasePromptTemplate',
                type: 'buttonedge',
                id: 'e-prompt'
            },
            {
                source: 'chatOpenAI_0',
                sourceHandle: `chatOpenAI_0-output-chatOpenAI-${modelType}`,
                target: 'llmChain_0',
                targetHandle: 'llmChain_0-input-model-BaseLanguageModel',
                type: 'buttonedge',
                id: 'e-model'
            }
        ]
    }
}

function agentflowData() {
    return {
        nodes: [
            {
                id: 'startAgentflow_0',
                type: 'agentFlow',
                position: { x: 0, y: 0 },
                data: {
                    id: 'startAgentflow_0',
                    label: 'Start',
                    name: 'startAgentflow',
                    type: 'Start',
                    category: 'Agent Flows',
                    inputs: { startInputType: 'chatInput' },
                    outputs: {}
                }
            },
            {
                id: 'directReplyAgentflow_0',
                type: 'agentFlow',
                position: { x: 300, y: 0 },
                data: {
                    id: 'directReplyAgentflow_0',
                    label: 'Reply',
                    name: 'directReplyAgentflow',
                    type: 'DirectReply',
                    category: 'Agent Flows',
                    inputs: { directReplyMessage: 'Thanks for your order. We will have it ready in 20 minutes.' },
                    outputs: {}
                }
            }
        ],
        edges: [
            {
                id: 'e-start-reply',
                source: 'startAgentflow_0',
                target: 'directReplyAgentflow_0',
                sourceHandle: 'startAgentflow_0-output-startAgentflow',
                targetHandle: 'directReplyAgentflow_0',
                type: 'agentFlow'
            }
        ]
    }
}

function harnessData(credentialId) {
    const node = (id, x, y, data) => ({
        id,
        type: 'customNode',
        position: { x, y },
        data: { id, category: 'Harness', inputParams: [], inputAnchors: [], outputAnchors: [], outputs: {}, ...data }
    })
    return {
        nodes: [
            node('harnessChief_0', 300, 0, {
                name: 'harnessChief',
                label: 'Harness Prime',
                type: 'HarnessChief',
                inputs: { instructions: 'Send bread questions to baker and order questions to orders.' }
            }),
            node('harnessSpecialist_0', 600, -120, {
                name: 'harnessSpecialist',
                label: 'Specialist',
                type: 'HarnessSpecialist',
                inputs: {
                    specialistName: 'baker',
                    description: 'Answers questions about bread and pastries.',
                    instructions: 'Answer questions about the menu.'
                }
            }),
            node('harnessSpecialist_1', 600, 120, {
                name: 'harnessSpecialist',
                label: 'Specialist',
                type: 'HarnessSpecialist',
                inputs: {
                    specialistName: 'orders',
                    description: 'Takes and checks orders.',
                    instructions: 'Check opening hours before you promise a pickup time.'
                }
            }),
            {
                id: 'chatOpenAI_0',
                type: 'customNode',
                position: { x: 0, y: 0 },
                data: {
                    id: 'chatOpenAI_0',
                    name: 'chatOpenAI',
                    label: 'ChatOpenAI',
                    type: 'ChatOpenAI',
                    category: 'Chat Models',
                    credential: credentialId,
                    inputs: { modelName: 'gpt-4.1-mini' },
                    outputs: {}
                }
            }
        ],
        edges: [{ id: 'e-model-chief', source: 'chatOpenAI_0', target: 'harnessChief_0', type: 'buttonedge' }]
    }
}

function must(res, what) {
    if (res.status !== 200 && res.status !== 201) throw new Error(`${what}: ${res.status} ${res.text.slice(0, 300)}`)
    return res.json
}

async function makeData(base, logs) {
    const setupCode = setupCodeFromLogs(logs)
    if (!setupCode) throw new Error('the server log had no setup code')
    must(
        await request(`${base}/api/v1/account/register`, {
            method: 'POST',
            body: { user: { name: ACCOUNT.name, email: ACCOUNT.email, credential: ACCOUNT.password }, setupCode }
        }),
        'register'
    )
    const cookie = await login(base, ACCOUNT)
    const credential = must(
        await request(`${base}/api/v1/credentials`, {
            method: 'POST',
            cookie,
            body: { name: 'Bakery OpenAI', credentialName: 'openAIApi', plainDataObj: { openAIApiKey: 'upgrade-fixture-placeholder' } }
        }),
        'credential'
    )
    const chat = must(
        await request(`${base}/api/v1/chatflows`, {
            method: 'POST',
            cookie,
            body: {
                name: 'Bakery helper',
                type: 'CHATFLOW',
                deployed: false,
                isPublic: false,
                flowData: JSON.stringify(chatflowData(credential.id, '{question}'))
            }
        }),
        'chatflow'
    )
    must(
        await request(`${base}/api/v1/chatflows/${chat.id}`, {
            method: 'PUT',
            cookie,
            body: { flowData: JSON.stringify(chatflowData(credential.id, 'You answer questions for a small bakery. {question}')) }
        }),
        'chatflow second save'
    )
    const agent = must(
        await request(`${base}/api/v1/chatflows`, {
            method: 'POST',
            cookie,
            body: { name: 'Bakery orders', type: 'AGENTFLOW', deployed: false, isPublic: false, flowData: JSON.stringify(agentflowData()) }
        }),
        'agentflow'
    )
    const harnessCanvas = must(
        await request(`${base}/api/v1/chatflows`, {
            method: 'POST',
            cookie,
            body: {
                name: 'bakery-team',
                type: 'HARNESS',
                deployed: false,
                isPublic: false,
                flowData: JSON.stringify(harnessData(credential.id))
            }
        }),
        'harness canvas'
    )

    const flows = []
    for (const [row, extra] of [
        [chat, { predict: true }],
        [agent, {}],
        [harnessCanvas, {}]
    ]) {
        const got = must(await request(`${base}/api/v1/chatflows/${row.id}`, { cookie }), `read ${row.name}`)
        const versions = versionList(await request(`${base}/api/v1/flow-versions/${row.id}`, { cookie })).map((v) => v.sha)
        flows.push({ id: row.id, name: got.name, type: got.type, nodes: nodeCount(got.flowData), versions, ...extra })
    }
    const harness = must(await request(`${base}/api/v1/harnesses/bakery-team`, { cookie }), 'read harness')
    return {
        flows,
        credentials: [{ id: credential.id, name: 'Bakery OpenAI', credentialName: 'openAIApi' }],
        harnesses: [{ name: harness.name, chatflowId: harness.chatflowId, specialists: harness.specialists.map((s) => s.name) }]
    }
}

async function main() {
    const args = process.argv.slice(2)
    const value = (flag) => {
        const at = args.indexOf(flag)
        return at >= 0 ? args[at + 1] : null
    }
    const serverRoot = path.resolve(value('--server-root') || ROOT)
    const out = path.resolve(value('--out') || path.join(ROOT, 'scripts', 'fixtures', 'upgrade'))
    if (!fs.existsSync(path.join(serverRoot, 'packages', 'server', 'dist', 'commands')))
        throw new Error(`${serverRoot} is not built (packages/server/dist is missing).`)
    const commit = git(serverRoot, ['rev-parse', 'HEAD'])
    const subject = git(serverRoot, ['log', '-1', '--format=%s'])
    const date = git(serverRoot, ['log', '-1', '--format=%cs'])

    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-upgrade-fixture-'))
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const preload = [path.join(ROOT, 'scripts', 'refuse-sso-load.cjs')]
    const server = startServer(serverRoot, dataEnv(dataRoot, port), { preload })
    let expected
    try {
        await waitForPing(base, server)
        expected = await makeData(base, server.logs)
    } finally {
        await server.stop()
    }
    for (const transient of ['logs', 'hermes', 'etl', 'storage'])
        fs.rmSync(path.join(dataRoot, transient), { recursive: true, force: true })
    // Fold the write-ahead log into the database file, as a backup of a stopped server would be.
    const dbFile = path.join(dataRoot, 'data', 'database.sqlite')
    const db = new DatabaseSync(dbFile)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()
    for (const side of ['-wal', '-shm']) fs.rmSync(`${dbFile}${side}`, { force: true })
    const hooks = path.join(dataRoot, 'versions', '.git', 'hooks')
    if (fs.existsSync(hooks))
        for (const sample of fs.readdirSync(hooks).filter((f) => f.endsWith('.sample'))) fs.rmSync(path.join(hooks, sample))
    fs.mkdirSync(out, { recursive: true })
    const archive = path.join(out, 'baseline.tar.gz')
    const tar = spawnSync(
        'tar',
        ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '--mtime=2026-01-01', '-czf', archive, '-C', dataRoot, '.'],
        { encoding: 'utf8' }
    )
    if (tar.status !== 0) throw new Error(`tar: ${tar.stderr}`)
    const meta = {
        about: 'Data written by an older Cuttlely, for scripts/upgrade-check.mjs. Demo data only; the credential value is a placeholder.',
        baseline: { commit, subject, date },
        layout: 'Docker volume layout: data/ (database.sqlite, encryption.key), versions/, harnesses/',
        account: { email: ACCOUNT.email, password: ACCOUNT.password },
        expected
    }
    fs.writeFileSync(path.join(out, 'baseline.json'), `${JSON.stringify(meta, null, 4)}\n`)
    fs.rmSync(dataRoot, { recursive: true, force: true })
    console.log(`fixture from ${commit.slice(0, 7)} (${date}) written to ${path.relative(ROOT, out) || out}`)
    for (const flow of expected.flows) console.log(`  ${flow.type} ${flow.name}: ${flow.nodes} cards, ${flow.versions.length} versions`)
    console.log(`  harness ${expected.harnesses[0].name}: ${expected.harnesses[0].specialists.join(', ')}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
    })
}
