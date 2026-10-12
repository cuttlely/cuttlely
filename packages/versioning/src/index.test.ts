import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { emptyDeps, useTestDeps } from './testDeps'
import {
    configureVersioning,
    credentialIds,
    flushVersions,
    getStatus,
    isVersioningEnabled,
    listVersions,
    recordFlowDeletion,
    recordFlowVersion,
    resetForTests,
    versionsDir
} from './index'
import { hasChanges, hiddenInputsDiffer, lastErrorFor, liveVersionSha, pickCredential, restoreTitle, withPrefix } from './index'
import { gitEnv } from './store'
import { SECRET_PLACEHOLDER } from './redact'
import { scanForSecrets } from './secrets'
import { summarizeChange } from './summary'
import { diffFlowFiles } from './history'
import { actorFromUser, versionAuthor } from './author'
import { canonicalJson, serializeFlow } from './serialize'

// These tests run real git processes. On an idle box the slowest test takes about 4 s; while other builds run,
// some pass 5 s, Jest's default. 20 s leaves room for a busy box and still fails a hung git call quickly.
jest.setTimeout(20_000)

const ID = '7d1f0c2a-aaaa-bbbb-cccc-ddddeeeeffff'
const lookupCredentials = async () => new Map([['cred-1', { name: 'OpenAI main', credentialName: 'openAIApi' }]])

function flow(instructions = 'Route data questions to the analyst.\nKeep answers short.', extra: Record<string, any> = {}) {
    return {
        nodes: [
            {
                id: 'harnessChief_0',
                type: 'customNode',
                position: { x: 0, y: 0 },
                data: {
                    id: 'harnessChief_0',
                    name: 'harnessChief',
                    label: 'Harness Prime',
                    inputParams: [{ name: 'instructions', type: 'string' }],
                    inputs: { instructions }
                }
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
                    inputs: { modelName: 'gpt-4.1', FLOWISE_CREDENTIAL_ID: 'cred-1', ...extra }
                }
            }
        ],
        edges: [{ id: 'e1', source: 'chatOpenAI_0', target: 'harnessChief_0' }]
    }
}

function chatflow(name: string, data: any) {
    return { id: ID, name, type: 'HARNESS', flowData: JSON.stringify(data), workspaceId: 'ws-1' }
}

function git(dir: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv(dir) })
}

let tmp: string
const savedEnv = { ...process.env }

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-versions-'))
    process.env.CUTTLELY_VERSIONS = 'on'
    process.env.CUTTLELY_VERSIONS_DIR = path.join(tmp, 'versions')
    useTestDeps()
    resetForTests()
})

afterEach(() => {
    process.env = { ...savedEnv }
    fs.rmSync(tmp, { recursive: true, force: true })
})

