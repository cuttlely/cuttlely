// Dev and Prod as two version folders sharing one local bare repository, standing in for GitHub.
// Dev publishes and copies; Prod reads, lists, and promotes. No test talks to GitHub or a database.
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

jest.mock('../../utils/logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))
jest.mock('../flow-drafts', () => ({ __esModule: true, default: { getState: jest.fn(async () => null) } }))

import logger from '../../utils/logger'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { flushVersions, getVersion, isVersioningEnabled, recordFlowVersion, resetForTests, setGithubForTests } from '../flow-versions'
import { GithubSync, GithubStatus, INCOMING_REF } from '../flow-versions/github'
import { CredentialRef } from '../flow-versions/serialize'
import { gitEnv, VersionStore } from '../flow-versions/store'
import { getIncoming, incomingCanvas, listIncoming, promotable, PromoteDeps } from './index'
import { gitWordsIn, messagesInSource } from '../../utils/plainWords'

// These tests run real git processes. On an idle box the slowest test takes about 4 s; while other builds run,
// some pass 5 s, Jest's default. 20 s leaves room for a busy box and still fails a hung git call quickly.
jest.setTimeout(20_000)

const TOKEN = ['test', 'token', 'NOT', 'REAL', '9a1c2e'].join('-')
const FLOW = '3c9e8b1a-1111-2222-3333-444455556666'
const OTHER = '3c9e8b1a-9999-8888-7777-666655554444'
const WS = 'ws-prod'
const DEV_KEY = 'dev-cred-1'
const PROD_KEY = 'prod-cred-7'
const OPENAI: CredentialRef = { name: 'OpenAI key', credentialName: 'openAIApi' }
const SEARCH: CredentialRef = { name: 'Search key', credentialName: 'serpApi' }

function canvas(codeWord: string, credential: string, extra?: { credential: string }) {
    const node = (id: string, cred: string, label: string) => ({
        id,
        type: 'customNode',
        position: { x: 0, y: 0 },
        data: {
            id,
            name: 'chatOpenAI',
            label,
            credential: cred,
            inputParams: [{ name: 'systemMessage', type: 'string' }],
            inputs: { systemMessage: `Always answer with the code word ${codeWord}.` }
        }
    })
    return JSON.stringify({
        nodes: [node('chatOpenAI_0', credential, 'Chat model'), ...(extra ? [node('chatOpenAI_1', extra.credential, 'Search model')] : [])],
        edges: []
    })
}

function cleanEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value
    return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0' }
}

function bareMain(bare: string): string | null {
    try {
        return execFileSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '-q', 'refs/heads/main'], {
            encoding: 'utf8',
            env: cleanEnv()
        }).trim()
    } catch {
        return null
    }
}

function rev(dir: string, ref: string): string | null {
    try {
        return execFileSync('git', ['rev-parse', '--verify', '-q', ref], { cwd: dir, encoding: 'utf8', env: gitEnv(dir) }).trim()
    } catch {
        return null
    }
}

function allFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) out.push(...allFiles(full))
        else out.push(full)
    }
    return out
}

let tmp: string
let bare: string
let devDir: string
let prodDir: string
let devSync: GithubSync
let prodSync: GithubSync
let gitCalls: string[][]
// Prod's flows table and Credentials, as the database would answer.
let prodFlows: Map<string, ChatFlow>
let prodCredentials: Map<string, { id: string; ref: CredentialRef }>
const credentialRows = new Map<string, { id: string; name: string; token: string; workspaceId: string }>()
const credentialStore = {
    async get(id: string, workspaceId: string) {
        const row = credentialRows.get(id)
        return row && row.workspaceId === workspaceId ? { id: row.id, name: row.name, token: row.token } : null
    },
    async create(input: { name: string; token: string; workspaceId: string }) {
        const id = `gh-${credentialRows.size + 1}`
        credentialRows.set(id, { id, ...input })
        return { id, name: input.name }
    }
}
const savedEnv = { ...process.env }

function makeSync(dir: string) {
    const store = new VersionStore(dir)
    return new GithubSync({
        store: () => store,
        enabled: isVersioningEnabled,
        credentials: credentialStore,
        log: (message) => (logger as any).warn(message),
        debounceMs: 0,
        retryMs: [60_000],
        checkEveryMs: 60_000,
        onGit: (args) => gitCalls.push(args)
    })
}

