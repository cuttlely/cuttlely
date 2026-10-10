import fs from 'fs'
import os from 'os'
import path from 'path'

jest.mock('../../utils/logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))

import { diffVersion, getStore, getVersion, listVersions, recordFlowVersion, resetForTests } from './index'
import { diffFlowFiles, listAllVersions, listFlowVersions, previousFlowVersion } from './history'
import { serializeFlow } from './serialize'
import { SECRET_PLACEHOLDER } from './redact'

// These tests run real git processes. On an idle box the slowest test takes about 4 s; while other builds run,
// some pass 5 s, Jest's default. 20 s leaves room for a busy box and still fails a hung git call quickly.
jest.setTimeout(20_000)

const ID = '7d1f0c2a-aaaa-bbbb-cccc-ddddeeeeffff'
const OTHER = '11111111-2222-3333-4444-555555555555'
const lookupCredentials = async () => new Map([['cred-1', { name: 'OpenAI main', credentialName: 'openAIApi' }]])
const resolveCredential = async (ref: { name: string }) => (ref.name === 'OpenAI main' ? 'cred-local' : undefined)

function flow(instructions: string, opts: { extraNode?: boolean; x?: number; temperature?: number } = {}) {
    const nodes: any[] = [
        {
            id: 'harnessChief_0',
            type: 'customNode',
            position: { x: opts.x ?? 0, y: 0 },
            data: { id: 'harnessChief_0', name: 'harnessChief', label: 'Harness Prime', inputs: { instructions } }
        },
        {
            id: 'chatOpenAI_0',
            type: 'customNode',
            position: { x: 300, y: 0 },
            data: {
                id: 'chatOpenAI_0',
                name: 'chatOpenAI',
                label: 'ChatOpenAI',
                category: 'Chat Models',
                credential: 'cred-1',
                inputParams: [{ name: 'proxyApiKey', type: 'password' }],
                inputs: { modelName: 'gpt-4.1', temperature: opts.temperature ?? 0.2, proxyApiKey: 'kept-secret-value' }
            }
        }
    ]
    if (opts.extraNode) {
        nodes.push({
            id: 'calculator_0',
            type: 'customNode',
            position: { x: 0, y: 300 },
            data: { id: 'calculator_0', label: 'Calculator', inputs: {} }
        })
    }
    return { nodes, edges: [{ id: 'e1', source: 'chatOpenAI_0', target: 'harnessChief_0' }] }
}

const chatflow = (data: any, name = 'Sales Desk', id = ID) => ({
    id,
    name,
    type: 'HARNESS',
    flowData: JSON.stringify(data),
    workspaceId: 'ws-1'
})

let tmp: string
const savedEnv = { ...process.env }

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-history-'))
    process.env.CUTTLELY_VERSIONS = 'on'
    process.env.CUTTLELY_VERSIONS_DIR = path.join(tmp, 'versions')
    resetForTests()
})

afterEach(() => {
    process.env = { ...savedEnv }
    fs.rmSync(tmp, { recursive: true, force: true })
})

async function seed() {
    const v1 = await recordFlowVersion(chatflow(flow('First.\nline')), { lookupCredentials })
    const v2 = await recordFlowVersion(chatflow(flow('Second.\nline', { extraNode: true })), { lookupCredentials })
    const v3 = await recordFlowVersion(chatflow(flow('Second.\nline', { extraNode: true, x: 90, temperature: 0.7 }), 'Field Team'), {
        lookupCredentials
    })
    await recordFlowVersion(chatflow(flow('Other flow.\nline'), 'Other', OTHER), { lookupCredentials })
    return { v1: v1!, v2: v2!, v3: v3! }
}