describe('version history repo', () => {
    test('is on by default and with CUTTLELY_VERSIONS=on', () => {
        delete process.env.CUTTLELY_VERSIONS
        expect(isVersioningEnabled()).toBe(true)
        process.env.CUTTLELY_VERSIONS = ''
        expect(isVersioningEnabled()).toBe(true)
        process.env.CUTTLELY_VERSIONS = 'on'
        expect(isVersioningEnabled()).toBe(true)
    })

    test.each(['off', 'OFF', ' false ', '0', 'no'])('CUTTLELY_VERSIONS=%s turns it off, and then nothing is written', async (value) => {
        process.env.CUTTLELY_VERSIONS = value
        expect(isVersioningEnabled()).toBe(false)
        expect(await recordFlowVersion(chatflow('Sales Desk', flow()), { lookupCredentials })).toBeNull()
        expect(fs.existsSync(versionsDir())).toBe(false)
    })

    test('defaults to the data dir, then the home folder', () => {
        delete process.env.CUTTLELY_VERSIONS_DIR
        process.env.CUTTLELY_DATA_DIR = '/var/cuttlely'
        expect(versionsDir()).toBe(path.join('/var/cuttlely', 'versions'))
        delete process.env.CUTTLELY_DATA_DIR
        expect(versionsDir()).toBe(path.join(os.homedir(), '.cuttlely', 'versions'))
    })

    test('the first save creates the repo and commits the flow folder with plain-words names', async () => {
        const sha = await recordFlowVersion(chatflow('Sales Desk', flow()), { lookupCredentials })
        expect(sha).toMatch(/^[0-9a-f]{40}$/)
        const dir = versionsDir()
        expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true)
        const folder = path.join(dir, 'flows', 'sales-desk--7d1f0c2a')
        expect(fs.readFileSync(path.join(folder, 'prompts', 'harnessChief_0.instructions.md'), 'utf8')).toContain('Keep answers short.')
        const message = git(dir, 'log', '-1', '--format=%B')
        expect(message).toContain('Created Sales Desk')
        expect(message).toContain(`Version-Flow: ${ID}`)
        expect(message).toContain('Version-Kind: create')
        expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')
        expect(git(dir, 'status', '--porcelain').trim()).toBe('')
        expect(getStatus()).toMatchObject({ enabled: true, lastCommit: sha, lastError: null })
    })

    test('a prompt edit is one commit named for what changed, and an identical save adds nothing', async () => {
        await recordFlowVersion(chatflow('Sales Desk', flow()), { lookupCredentials })
        const sha = await recordFlowVersion(
            chatflow('Sales Desk', flow('Route data questions to the analyst.\nKeep answers very short.')),
            {
                lookupCredentials
            }
        )
        const dir = versionsDir()
        expect(git(dir, 'log', '-1', '--format=%s').trim()).toBe('Changed instructions on Harness Prime')
        expect(git(dir, 'show', '--name-only', '--format=', sha!).trim()).toBe(
            'flows/sales-desk--7d1f0c2a/prompts/harnessChief_0.instructions.md'
        )
        const again = await recordFlowVersion(
            chatflow('Sales Desk', flow('Route data questions to the analyst.\nKeep answers very short.')),
            {
                lookupCredentials
            }
        )
        expect(again).toBeNull()
        expect(git(dir, 'rev-list', '--count', 'HEAD').trim()).toBe('3')
    })

    test('moving nodes is named as a move, and a rename follows the folder', async () => {
        await recordFlowVersion(chatflow('Sales Desk', flow()), { lookupCredentials })
        const moved = flow()
        moved.nodes[0].position = { x: 50, y: 80 }
        await recordFlowVersion(chatflow('Sales Desk', moved), { lookupCredentials })
        const dir = versionsDir()
        expect(git(dir, 'log', '-1', '--format=%s').trim()).toBe('Moved nodes')
        await recordFlowVersion(chatflow('Field Team', moved), { lookupCredentials })
        expect(git(dir, 'log', '-1', '--format=%s').trim()).toBe('Renamed to Field Team')
        expect(fs.readdirSync(path.join(dir, 'flows'))).toEqual(['field-team--7d1f0c2a'])
    })

    test('the signed-in user is the author, with a user-id address and never their email', async () => {
        await recordFlowVersion(chatflow('Sales Desk', flow()), { lookupCredentials, author: { id: 'user-1', name: 'Dana Lee' } })
        await recordFlowVersion(chatflow('Sales Desk', flow('Second.\nline')), {
            lookupCredentials,
            // A display name that is an email is not written either.
            author: { id: 'user-2', name: 'pat@example.com' }
        })
        await recordFlowVersion(chatflow('Sales Desk', flow('Third.\nline')), { lookupCredentials })
        await recordFlowDeletion({ id: ID, name: 'Sales Desk' }, { id: 'user-1', name: 'Dana Lee' })
        const dir = versionsDir()
        expect(git(dir, 'log', '--format=%an <%ae>|%cn <%ce>').trim().split('\n')).toEqual([
            'Dana Lee <user-1@users.versions.local>|Cuttlely <system@versions.local>',
            'Cuttlely <system@versions.local>|Cuttlely <system@versions.local>',
            'User user-2 <user-2@users.versions.local>|Cuttlely <system@versions.local>',
            'Dana Lee <user-1@users.versions.local>|Cuttlely <system@versions.local>',
            'Cuttlely <system@versions.local>|Cuttlely <system@versions.local>'
        ])
        const everything = git(dir, 'log', '-p', '--format=%an %ae %cn %ce%n%B')
        expect(everything).not.toContain('example.com')
        expect(everything.match(/[^\s<>@]+@[^\s<>]+/g)?.every((address) => /@(users\.)?versions\.local$/.test(address))).toBe(true)
    })

    test('a GIT_DIR exported by a git hook never redirects commits to another repository', async () => {
        const decoy = path.join(tmp, 'decoy')
        fs.mkdirSync(decoy, { recursive: true })
        execFileSync('git', ['init', '-q'], { cwd: decoy, env: gitEnv(decoy) })
        const decoyConfig = fs.readFileSync(path.join(decoy, '.git', 'config'), 'utf8')
        process.env.GIT_DIR = path.join(decoy, '.git')
        process.env.GIT_INDEX_FILE = path.join(decoy, '.git', 'index')
        try {
            const sha = await recordFlowVersion(chatflow('Sales Desk', flow()), { lookupCredentials })
            expect(sha).toMatch(/^[0-9a-f]{40}$/)
        } finally {
            delete process.env.GIT_DIR
            delete process.env.GIT_INDEX_FILE
        }
        expect(fs.readFileSync(path.join(decoy, '.git', 'config'), 'utf8')).toBe(decoyConfig)
        expect(fs.existsSync(path.join(decoy, '.git', 'refs', 'heads', 'main'))).toBe(false)
        expect(fs.readdirSync(path.join(decoy, '.git', 'objects')).filter((entry) => /^[0-9a-f]{2}$/.test(entry))).toEqual([])
        expect(git(versionsDir(), 'log', '-1', '--format=%s').trim()).toBe('Created Sales Desk')
    })

    test('a restore label applies only to the save it is passed with', async () => {
        await recordFlowVersion(chatflow('Sales Desk', flow()), { lookupCredentials })
        const other = recordFlowVersion(chatflow('Sales Desk', flow('Someone else saved.\nShort.')), { lookupCredentials })
        const restored = recordFlowVersion(chatflow('Sales Desk', flow('Restored text.\nShort.')), {
            lookupCredentials,
            kind: 'restore',
            title: restoreTitle('abcdef1234', 'Changed instructions on Harness Prime')
        })
        await Promise.all([other, restored])
        await recordFlowVersion(chatflow('Sales Desk', flow('Later edit.\nShort.')), { lookupCredentials })
        const log = git(versionsDir(), 'log', '--format=%s|%(trailers:key=Version-Kind,valueonly,separator=)', '-4').trim().split('\n')
        expect(log[0]).toBe('Changed instructions on Harness Prime|save')
        expect(log[1]).toBe('Restored: Changed instructions on Harness Prime (abcdef1)|restore')
        expect(log[2]).toBe('Changed instructions on Harness Prime|save')
        expect(log[3]).toBe('Created Sales Desk|create')
        expect(typeof (await restored)).toBe('string')
    })

    test('Publish and Roll back are recorded as Published versions, and the newest version is Live', async () => {
        await recordFlowVersion(chatflow('Sales Desk', flow()), { lookupCredentials })
        const published = chatflow('Sales Desk', flow('Published text.\nShort.'))
        const publishSha = await recordFlowVersion(published, { lookupCredentials, kind: 'publish', titlePrefix: 'Published: ' })
        const rolledBack = chatflow('Sales Desk', flow())
        const rollbackSha = await recordFlowVersion(rolledBack, {
            lookupCredentials,
            kind: 'rollback',
            title: restoreTitle('abcdef1234', 'Created Sales Desk', 'Rolled back Live to')
        })
        const { versions } = await listVersions(ID)
        expect(versions.map((item) => [item.title, item.kind, item.published])).toEqual([
            ['Rolled back Live to: Created Sales Desk (abcdef1)', 'rollback', true],
            ['Published: Changed instructions on Harness Prime', 'publish', true],
            ['Created Sales Desk', 'create', false]
        ])
        expect(versions[1].sha).toBe(publishSha)
        expect(await liveVersionSha(rolledBack, versions, { lookupCredentials })).toBe(rollbackSha)
        // Live changed without a history record (for example, secret-shaped text): no version is marked Live.
        expect(await liveVersionSha(chatflow('Sales Desk', flow('Unrecorded.\nShort.')), versions, { lookupCredentials })).toBeNull()
        expect(await liveVersionSha(rolledBack, [], { lookupCredentials })).toBeNull()
        // Same nodes, edges and name, but another flow type (a type-only change history could not record): not Live.
        expect(await liveVersionSha({ ...rolledBack, type: 'AGENTFLOW' }, versions, { lookupCredentials })).toBeNull()
        // Or another category (a category-only change history did not record).
        expect(await liveVersionSha({ ...rolledBack, category: 'Support' }, versions, { lookupCredentials })).toBeNull()
    })

    test('a title prefix keeps the summary within 72 characters', () => {
        expect(withPrefix(undefined, 'Moved nodes')).toBe('Moved nodes')
        expect(withPrefix('Published: ', 'Moved nodes')).toBe('Published: Moved nodes')
        const long = withPrefix('Published: ', 'Changed instructions on Harness Prime; added Calculator, Web Search, and Analyst')
        expect(long.length).toBe(72)
        expect(long.endsWith('…')).toBe(true)
        expect(restoreTitle('0123456789abcdef', undefined, 'Rolled back Live to')).toBe('Rolled back Live to a version (0123456)')
    })

    test('a save that cannot be recorded resolves to null and keeps the reason for that flow', async () => {
        process.env.PATH = path.join(tmp, 'no-bin')
        expect(await recordFlowVersion(chatflow('Sales Desk', flow()), { lookupCredentials })).toBeNull()
        expect(lastErrorFor(ID)).toContain('git was not found on PATH')
        expect(lastErrorFor('another-flow')).toBeNull()
    })

    test('hasChanges is false only for an empty diff', () => {
        const empty = { added: [], removed: [], changed: [], moved: [], edgesChanged: false, renamed: null }
        expect(hasChanges(empty)).toBe(false)
        expect(hasChanges({ ...empty, moved: ['harnessChief_0'] })).toBe(true)
        expect(hasChanges({ ...empty, renamed: { from: 'A', to: 'B' } })).toBe(true)
        expect(hasChanges({ ...empty, edgesChanged: true })).toBe(true)
    })

    test('restore titles stay within 72 characters and keep the short id', () => {
        expect(restoreTitle('0123456789abcdef')).toBe('Restored a version (0123456)')
        const long = restoreTitle('0123456789abcdef', 'Changed instructions on Harness Prime; added Calculator, Web Search, and Analyst')
        expect(long.length).toBeLessThanOrEqual(72)
        expect(long.endsWith('… (0123456)')).toBe(true)
    })

    test('credential ids are collected from nested model and tool configs and JSON text', () => {
        const data = flow(undefined, {
            agentModelConfig: { FLOWISE_CREDENTIAL_ID: 'cred-2', modelName: 'gpt-4.1' },
            agentTools: [{ agentSelectedToolConfig: { credential: 'cred-3' } }],
            headers: JSON.stringify({ credential: 'cred-4' })
        })
        expect(credentialIds(JSON.stringify(data)).sort()).toEqual(['cred-1', 'cred-2', 'cred-3', 'cred-4'])
        expect(credentialIds('not json')).toEqual([])
    })

    test('a key pasted into a prompt is hidden from the version, and the live flow keeps it', async () => {
        const secret = ['sk', 'proj', 'abcdefghijklmnop1234'].join('-')
        const live = chatflow('Sales Desk', flow(`Use ${secret} for lookups.\nKeep answers short.`))
        const before = live.flowData
        const sha = await recordFlowVersion(live, { lookupCredentials })
        expect(sha).not.toBeNull()
        expect(live.flowData).toBe(before)
        const dir = versionsDir()
        expect(git(dir, 'log', '--all', '-p').includes(secret)).toBe(false)
        const prompt = fs.readFileSync(path.join(dir, 'flows', 'sales-desk--7d1f0c2a', 'prompts', 'harnessChief_0.instructions.md'), 'utf8')
        expect(prompt).toBe(`Use ${SECRET_PLACEHOLDER} for lookups.\nKeep answers short.`)
        const flowJson = JSON.parse(fs.readFileSync(path.join(dir, 'flows', 'sales-desk--7d1f0c2a', 'flow.json'), 'utf8'))
        expect(flowJson.hidden).toEqual([
            { node: 'harnessChief_0', label: expect.any(String), input: 'instructions', inputLabel: expect.any(String), count: 1 }
        ])
        const message = git(dir, 'log', '-1', '--format=%B')
        expect(message).toContain('1 secret-looking value was hidden from history')
        expect(message).toContain('Version-Hidden: 1')
        const [entry] = (await listVersions(ID)).versions
        expect(entry.hiddenSecrets).toBe(1)
        expect(entry.details).toContain('1 secret-looking value was hidden from history')
    })

    test('saving a restored version that still holds the placeholder keeps the hidden note', async () => {
        const restored = chatflow('Sales Desk', flow(`Use ${SECRET_PLACEHOLDER} for lookups.`))
        expect(
            await recordFlowVersion(restored, { lookupCredentials, kind: 'restore', title: 'Restored a version (abcdef1)' })
        ).not.toBeNull()
        const [entry] = (await listVersions(ID)).versions
        expect(entry.hiddenSecrets).toBe(1)
        expect(git(versionsDir(), 'log', '-1', '--format=%B')).toContain('Version-Hidden: 1')
    })

    test('secret-shaped text the serializer cannot hide is never committed, and the error names the file, not the text', async () => {
        const secret = ['sk', 'proj', 'abcdefghijklmnop1234'].join('-')
        // A flow name is not an input, so it is not rewritten; the scan stops the commit.
        const sha = await recordFlowVersion(chatflow(`Desk ${secret}`, flow('Keep answers short.')), { lookupCredentials })
        expect(sha).toBeNull()
        const status = getStatus()
        expect(status.lastError?.message).toContain('flow.json (sk)')
        expect(status.lastError?.message).not.toContain(secret)
        expect(git(versionsDir(), 'log', '--all', '-p').includes(secret)).toBe(false)
    })

    test('credentials are written by name and type only', async () => {
        await recordFlowVersion(chatflow('Sales Desk', flow()), { lookupCredentials })
        const dir = versionsDir()
        const all = git(dir, 'log', '-p')
        expect(all).not.toContain('cred-1')
        expect(all).toContain('OpenAI main')
    })

    test('deleting a flow removes its folder in a named commit', async () => {
        await recordFlowVersion(chatflow('Sales Desk', flow()), { lookupCredentials })
        await recordFlowDeletion({ id: ID, name: 'Sales Desk' })
        const dir = versionsDir()
        expect(git(dir, 'log', '-1', '--format=%s').trim()).toBe('Deleted Sales Desk')
        expect(fs.readdirSync(path.join(dir, 'flows'))).toEqual([])
    })

    test('saves that arrive together are committed one at a time', async () => {
        const saves = [1, 2, 3, 4, 5].map((n) =>
            recordFlowVersion(chatflow('Sales Desk', flow(`Version ${n}\nline`)), { lookupCredentials })
        )
        const shas = await Promise.all(saves)
        await flushVersions()
        expect(shas.every((sha) => typeof sha === 'string')).toBe(true)
        expect(git(versionsDir(), 'rev-list', '--count', 'HEAD').trim()).toBe('6')
        expect(getStatus().lastError).toBeNull()
    })

    test('copies the flow when it is called, so a later change to the saved object is not committed', async () => {
        const saved = chatflow('Sales Desk', flow('As saved\nline'))
        const pending = recordFlowVersion(saved, { lookupCredentials })
        saved.flowData = JSON.stringify(flow('Changed after the save\nline'))
        saved.name = 'Other name'
        const sha = await pending
        const dir = versionsDir()
        const files = git(dir, 'show', '--name-only', '--format=', sha!)
        expect(files).toContain('flows/sales-desk--7d1f0c2a/')
        expect(git(dir, 'show', `${sha}:flows/sales-desk--7d1f0c2a/prompts/harnessChief_0.instructions.md`)).toContain('As saved')
    })

    test("ignores the user's global Git config, so a global excludes file cannot drop JSON files", async () => {
        const home = path.join(tmp, 'home')
        fs.mkdirSync(home, { recursive: true })
        fs.writeFileSync(path.join(home, 'ignore-all-json'), '*.json\n')
        fs.writeFileSync(path.join(home, '.gitconfig'), `[core]\n\texcludesFile = ${path.join(home, 'ignore-all-json')}\n`)
        process.env.HOME = home
        process.env.XDG_CONFIG_HOME = path.join(home, '.config')
        const sha = await recordFlowVersion(chatflow('Sales Desk', flow()), { lookupCredentials })
        expect(sha).toEqual(expect.any(String))
        const files = git(versionsDir(), 'show', '--name-only', '--format=', sha!).split('\n')
        expect(files).toContain('flows/sales-desk--7d1f0c2a/flow.json')
        expect(files).toContain('flows/sales-desk--7d1f0c2a/edges.json')
        expect(git(versionsDir(), 'status', '--porcelain').trim()).toBe('')
    })

    test('without git on PATH the save still resolves and the reason is kept', async () => {
        process.env.PATH = path.join(tmp, 'no-bin')
        const sha = await recordFlowVersion(chatflow('Sales Desk', flow()), { lookupCredentials })
        expect(sha).toBeNull()
        expect(getStatus().lastError?.message).toContain('git was not found on PATH')
    })
})