function asDev() {
    process.env.CUTTLELY_VERSIONS_DIR = devDir
    setGithubForTests(devSync)
}

function asProd() {
    process.env.CUTTLELY_VERSIONS_DIR = prodDir
    setGithubForTests(prodSync)
}

// Dev publishes: the version is recorded on Dev and copied to the shared repository.
async function devPublishes(id: string, name: string, flowData: string, category?: string) {
    asDev()
    await recordFlowVersion(
        { id, name, type: 'CHATFLOW', flowData, workspaceId: 'ws-dev', ...(category ? { category } : {}) },
        {
            kind: 'publish',
            titlePrefix: 'Published: ',
            lookupCredentials: async () =>
                new Map([
                    [DEV_KEY, OPENAI],
                    ['dev-cred-2', SEARCH]
                ])
        }
    )
    await flushVersions()
    await devSync.sync()
}

async function prodReads() {
    asProd()
    await prodSync.sync()
}

function namesFor(flowData: string): Map<string, CredentialRef> {
    const map = new Map<string, CredentialRef>()
    for (const [id, row] of prodCredentials) if (flowData.includes(id)) map.set(id, row.ref)
    return map
}

const deps: PromoteDeps = {
    findFlow: async (id) => prodFlows.get(id) || null,
    draftOf: async () => null,
    environment: () => prodSync.environment(),
    connected: () => prodSync.isConnected(),
    lastCheckedAt: async () => (await prodSync.status()).lastCheckedAt,
    readOptions: () => ({
        matchCredentials: async (ref) =>
            [...prodCredentials.values()]
                .filter((row) => row.ref.name === ref.name && row.ref.credentialName === ref.credentialName)
                .map((row) => row.id)
    }),
    recordOptions: { lookupCredentials: async (flowData) => namesFor(flowData) }
}

// What the promote controller does after its checks: Live gets the version, history records it as promoted.
async function prodPromotes(id: string, sha: string) {
    asProd()
    const row = prodFlows.get(id) || ({ id, name: 'x', type: 'CHATFLOW', flowData: '{"nodes":[],"edges":[]}', workspaceId: WS } as ChatFlow)
    const version = await getVersion(row, sha, deps.readOptions!(WS))
    expect(version).not.toBeNull()
    const saved = { ...row, name: version!.name, flowData: version!.flowData } as ChatFlow
    prodFlows.set(id, saved)
    await recordFlowVersion(saved, {
        kind: 'promote',
        title: `Promoted from Dev (${sha.slice(0, 7)})`,
        promotedFrom: sha,
        lookupCredentials: async (fd) => namesFor(fd)
    })
    await flushVersions()
    return saved
}

beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-promote-'))
    process.env.CUTTLELY_VERSIONS = 'on'
    process.env.CUTTLELY_GITHUB_ALLOW_FILE_REMOTES = 'on'
    resetForTests()
    devDir = path.join(tmp, 'dev', 'versions')
    prodDir = path.join(tmp, 'prod', 'versions')
    bare = path.join(tmp, 'shared.git')
    execFileSync('git', ['init', '-q', '--bare', bare], { env: cleanEnv() })
    gitCalls = []
    credentialRows.clear()
    prodFlows = new Map()
    prodCredentials = new Map([[PROD_KEY, { id: PROD_KEY, ref: OPENAI }]])
    devSync = makeSync(devDir)
    prodSync = makeSync(prodDir)
    asDev()
    await devSync.setEnvironment('dev')
    await devSync.connect({ repo: `file://${bare}`, token: TOKEN }, 'ws-dev')
    asProd()
    await prodSync.setEnvironment('prod')
    ;(logger.warn as jest.Mock).mockClear()
})

afterEach(() => {
    devSync.stop()
    prodSync.stop()
    setGithubForTests(null)
    process.env = { ...savedEnv }
    fs.rmSync(tmp, { recursive: true, force: true })
})