describe('reading history', () => {
    test('lists only this flow, newest first, with names, kinds and details', async () => {
        const { v1, v2, v3 } = await seed()
        const list = await listVersions(ID)
        expect(list.enabled).toBe(true)
        expect(list.versions.map((entry) => entry.sha)).toEqual([v3, v2, v1])
        expect(list.versions[2]).toMatchObject({ kind: 'create', title: 'Created Sales Desk', name: 'Sales Desk', author: 'Cuttlely' })
        expect(list.versions[1].title).toBe('Changed instructions on Harness Prime; added Calculator')
        expect(list.versions[0].title).toContain('Renamed to Field Team')
        expect(list.versions[0].details.join(' ')).not.toContain('Version-')
        expect(list.lastError).toBeNull()
    })

    test('a promoted version is Published and keeps the full id of the version from Dev; other kinds never carry one', async () => {
        const { v3 } = await seed()
        const from = 'c'.repeat(40)
        const promoted = await recordFlowVersion(chatflow(flow('From Dev.\nline')), {
            lookupCredentials,
            kind: 'promote',
            title: 'Promoted from Dev: Changed instructions (ccccccc)',
            promotedFrom: from
        })
        const [entry, before] = (await listVersions(ID)).versions
        expect(entry).toMatchObject({ sha: promoted, kind: 'promote', published: true, promotedFrom: from })
        expect(entry.details.join(' ')).not.toContain('Version-')
        expect(before).toMatchObject({ sha: v3, promotedFrom: null })
        // Only a promote keeps it, and only a full id.
        await recordFlowVersion(chatflow(flow('Saved.\nline')), { lookupCredentials, promotedFrom: 'abc' })
        expect((await listVersions(ID)).versions[0].promotedFrom).toBeNull()
    })

    test('lists every flow newest first, or only the versions whose message has some text', async () => {
        await seed()
        const all = await listAllVersions(getStore(), 'main')
        expect(all.map((entry) => entry.flowId)).toEqual([OTHER, ID, ID, ID])
        const one = await listAllVersions(getStore(), 'main', 10, `Version-Flow: ${OTHER}`)
        expect(one.map((entry) => entry.name)).toEqual(['Other'])
    })

    test('each entry says who made it: a user by name and id, else Cuttlely', async () => {
        await recordFlowVersion(chatflow(flow('First.\nline')), { lookupCredentials, author: { id: 'user-1', name: 'Dana Lee' } })
        await recordFlowVersion(chatflow(flow('Second.\nline')), { lookupCredentials })
        const { versions } = await listVersions(ID)
        expect(versions.map(({ author, authorId, authorKind }) => ({ author, authorId, authorKind }))).toEqual([
            { author: 'Cuttlely', authorId: null, authorKind: 'system' },
            { author: 'Dana Lee', authorId: 'user-1', authorKind: 'user' }
        ])
        expect(JSON.stringify(versions)).not.toContain('@')
    })

    test('a name with the log separators in it does not break the list', async () => {
        await recordFlowVersion(chatflow(flow('First.\nline')), {
            lookupCredentials,
            author: { id: 'user-1', name: 'Dana\u001fLee\u001e' }
        })
        await recordFlowVersion(chatflow(flow('Second.\nline')), { lookupCredentials, author: { id: 'user-1', name: 'Dana Lee' } })
        const { versions } = await listVersions(ID)
        expect(versions).toHaveLength(2)
        expect(versions.map((entry) => entry.author)).toEqual(['Dana Lee', 'Dana Lee'])
        expect(versions[1].kind).toBe('create')
    })

    test('finds the previous version from Git, past the end of a shortened list', async () => {
        const { v1, v2, v3 } = await seed()
        const page = await listFlowVersions(getStore(), ID, 2)
        expect(page.map((entry) => entry.sha)).toEqual([v3, v2])
        expect((await previousFlowVersion(getStore(), ID, v2))?.sha).toBe(v1)
        expect((await previousFlowVersion(getStore(), ID, v3.slice(0, 7)))?.sha).toBe(v2)
        expect(await previousFlowVersion(getStore(), ID, v1)).toBeNull()
        expect(await previousFlowVersion(getStore(), ID, 'not-a-sha')).toBeNull()
    })

    test('is empty and off when versioning is off', async () => {
        process.env.CUTTLELY_VERSIONS = 'off'
        expect(await listVersions(ID)).toEqual({ enabled: false, versions: [], lastError: null })
    })

    test('reads an old version as a canvas, maps credentials by name, and keeps secrets from the current flow', async () => {
        const { v1 } = await seed()
        const current = chatflow(flow('Second.\nline', { extraNode: true, x: 90, temperature: 0.7 }), 'Field Team')
        const version = await getVersion(current, v1, { resolveCredential })
        expect(version).not.toBeNull()
        expect(version!.name).toBe('Sales Desk')
        const data = JSON.parse(version!.flowData)
        expect(data.nodes.map((node: any) => node.id)).toEqual(['harnessChief_0', 'chatOpenAI_0'])
        expect(data.nodes[0].data.inputs.instructions).toBe('First.\nline')
        expect(data.nodes[1].data.credential).toBe('cred-local')
        expect(data.nodes[1].data.inputs.proxyApiKey).toBe('kept-secret-value')
        expect(version!.missingCredentials).toEqual([])
    })

    test('lists credentials that do not exist here', async () => {
        const { v1 } = await seed()
        const version = await getVersion(chatflow(flow('x')), v1, { resolveCredential: async () => undefined })
        expect(version!.missingCredentials).toEqual([{ name: 'OpenAI main', credentialName: 'openAIApi' }])
    })

    test('with two credentials of the same name, the one the flow uses now wins, else the oldest, and it says so', async () => {
        const { v1 } = await seed()
        // The current flow uses cred-1. Ids come back oldest first.
        const inUse = await getVersion(chatflow(flow('x')), v1, { matchCredentials: async () => ['cred-old', 'cred-1'] })
        expect(JSON.parse(inUse!.flowData).nodes[1].data.credential).toBe('cred-1')
        expect(inUse!.ambiguousCredentials).toEqual([{ name: 'OpenAI main', credentialName: 'openAIApi', count: 2, using: 'current' }])
        expect(inUse!.missingCredentials).toEqual([])
        const neither = await getVersion(chatflow(flow('x')), v1, { matchCredentials: async () => ['cred-old', 'cred-new'] })
        expect(JSON.parse(neither!.flowData).nodes[1].data.credential).toBe('cred-old')
        expect(neither!.ambiguousCredentials).toEqual([{ name: 'OpenAI main', credentialName: 'openAIApi', count: 2, using: 'oldest' }])
        const one = await getVersion(chatflow(flow('x')), v1, { matchCredentials: async () => ['cred-only'] })
        expect(JSON.parse(one!.flowData).nodes[1].data.credential).toBe('cred-only')
        expect(one!.ambiguousCredentials).toEqual([])
        const none = await getVersion(chatflow(flow('x')), v1, { matchCredentials: async () => [] })
        expect(none!.missingCredentials).toEqual([{ name: 'OpenAI main', credentialName: 'openAIApi' }])
        expect(none!.ambiguousCredentials).toEqual([])
    })

    test('a version with a hidden secret keeps the placeholder on read, lists where it was, and matches the live flow', async () => {
        const secret = ['xai', 'Zy98Xw76Vu54Ts32Rq10'].join('-')
        const live = chatflow(flow(`Use ${secret} here.\nline`))
        const sha = await recordFlowVersion(live, { lookupCredentials })
        const version = await getVersion(live, sha!, { resolveCredential })
        expect(JSON.parse(version!.flowData).nodes[0].data.inputs.instructions).toBe(`Use ${SECRET_PLACEHOLDER} here.\nline`)
        expect(version!.hiddenSecrets).toEqual([expect.objectContaining({ node: 'harnessChief_0', input: 'instructions', count: 1 })])
        expect(version!.flowData).not.toContain(secret)
        // The live flow serializes the same way, so comparing with now shows no change for that text.
        const diff = await diffVersion(live, sha!, 'current', { lookupCredentials })
        expect(diff!.changed).toEqual([])
        const older = await getVersion(live, (await listVersions(ID)).versions[0].sha, { resolveCredential })
        expect(older!.hiddenSecrets.length).toBe(1)
    })

    test('a version with nothing hidden lists none', async () => {
        const { v1 } = await seed()
        expect((await getVersion(chatflow(flow('x')), v1, { resolveCredential }))!.hiddenSecrets).toEqual([])
        expect((await listVersions(ID)).versions.every((entry) => entry.hiddenSecrets === 0)).toBe(true)
    })

    test("a sha from another flow's history, or a bad sha, finds nothing", async () => {
        await seed()
        const other = (await listVersions(OTHER)).versions[0].sha
        const before = await listVersions(ID)
        expect(await getVersion(chatflow(flow('x')), before.versions[2].sha.slice(0, 12), { resolveCredential })).not.toBeNull()
        const otherFirst = await getVersion(chatflow(flow('x')), other, { resolveCredential })
        // The other flow's commit still contains this flow's folder, so it reads this flow as it was then.
        expect(otherFirst?.name).toBe('Field Team')
        expect(await getVersion(chatflow(flow('x')), 'nothex!', { resolveCredential })).toBeNull()
        expect(await getVersion(chatflow(flow('x')), '0000000', { resolveCredential })).toBeNull()
        expect(await getVersion(chatflow(flow('x'), 'Nope', '99999999-2222-3333-4444-555555555555'), other)).toBeNull()
    })

    test('diff against the previous version names added, changed and moved nodes', async () => {
        const { v1, v2, v3 } = await seed()
        const current = chatflow(flow('Second.\nline', { extraNode: true, x: 90, temperature: 0.7 }), 'Field Team')
        const first = await diffVersion(current, v1, 'previous', { lookupCredentials })
        expect(first!.against).toBeNull()
        expect(first!.added.map((node) => node.id)).toEqual(['harnessChief_0', 'chatOpenAI_0'])
        const second = await diffVersion(current, v2, 'previous', { lookupCredentials })
        expect(second).toMatchObject({
            against: v1,
            added: [{ id: 'calculator_0', label: 'Calculator' }],
            removed: [],
            changed: [{ id: 'harnessChief_0', label: 'Harness Prime', fields: ['instructions'] }],
            moved: [],
            renamed: null
        })
        const third = await diffVersion(current, v3, 'previous', { lookupCredentials })
        expect(third!.changed).toEqual([{ id: 'chatOpenAI_0', label: 'ChatOpenAI', fields: ['temperature'] }])
        expect(third!.moved).toEqual(['harnessChief_0'])
        expect(third!.renamed).toEqual({ from: 'Sales Desk', to: 'Field Team' })
    })

    test('diff against the current flow shows what restoring would bring back', async () => {
        const { v1 } = await seed()
        const current = chatflow(flow('Second.\nline', { extraNode: true, x: 90, temperature: 0.7 }), 'Field Team')
        const diff = await diffVersion(current, v1, 'current', { lookupCredentials })
        expect(diff!.against).toBe('current')
        expect(diff!.removed).toEqual([{ id: 'calculator_0', label: 'Calculator' }])
        expect(diff!.changed.map((change) => [change.id, change.fields])).toEqual([
            ['harnessChief_0', ['instructions']],
            ['chatOpenAI_0', ['temperature']]
        ])
    })

    test('diff against another sha, and refuses a bad one', async () => {
        const { v1, v3 } = await seed()
        const current = chatflow(flow('x'))
        const diff = await diffVersion(current, v3, v1, { lookupCredentials })
        expect(diff!.against).toBe(v1)
        expect(diff!.added).toEqual([{ id: 'calculator_0', label: 'Calculator' }])
        expect(await diffVersion(current, v3, 'nope', { lookupCredentials })).toBeNull()
    })
})

describe('diffFlowFiles', () => {
    test('a secret input never shows as a change, and edges are compared by their ends', () => {
        const meta = { id: ID, name: 'Sales Desk' }
        const a = serializeFlow(meta, flow('Same.\nline'))
        const changedSecret = flow('Same.\nline')
        changedSecret.nodes[1].data.inputs.proxyApiKey = 'another-value'
        changedSecret.edges = [{ id: 'renamed-edge-id', source: 'chatOpenAI_0', target: 'harnessChief_0' }]
        const diff = diffFlowFiles(a, serializeFlow(meta, changedSecret))
        expect(diff.changed).toEqual([])
        expect(diff.edgesChanged).toBe(false)
    })
})