describe('hiddenInputsDiffer', () => {
    const hidden = [{ node: 'n1', label: 'Agent', input: 'instructions', inputLabel: 'Instructions', count: 1 }]
    const data = (instructions: string, other = 'a') =>
        JSON.stringify({ nodes: [{ id: 'n1', data: { inputs: { instructions, other } } }], edges: [] })
    const key = ['sk', 'abcdEFGH1234ijklMNOP5678'].join('-')

    test('a live secret where the version holds the placeholder is a change', () => {
        expect(hiddenInputsDiffer(data(`Use ${key}`), data(`Use ${SECRET_PLACEHOLDER}`), hidden)).toBe(true)
    })

    test('the placeholder already live, other inputs, or nothing hidden is not', () => {
        expect(hiddenInputsDiffer(data(`Use ${SECRET_PLACEHOLDER}`, 'a'), data(`Use ${SECRET_PLACEHOLDER}`, 'b'), hidden)).toBe(false)
        expect(hiddenInputsDiffer(data(`Use ${key}`), data(`Use ${SECRET_PLACEHOLDER}`), [])).toBe(false)
    })
})

describe('pickCredential', () => {
    const ref = { name: 'OpenAI main', credentialName: 'openAIApi' }
    test('none, one, several with one in use, several with none in use', () => {
        expect(pickCredential(ref, [], new Set())).toEqual({ id: undefined, ambiguous: null })
        expect(pickCredential(ref, ['a'], new Set(['b']))).toEqual({ id: 'a', ambiguous: null })
        expect(pickCredential(ref, ['a', 'b', 'c'], new Set(['c']))).toEqual({ id: 'c', ambiguous: { ...ref, count: 3, using: 'current' } })
        expect(pickCredential(ref, ['a', 'b'], new Set(['z']))).toEqual({ id: 'a', ambiguous: { ...ref, count: 2, using: 'oldest' } })
    })
})