describe('Prod reads the shared repository and never writes to it', () => {
    test('connecting Prod to an empty repository works: nothing from Dev yet', async () => {
        const empty = path.join(tmp, 'empty.git')
        execFileSync('git', ['init', '-q', '--bare', empty], { env: cleanEnv() })
        const status = await prodSync.connect({ repo: `file://${empty}`, token: TOKEN }, WS)
        expect(status).toMatchObject({ connected: true, role: 'read', state: 'up-to-date', incomingVersion: null, waiting: null })
        expect(status.message).toBe('Nothing from Dev yet. Cuttlely looks again every few minutes.')
        expect((await listIncoming(WS, deps)).flows).toEqual([])
    })

    test("Prod connects to the repository Dev copies to, and reads Dev's versions without changing anything of its own", async () => {
        await devPublishes(FLOW, 'Support bot', canvas('ALPHA', DEV_KEY))
        const devHead = rev(devDir, 'refs/heads/main')
        expect(bareMain(bare)).toBe(devHead)

        asProd()
        const before = rev(prodDir, 'refs/heads/main')
        const status = await prodSync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(status).toMatchObject({ role: 'read', state: 'up-to-date', incomingVersion: devHead!.slice(0, 7) })
        expect(status.lastCheckedAt).toEqual(expect.any(String))
        expect(rev(prodDir, INCOMING_REF)).toBe(devHead)
        // Local history, its files and the repository are untouched; nothing was sent anywhere.
        expect(rev(prodDir, 'refs/heads/main')).toBe(before)
        const flowsDir = path.join(prodDir, 'flows')
        expect(fs.existsSync(flowsDir) ? fs.readdirSync(flowsDir) : []).toEqual([])
        expect(bareMain(bare)).toBe(devHead)
        expect(gitCalls.some((args) => args.includes('push') && args.join(' ').includes(prodDir))).toBe(false)
    })

    test("when Dev's versions are gone from the repository, Prod offers nothing any more", async () => {
        await devPublishes(FLOW, 'Support bot', canvas('ALPHA', DEV_KEY))
        asProd()
        await prodSync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect((await listIncoming(WS, deps)).flows).toHaveLength(1)
        execFileSync('git', ['--git-dir', bare, 'update-ref', '-d', 'refs/heads/main'], { env: cleanEnv() })
        await prodReads()
        expect(rev(prodDir, INCOMING_REF)).toBeNull()
        expect((await listIncoming(WS, deps)).flows).toEqual([])
        expect((await prodSync.status()).state).toBe('up-to-date')
    })

    test('a read still running when the owner disconnects leaves nothing behind to promote', async () => {
        await devPublishes(FLOW, 'Support bot', canvas('ALPHA', DEV_KEY))
        asProd()
        let armed = false
        let disconnecting: Promise<GithubStatus> | null = null
        const store = new VersionStore(prodDir)
        const racing: GithubSync = new GithubSync({
            store: () => store,
            enabled: isVersioningEnabled,
            credentials: credentialStore,
            log: () => undefined,
            debounceMs: 0,
            retryMs: [60_000],
            checkEveryMs: 60_000,
            onGit: (args) => {
                if (armed && args.includes('fetch')) {
                    armed = false
                    disconnecting = racing.disconnect()
                }
            }
        })
        setGithubForTests(racing)
        await racing.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        execFileSync('git', ['-C', prodDir, 'update-ref', '-d', INCOMING_REF], { env: cleanEnv() })
        armed = true
        await racing.sync()
        await disconnecting
        racing.stop()
        expect(disconnecting).not.toBeNull()
        expect(rev(prodDir, INCOMING_REF)).toBeNull()
        expect(rev(prodDir, 'refs/versions/incoming-next')).toBeNull()
        const racingDeps = { ...deps, connected: () => racing.isConnected(), environment: () => racing.environment() }
        expect((await listIncoming(WS, racingDeps)).flows).toEqual([])
        await expect(promotable(FLOW, 'a'.repeat(40), WS, racingDeps)).rejects.toMatchObject({ statusCode: 409 })
    })

    test('Prod never copies its own versions: saves on Prod leave the shared repository as Dev left it', async () => {
        await devPublishes(FLOW, 'Support bot', canvas('ALPHA', DEV_KEY))
        await prodReads()
        await prodSync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const shared = bareMain(bare)
        const calls = gitCalls.length
        await prodPromotes(FLOW, rev(prodDir, INCOMING_REF)!)
        await recordFlowVersion(
            { id: OTHER, name: 'Prod only', type: 'CHATFLOW', flowData: canvas('LOCAL', PROD_KEY), workspaceId: WS },
            {
                lookupCredentials: async (fd) => namesFor(fd)
            }
        )
        await flushVersions()
        await new Promise((resolve) => setTimeout(resolve, 30))
        await prodSync.idle()
        await prodSync.tryNow()
        expect(bareMain(bare)).toBe(shared)
        expect(gitCalls.slice(calls).every((args) => !args.includes('push'))).toBe(true)
        expect(gitCalls.slice(calls).some((args) => args.includes('fetch'))).toBe(true)
    })

    test('Prod refuses a repository that has other content and no versions from Dev', async () => {
        const work = path.join(tmp, 'work')
        fs.mkdirSync(work)
        const env = {
            ...cleanEnv(),
            GIT_AUTHOR_NAME: 'a',
            GIT_AUTHOR_EMAIL: 'a@example.invalid',
            GIT_COMMITTER_NAME: 'a',
            GIT_COMMITTER_EMAIL: 'a@example.invalid'
        }
        const other = path.join(tmp, 'other.git')
        execFileSync('git', ['init', '-q', '--bare', other], { env: cleanEnv() })
        execFileSync('git', ['init', '-q'], { cwd: work, env })
        fs.writeFileSync(path.join(work, 'README.md'), 'hi\n')
        execFileSync('git', ['add', '.'], { cwd: work, env })
        execFileSync('git', ['commit', '-q', '-m', 'x'], { cwd: work, env })
        execFileSync('git', ['push', '-q', `file://${other}`, 'HEAD:refs/heads/trunk'], { cwd: work, env })
        await expect(prodSync.connect({ repo: `file://${other}`, token: TOKEN }, WS)).rejects.toMatchObject({
            status: 409,
            message: expect.stringContaining('no versions from a Dev server')
        })
        expect(prodSync.isConnected()).toBe(false)
    })

    test('switching between Dev and Prod while connected is refused; clearing a Dev label is not', async () => {
        await prodSync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        await expect(prodSync.setEnvironment('dev')).rejects.toMatchObject({
            status: 409,
            message: expect.stringContaining('Disconnect GitHub')
        })
        await expect(prodSync.setEnvironment(null)).rejects.toMatchObject({ status: 409 })
        asDev()
        await expect(devSync.setEnvironment('prod')).rejects.toMatchObject({ status: 409 })
        await expect(devSync.setEnvironment(null)).resolves.toMatchObject({ environment: null, role: 'copy' })
        asProd()
        await prodSync.disconnect()
        expect(rev(prodDir, INCOMING_REF)).toBeNull()
        await expect(prodSync.setEnvironment('dev')).resolves.toMatchObject({ environment: 'dev', role: 'copy' })
    })

    test('the token is never on a git argument, in a file, or in a log', async () => {
        await devPublishes(FLOW, 'Support bot', canvas('ALPHA', DEV_KEY))
        await prodSync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        await prodSync.tryNow()
        for (const args of gitCalls) expect(args.join(' ')).not.toContain(TOKEN)
        for (const dir of [devDir, prodDir, bare])
            for (const file of allFiles(dir)) expect(fs.readFileSync(file).toString('latin1')).not.toContain(TOKEN)
        expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain(TOKEN)
    })

    test('a Prod save does not start a copy', async () => {
        await prodSync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const calls = gitCalls.length
        prodSync.notify()
        await new Promise((resolve) => setTimeout(resolve, 30))
        expect(gitCalls.length).toBe(calls)
    })
})