describe('version authors', () => {
    test('a user is named with a user-id address; API keys and system saves are Cuttlely', () => {
        expect(versionAuthor({ id: 'u-1', name: 'Dana Lee' })).toEqual({ name: 'Dana Lee', email: 'u-1@users.versions.local' })
        expect(versionAuthor({ id: 'u-1', name: ' Dana\n<Lee> ' })).toEqual({ name: 'Dana Lee', email: 'u-1@users.versions.local' })
        expect(versionAuthor({ id: 'u-1', name: 'Dana\u001fLee\u001e\u0000' })).toEqual({
            name: 'Dana Lee',
            email: 'u-1@users.versions.local'
        })
        expect(versionAuthor({ id: 'abcdef123456', name: 'dana@example.com' })).toEqual({
            name: 'User abcdef12',
            email: 'abcdef123456@users.versions.local'
        })
        expect(versionAuthor({ id: 'abcdef123456' })).toEqual({ name: 'User abcdef12', email: 'abcdef123456@users.versions.local' })
        expect(versionAuthor({ id: 'a b@c', name: 'X' }).email).toBe('abc@users.versions.local')
        expect(versionAuthor(undefined)).toEqual({ name: 'Cuttlely', email: 'system@versions.local' })
        expect(versionAuthor({ name: 'No id' })).toEqual({ name: 'Cuttlely', email: 'system@versions.local' })
    })

    test('a request user becomes an actor without the email; an API key has none', () => {
        expect(actorFromUser({ id: 'u-1', name: 'Dana', email: 'dana@example.com' } as any)).toEqual({ id: 'u-1', name: 'Dana' })
        expect(actorFromUser({ permissions: [] } as any)).toBeUndefined()
        expect(actorFromUser(undefined)).toBeUndefined()
    })
})