describe('new versions from Dev, per flow', () => {
    beforeEach(async () => {
        asProd()
        await prodSync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
    })

    test('a flow Prod does not have is offered as new, with the credentials it needs mapped by name', async () => {
        await devPublishes(FLOW, 'Support bot', canvas('ALPHA', DEV_KEY))
        await prodReads()
        const list = await listIncoming(WS, deps)
        expect(list).toMatchObject({ enabled: true, connected: true })
        expect(list.flows).toHaveLength(1)
        expect(list.flows[0]).toMatchObject({
            flowId: FLOW,
            name: 'Support bot',
            type: 'CHATFLOW',
            status: 'new',
            hasDraft: false,
            lastPromoted: null
        })
        expect(list.flows[0].version.sha).toBe(rev(prodDir, INCOMING_REF))
        expect(list.flows[0].changes.map((c) => c.title)).toEqual([list.flows[0].version.title])

        const detail = await getIncoming(FLOW, WS, deps)
        expect(detail.missingCredentials).toEqual([])
        expect(detail.diff.added.map((n) => n.id)).toEqual(['chatOpenAI_0'])
        expect(detail.checkUnavailable).toMatchObject({ code: 'new-flow' })
        // The pushed files carry the credential name only; Prod's canvas gets Prod's own credential id.
        const version = await getVersion(
            { id: FLOW, name: 'x', flowData: '{}', workspaceId: WS },
            detail.version.sha,
            deps.readOptions!(WS)
        )
        expect(version!.flowData).toContain(PROD_KEY)
        expect(version!.flowData).not.toContain(DEV_KEY)
    })

    test('a credential Prod does not have is listed, and the check waits for it', async () => {
        await devPublishes(FLOW, 'Support bot', canvas('ALPHA', DEV_KEY, { credential: 'dev-cred-2' }))
        await prodReads()
        const detail = await getIncoming(FLOW, WS, deps)
        expect(detail.missingCredentials).toEqual([SEARCH])
        prodFlows.set(FLOW, {
            id: FLOW,
            name: 'Support bot',
            type: 'CHATFLOW',
            flowData: canvas('OLD', PROD_KEY),
            workspaceId: WS
        } as ChatFlow)
        const again = await getIncoming(FLOW, WS, deps)
        expect(again.status).toBe('update')
        expect(again.checkUnavailable).toMatchObject({ code: 'credentials' })
        expect(await incomingCanvas(prodFlows.get(FLOW)!, WS, deps)).toMatchObject({ flowData: null })
        prodCredentials.set('prod-cred-9', { id: 'prod-cred-9', ref: SEARCH })
        expect((await getIncoming(FLOW, WS, deps)).missingCredentials).toEqual([])
        expect((await incomingCanvas(prodFlows.get(FLOW)!, WS, deps))!.flowData).toContain('prod-cred-9')
    })

    test('after Promote the flow is no longer offered, until Dev publishes again; then only the newer versions are listed', async () => {
        await devPublishes(FLOW, 'Support bot', canvas('ALPHA', DEV_KEY))
        await prodReads()
        const first = (await listIncoming(WS, deps)).flows[0]
        await prodPromotes(FLOW, first.version.sha)
        expect((await listIncoming(WS, deps)).flows).toEqual([])

        await devPublishes(FLOW, 'Support bot', canvas('BRAVO', DEV_KEY))
        await devPublishes(FLOW, 'Support bot', canvas('CHARLIE', DEV_KEY))
        await prodReads()
        const list = await listIncoming(WS, deps)
        expect(list.flows).toHaveLength(1)
        expect(list.flows[0]).toMatchObject({ status: 'update', lastPromoted: { sha: first.version.sha } })
        expect(list.flows[0].changes).toHaveLength(2)
        const detail = await getIncoming(FLOW, WS, deps)
        expect(detail.diff.changed.map((n) => n.id)).toEqual(['chatOpenAI_0'])
        expect(detail.checkUnavailable).toBeNull()
        const check = await incomingCanvas(prodFlows.get(FLOW)!, WS, deps)
        expect(check!.flowData).toContain('CHARLIE')
        expect(check!.flowData).toContain(PROD_KEY)
    })

    test('a version that already matches Live is not offered, and a flow in another workspace is left out', async () => {
        await devPublishes(FLOW, 'Support bot', canvas('ALPHA', DEV_KEY))
        await devPublishes(OTHER, 'Elsewhere', canvas('ZULU', DEV_KEY))
        await prodReads()
        prodFlows.set(FLOW, {
            id: FLOW,
            name: 'Support bot',
            type: 'CHATFLOW',
            flowData: canvas('ALPHA', PROD_KEY),
            workspaceId: WS
        } as ChatFlow)
        prodFlows.set(OTHER, {
            id: OTHER,
            name: 'Elsewhere',
            type: 'CHATFLOW',
            flowData: canvas('OLD', PROD_KEY),
            workspaceId: 'ws-other'
        } as ChatFlow)
        expect((await listIncoming(WS, deps)).flows).toEqual([])
        await expect(getIncoming(OTHER, WS, deps)).rejects.toMatchObject({ statusCode: 404 })
    })

    test('a release that only moves the flow to another category is offered, and the version carries the category', async () => {
        await devPublishes(FLOW, 'Support bot', canvas('ALPHA', DEV_KEY), 'Front desk')
        await prodReads()
        prodFlows.set(FLOW, {
            id: FLOW,
            name: 'Support bot',
            type: 'CHATFLOW',
            flowData: canvas('ALPHA', PROD_KEY),
            workspaceId: WS
        } as ChatFlow)
        const list = await listIncoming(WS, deps)
        expect(list.flows).toHaveLength(1)
        const version = await getVersion(prodFlows.get(FLOW)!, list.flows[0].version.sha, deps.readOptions!(WS))
        expect(version!.category).toBe('Front desk')
        prodFlows.set(FLOW, { ...prodFlows.get(FLOW)!, category: 'Front desk' } as ChatFlow)
        expect((await listIncoming(WS, deps)).flows).toEqual([])
    })

    test('a flow deleted on Dev is not offered', async () => {
        await devPublishes(FLOW, 'Support bot', canvas('ALPHA', DEV_KEY))
        asDev()
        const { recordFlowDeletion } = await import('../flow-versions')
        await recordFlowDeletion({ id: FLOW, name: 'Support bot' })
        await flushVersions()
        await devSync.sync()
        await prodReads()
        expect((await listIncoming(WS, deps)).flows).toEqual([])
    })

    test('a Prod draft is reported, never changed', async () => {
        await devPublishes(FLOW, 'Support bot', canvas('BRAVO', DEV_KEY))
        await prodReads()
        prodFlows.set(FLOW, {
            id: FLOW,
            name: 'Support bot',
            type: 'CHATFLOW',
            flowData: canvas('ALPHA', PROD_KEY),
            workspaceId: WS
        } as ChatFlow)
        const withDraft: PromoteDeps = { ...deps, draftOf: async () => canvas('DRAFT', PROD_KEY) }
        expect((await listIncoming(WS, withDraft)).flows[0]).toMatchObject({ hasDraft: true })
    })

    test('Promote needs the newest version: an older or unknown id is refused', async () => {
        await devPublishes(FLOW, 'Support bot', canvas('ALPHA', DEV_KEY))
        await prodReads()
        const older = rev(prodDir, INCOMING_REF)!
        await devPublishes(FLOW, 'Support bot', canvas('BRAVO', DEV_KEY))
        await prodReads()
        await expect(promotable(FLOW, older, WS, deps)).rejects.toMatchObject({
            statusCode: 409,
            message: expect.stringContaining('newer version')
        })
        await expect(promotable(FLOW, 'abc', WS, deps)).rejects.toMatchObject({ statusCode: 400 })
        const newest = rev(prodDir, INCOMING_REF)!
        await expect(promotable(FLOW, newest, WS, deps)).resolves.toMatchObject({ latest: { sha: newest } })
        await expect(promotable(FLOW, newest, WS, { ...deps, environment: () => 'dev' })).rejects.toMatchObject({ statusCode: 409 })
    })

    test('a Dev server lists nothing to promote', async () => {
        await devPublishes(FLOW, 'Support bot', canvas('ALPHA', DEV_KEY))
        await prodReads()
        expect(await listIncoming(WS, { ...deps, environment: () => 'dev' })).toMatchObject({ enabled: false, flows: [] })
    })
})

describe('three environments, in order', () => {
    const CHAIN = [
        { name: 'Dev', branch: 'main', server: 'dev' },
        { name: 'Staging', branch: 'staging', server: 'staging' },
        { name: 'Prod', branch: 'prod', server: 'prod' }
    ]
    let stagingDir: string
    let stagingSync: GithubSync
    let stagingFlows: Map<string, ChatFlow>
    let stagingCredentials: Map<string, { id: string; ref: CredentialRef }>

    function bareRef(ref: string): string | null {
        try {
            return execFileSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '-q', ref], {
                encoding: 'utf8',
                env: cleanEnv()
            }).trim()
        } catch {
            return null
        }
    }

    function asStaging() {
        process.env.CUTTLELY_VERSIONS_DIR = stagingDir
        setGithubForTests(stagingSync)
    }

    beforeEach(async () => {
        stagingDir = path.join(tmp, 'staging', 'versions')
        stagingSync = makeSync(stagingDir)
        stagingFlows = new Map()
        stagingCredentials = new Map()
        asDev()
        await devSync.setEnvironment('dev', CHAIN)
        asStaging()
        await stagingSync.setEnvironment('staging', CHAIN)
        asProd()
        await prodSync.setEnvironment('prod', CHAIN)
    })

    afterEach(() => {
        stagingSync.stop()
    })

    test('dev promotes to staging, then staging to prod, and a skipped hop is refused', async () => {
        const prodDeps: PromoteDeps = { ...deps, environments: () => prodSync.environments() }
        const stagingDeps: PromoteDeps = {
            findFlow: async (id) => stagingFlows.get(id) || null,
            draftOf: async () => null,
            environment: () => stagingSync.environment(),
            environments: () => stagingSync.environments(),
            connected: () => stagingSync.isConnected(),
            lastCheckedAt: async () => (await stagingSync.status()).lastCheckedAt,
            readOptions: () => ({
                matchCredentials: async (ref) =>
                    [...stagingCredentials.values()]
                        .filter((row) => row.ref.name === ref.name && row.ref.credentialName === ref.credentialName)
                        .map((row) => row.id)
            })
        }

        await devPublishes(FLOW, 'Support bot', canvas('ALPHA', DEV_KEY))
        const devSha = rev(devDir, 'refs/heads/main')!
        expect(bareMain(bare)).toBe(devSha)

        asProd()
        expect((await listIncoming(WS, prodDeps)).flows).toEqual([])
        await expect(promotable(FLOW, devSha, WS, prodDeps, 'dev')).rejects.toMatchObject({
            statusCode: 409,
            message: 'Promotion only moves to the next environment.'
        })

        asStaging()
        await stagingSync.connect({ repo: `file://${bare}`, token: TOKEN }, 'ws-staging')
        const offered = await listIncoming('ws-staging', stagingDeps)
        expect(offered.environments.map((item) => item.server)).toEqual(['dev', 'staging', 'prod'])
        expect(offered.source).toBe('dev')
        expect(offered.target).toBe('staging')
        expect(offered.flows).toHaveLength(1)
        expect(offered.flows[0].version.sha).toBe(devSha)
        const waiting = await getIncoming(FLOW, 'ws-staging', stagingDeps)
        expect(waiting.missingCredentials).toEqual([OPENAI])
        expect(waiting.checkUnavailable).toMatchObject({ code: 'new-flow' })
        expect(
            waiting.placements.map((item) => ({
                server: item.server,
                place: item.place,
                state: item.state,
                sha: item.version?.sha ?? null
            }))
        ).toEqual([
            { server: 'dev', place: 'previous', state: 'seen', sha: devSha },
            { server: 'staging', place: 'here', state: 'none', sha: null },
            { server: 'prod', place: 'later', state: 'local-only', sha: null }
        ])
        stagingCredentials.set('stg-key', { id: 'stg-key', ref: OPENAI })
        expect((await getIncoming(FLOW, 'ws-staging', stagingDeps)).missingCredentials).toEqual([])

        const blank = {
            id: FLOW,
            name: 'Support bot',
            type: 'CHATFLOW',
            flowData: '{"nodes":[],"edges":[]}',
            workspaceId: 'ws-staging'
        } as ChatFlow
        const staged = await getVersion(blank, devSha, stagingDeps.readOptions!('ws-staging'))
        expect(staged?.flowData).toContain('ALPHA')
        expect(staged?.flowData).toContain('stg-key')
        expect(staged?.flowData).not.toContain(DEV_KEY)
        const row = { ...blank, name: staged!.name, flowData: staged!.flowData } as ChatFlow
        stagingFlows.set(FLOW, row)
        await recordFlowVersion(row, {
            kind: 'promote',
            title: 'Promoted from Dev',
            promotedFrom: devSha,
            lookupCredentials: async () => new Map([['stg-key', OPENAI]])
        })
        await flushVersions()
        await stagingSync.sync()
        const stagingSha = rev(stagingDir, 'refs/heads/main')!
        expect(stagingSha).not.toBe(devSha)
        expect(bareRef('refs/heads/staging')).toBe(stagingSha)

        asProd()
        await prodSync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        await prodSync.sync()
        prodCredentials.clear()
        const arrived = await listIncoming(WS, prodDeps)
        expect(arrived.source).toBe('staging')
        expect(arrived.flows).toHaveLength(1)
        expect(arrived.flows[0].version.sha).toBe(stagingSha)
        expect(arrived.flows[0].version.sha).not.toBe(devSha)
        const onProd = await getIncoming(FLOW, WS, prodDeps)
        expect(onProd.missingCredentials).toEqual([OPENAI])
        expect(onProd.checkUnavailable).toMatchObject({ code: 'new-flow' })
        expect(
            onProd.placements.map((item) => ({ server: item.server, place: item.place, state: item.state, sha: item.version?.sha ?? null }))
        ).toEqual([
            { server: 'dev', place: 'earlier', state: 'seen', sha: devSha },
            { server: 'staging', place: 'previous', state: 'seen', sha: stagingSha },
            { server: 'prod', place: 'here', state: 'none', sha: null }
        ])
        expect(
            execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/versions'], {
                cwd: prodDir,
                encoding: 'utf8',
                env: gitEnv(prodDir)
            })
        ).not.toMatch(/refs\/versions\/peek-/)
        prodCredentials.set(PROD_KEY, { id: PROD_KEY, ref: OPENAI })
        expect((await getIncoming(FLOW, WS, prodDeps)).missingCredentials).toEqual([])
        const prodBlank = {
            id: FLOW,
            name: 'Support bot',
            type: 'CHATFLOW',
            flowData: '{"nodes":[],"edges":[]}',
            workspaceId: WS
        } as ChatFlow
        const lived = await getVersion(prodBlank, stagingSha, prodDeps.readOptions!(WS))
        expect(lived?.flowData).toContain('ALPHA')
        expect(lived?.flowData).toContain(PROD_KEY)
        expect(lived?.flowData).not.toContain('stg-key')
        expect(lived?.flowData).not.toContain(DEV_KEY)
        await expect(promotable(FLOW, stagingSha, WS, prodDeps, 'dev')).rejects.toMatchObject({
            statusCode: 409,
            message: 'Promotion only moves to the next environment.'
        })
        await expect(promotable(FLOW, devSha, WS, prodDeps)).rejects.toMatchObject({ statusCode: 409 })
        await expect(promotable(FLOW, stagingSha, WS, prodDeps, 'staging')).resolves.toMatchObject({ latest: { sha: stagingSha } })
        const prodRow = { ...prodBlank, name: lived!.name, flowData: lived!.flowData } as ChatFlow
        prodFlows.set(FLOW, prodRow)
        await recordFlowVersion(prodRow, {
            kind: 'promote',
            title: 'Promoted from Staging',
            promotedFrom: stagingSha,
            lookupCredentials: async (flowData) => namesFor(flowData)
        })
        await flushVersions()
        await prodSync.sync()
        expect(prodFlows.get(FLOW)?.flowData).toContain('ALPHA')
        expect(bareRef('refs/heads/prod')).toBeNull()
    })
})