describe('change names', () => {
    const meta = { id: ID, name: 'Sales Desk' }
    test('added, removed and rewired nodes', () => {
        const before = serializeFlow(meta, flow())
        const grown = flow()
        grown.nodes.push({
            id: 'calculator_0',
            type: 'customNode',
            position: { x: 1, y: 1 },
            data: { id: 'calculator_0', label: 'Calculator', inputs: {} }
        } as any)
        expect(summarizeChange(before, serializeFlow(meta, grown), 'Sales Desk').title).toBe('Added Calculator')
        const shrunk = flow()
        shrunk.nodes.pop()
        shrunk.edges = []
        expect(summarizeChange(before, serializeFlow(meta, shrunk), 'Sales Desk').title).toBe('Removed ChatOpenAI')
        const rewired = flow()
        rewired.edges = [{ id: 'e2', source: 'harnessChief_0', target: 'chatOpenAI_0' }]
        expect(summarizeChange(before, serializeFlow(meta, rewired), 'Sales Desk').title).toBe('Rewired connections')
    })

    test('inputs are named with the labels on the canvas, and a credential switch says credential', () => {
        const refs = (id: string) =>
            id === 'cred-1'
                ? { name: 'OpenAI main', credentialName: 'openAIApi' }
                : id === 'cred-2'
                ? { name: 'OpenAI trial', credentialName: 'openAIApi' }
                : undefined
        const labelled = () => {
            const value: any = flow()
            value.nodes[1].data.inputParams = [{ name: 'modelName', label: 'Model Name' }]
            return value
        }
        const before = serializeFlow(meta, labelled(), { credentialRef: refs })
        const after: any = labelled()
        after.nodes[1].data.credential = 'cred-2'
        after.nodes[1].data.inputs.FLOWISE_CREDENTIAL_ID = 'cred-2'
        after.nodes[1].data.inputs.modelName = 'gpt-4.1-mini'
        after.nodes[1].data.inputs.maxTokens = 300
        const summary = summarizeChange(before, serializeFlow(meta, after, { credentialRef: refs }), 'Sales Desk')
        expect(summary.title).toBe('Changed credential, max tokens and 1 more on ChatOpenAI')
        expect(summary.details).toEqual(['Changed credential, max tokens, Model Name on ChatOpenAI'])
        expect(JSON.stringify(summary)).not.toContain('FLOWISE_CREDENTIAL_ID')
    })

    test('the first canvas save of an API-made flow is named for the move only', () => {
        // The canvas drops inputs.FLOWISE_CREDENTIAL_ID and measures node sizes when it saves.
        const before = serializeFlow(meta, flow(), { credentialRef: () => ({ name: 'OpenAI main', credentialName: 'openAIApi' }) })
        const canvas: any = flow()
        delete canvas.nodes[1].data.inputs.FLOWISE_CREDENTIAL_ID
        canvas.nodes[1].width = 300
        canvas.nodes[1].height = 676
        canvas.nodes[0].position = { x: 40, y: 120 }
        canvas.viewport = { x: 73, y: 139, zoom: 0.77 }
        const after = serializeFlow(meta, canvas, { credentialRef: () => ({ name: 'OpenAI main', credentialName: 'openAIApi' }) })
        expect(summarizeChange(before, after, 'Sales Desk').title).toBe('Moved nodes')
        expect(diffFlowFiles(before, after)).toMatchObject({ changed: [], moved: ['harnessChief_0'] })
    })

    test('files from the earlier serializer compare equal when only the credential layout differs', () => {
        // Before A7 the credential input was written next to data.credential (or alone).
        const refs = () => ({ name: 'OpenAI main', credentialName: 'openAIApi' })
        const current = serializeFlow(meta, flow(), { credentialRef: refs })
        const file = Object.keys(current).find((name) => name.endsWith('chatOpenAI_0.json'))!
        const marker = { $credential: { credentialName: 'openAIApi', name: 'OpenAI main' } }
        const both = JSON.parse(current[file])
        both.data.inputs.FLOWISE_CREDENTIAL_ID = marker
        const inputsOnly = JSON.parse(current[file])
        inputsOnly.data.inputs.FLOWISE_CREDENTIAL_ID = marker
        delete inputsOnly.data.credential
        for (const legacyNode of [both, inputsOnly]) {
            const legacy = { ...current, [file]: canonicalJson(legacyNode) }
            const summary = summarizeChange(legacy, current, 'Sales Desk')
            expect(summary).toEqual({ title: 'Saved Sales Desk', details: [] })
            const diff = diffFlowFiles(legacy, current)
            expect(diff.changed).toEqual([])
            expect(hasChanges(diff)).toBe(false)
        }
        // A real credential switch against legacy files is still a change.
        const switched = JSON.parse(current[file])
        switched.data.inputs.FLOWISE_CREDENTIAL_ID = { $credential: { credentialName: 'openAIApi', name: 'OpenAI trial' } }
        switched.data.credential = switched.data.inputs.FLOWISE_CREDENTIAL_ID
        const legacy = { ...current, [file]: canonicalJson(switched) }
        expect(summarizeChange(legacy, current, 'Sales Desk').title).toBe('Changed credential on ChatOpenAI')
        expect(diffFlowFiles(legacy, current).changed).toEqual([{ id: 'chatOpenAI_0', label: 'ChatOpenAI', fields: ['credential'] }])
    })

    test('a size or viewport change alone is not named a move', () => {
        const before = serializeFlow(meta, flow())
        const resized: any = flow()
        resized.nodes[1].height = 999
        resized.viewport = { x: 5, y: 5, zoom: 2 }
        const after = serializeFlow(meta, resized)
        expect(summarizeChange(before, after, 'Sales Desk').title).toBe('Saved Sales Desk')
        expect(diffFlowFiles(before, after).moved).toEqual([])
    })

    test('titles stay short', () => {
        const before = serializeFlow(meta, flow())
        const changed = flow('Another long instruction set\nwith lines', { temperature: 0.9, maxTokens: 200, topP: 0.5 })
        changed.nodes[0].data.label = 'Harness Prime with a very long label that goes on and on and on'
        const title = summarizeChange(before, serializeFlow(meta, changed), 'Sales Desk').title
        expect(title.length).toBeLessThanOrEqual(72)
    })
})

describe('secret scan', () => {
    test('names the file and pattern for each hit', () => {
        const key = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')
        expect(scanForSecrets({ 'a.json': `{"k":"${key}"}`, 'b.md': 'plain words' })).toEqual([{ file: 'a.json', pattern: 'akia' }])
    })
})

describe('flow lookup', () => {
    test('a save that has only an id loads the canvas through the lookup', async () => {
        const saved = chatflow('Sales Desk', flow())
        configureVersioning({
            ...emptyDeps(),
            flows: {
                async get(id) {
                    return id === saved.id ? saved : null
                }
            }
        })
        const sha = await recordFlowVersion({ id: saved.id, name: '', flowData: undefined as unknown as string })
        expect(sha).toBeTruthy()
        expect((await listVersions(saved.id)).versions[0]).toMatchObject({
            kind: 'create',
            title: 'Created Sales Desk',
            name: 'Sales Desk'
        })
    })
})