describe('a saved Dev and Prod pair is unchanged', () => {
    test('the old file loads as dev then prod and promotion still uses it', async () => {
        const file = path.join(prodDir, '.git', 'versions-environment.json')
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ environment: 'prod' })
        expect(prodSync.environments()).toEqual([
            { name: 'dev', branch: 'main', server: 'dev' },
            { name: 'prod', branch: 'main', server: 'prod' }
        ])
        await devPublishes(FLOW, 'Support bot', canvas('ALPHA', DEV_KEY))
        asProd()
        await prodSync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const sha = rev(prodDir, INCOMING_REF)!
        expect(bareMain(bare)).toBe(rev(devDir, 'refs/heads/main'))
        await expect(promotable(FLOW, sha, WS, deps)).resolves.toMatchObject({ latest: { sha } })
        expect((await getIncoming(FLOW, WS, deps)).placements).toEqual([])
        expect(gitCalls.some((args) => args.join(' ').includes('refs/heads/staging'))).toBe(false)
    })
})

describe('plain words on screen', () => {
    // Every message Promote can show, wherever it is built (the scanner is in utils/plainWords).
    test('every message Promote can show uses no Git words', () => {
        const files = [path.join(__dirname, 'index.ts'), path.join(__dirname, '..', '..', 'controllers', 'flow-promote', 'index.ts')]
        let count = 0
        for (const file of files) {
            const source = fs.readFileSync(file, 'utf8')
            count += messagesInSource(source).length
            expect([path.basename(path.dirname(file)), gitWordsIn(source)]).toEqual([path.basename(path.dirname(file)), []])
        }
        expect(count).toBeGreaterThan(15)
    })
})
