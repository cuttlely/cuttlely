import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
    flushVersions,
    getStore,
    isVersioningEnabled,
    recordFlowDeletion,
    recordFlowVersion,
    resetForTests,
    setGithubForTests,
    versionsDir
} from './index'
import { authEnv, checkToken, classifyFailure, GithubSync, parseRepo, scrub } from './github'
import { environmentListFingerprint } from './environments'
import { gitEnv, runGit, VersionStore } from './store'
import { useTestDeps, warnings } from './testDeps'

// Never a real token. Built so no secret scanner sees a token shape in this file.
// These tests run real git processes. On an idle box the slowest test takes about 4 s; while other builds run,
// some pass 5 s, Jest's default. 20 s leaves room for a busy box and still fails a hung git call quickly.
jest.setTimeout(20_000)

const TOKEN = ['test', 'token', 'NOT', 'REAL', '5d8e1f'].join('-')
const ID = '7d1f0c2a-aaaa-bbbb-cccc-ddddeeeeffff'
const lookupCredentials = async () => new Map()

function flow(instructions: string) {
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
            }
        ],
        edges: []
    }
}

function save(text: string) {
    return recordFlowVersion(
        { id: ID, name: 'Bakery helper', type: 'CHATFLOW', flowData: JSON.stringify(flow(text)) },
        { lookupCredentials }
    )
}

// git for the test's own repos: no inherited GIT_* variables and no user config.
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value
    return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0', ...extra }
}

function plainGit(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(cwd) })
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

function bareRef(bare: string, ref: string): string | null {
    try {
        return execFileSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '-q', ref], {
            encoding: 'utf8',
            env: cleanEnv()
        }).trim()
    } catch {
        return null
    }
}

function noteAuthorEnv(): NodeJS.ProcessEnv {
    return cleanEnv({
        GIT_AUTHOR_NAME: 'Cuttlely',
        GIT_AUTHOR_EMAIL: 'system@versions.local',
        GIT_COMMITTER_NAME: 'Cuttlely',
        GIT_COMMITTER_EMAIL: 'system@versions.local'
    })
}

function refOf(dir: string, ref: string): string | null {
    try {
        return plainGit(dir, 'rev-parse', '--verify', '-q', `${ref}^{commit}`).trim() || null
    } catch {
        return null
    }
}

function remoteNote(bare: string, sha: string, work: string): string {
    fs.rmSync(work, { recursive: true, force: true })
    fs.mkdirSync(work, { recursive: true })
    const env = noteAuthorEnv()
    execFileSync('git', ['init', '-q'], { cwd: work, env })
    execFileSync('git', ['fetch', '-q', `file://${bare}`, 'refs/notes/commits:refs/notes/commits'], { cwd: work, env })
    return execFileSync('git', ['notes', 'show', sha], { cwd: work, env, encoding: 'utf8' }).trim()
}

function bareLog(bare: string): string {
    return execFileSync('git', ['--git-dir', bare, 'log', '-p', '--all'], { encoding: 'utf8', env: cleanEnv() })
}

function seedRemote(ref: string) {
    execFileSync('git', ['--git-dir', path.join(versionsDir(), '.git'), 'push', '-q', `file://${bare}`, `HEAD:${ref}`], {
        env: cleanEnv()
    })
}

// The previous environment copied: its branch and the recorded environment list, which is what a later server requires.
function seedRecordedVersions(ref: string, environments: { name: string; branch: string; server: string }[]) {
    seedRemote(ref)
    const work = path.join(tmp, `seed-notes-${ref.replace(/[^\w]+/g, '-')}`)
    fs.rmSync(work, { recursive: true, force: true })
    fs.mkdirSync(work, { recursive: true })
    const env = noteAuthorEnv()
    execFileSync('git', ['init', '-q'], { cwd: work, env })
    execFileSync('git', ['fetch', '-q', `file://${bare}`, `${ref}:refs/heads/seeded`], { cwd: work, env })
    const sha = execFileSync('git', ['rev-parse', 'refs/heads/seeded'], { cwd: work, env, encoding: 'utf8' }).trim()
    execFileSync('git', ['notes', 'add', '-f', '-m', environmentListFingerprint(environments), sha], { cwd: work, env })
    execFileSync('git', ['push', '-q', `file://${bare}`, 'refs/notes/commits:refs/notes/commits'], { cwd: work, env })
}

// A new tip on a branch that already has versions. note is recorded on that tip; null leaves the existing record.
function advancePrevious(branch: string, note: string | null): string {
    const work = path.join(tmp, `advance-${branch.replace(/[^\w]+/g, '-')}`)
    fs.rmSync(work, { recursive: true, force: true })
    fs.mkdirSync(work, { recursive: true })
    const env = noteAuthorEnv()
    execFileSync('git', ['init', '-q'], { cwd: work, env })
    execFileSync('git', ['fetch', '-q', `file://${bare}`, `${branch}:refs/heads/src`], { cwd: work, env })
    if (bareRef(bare, 'refs/notes/commits')) {
        execFileSync('git', ['fetch', '-q', `file://${bare}`, 'refs/notes/commits:refs/notes/commits'], { cwd: work, env })
    }
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/src'], { cwd: work, env })
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'newer'], { cwd: work, env })
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, env, encoding: 'utf8' }).trim()
    const args = ['push', '-q', `file://${bare}`, `HEAD:${branch}`]
    if (note !== null) {
        execFileSync('git', ['notes', 'add', '-f', '-m', note, sha], { cwd: work, env })
        args.push('refs/notes/commits:refs/notes/commits')
    }
    execFileSync('git', args, { cwd: work, env })
    return sha
}

function makeBare(dir: string): string {
    execFileSync('git', ['init', '-q', '--bare', dir], { env: cleanEnv() })
    return dir
}

// A commit on the remote's main that this server does not have.
function foreignCommit(bare: string, work: string, branch = 'main') {
    fs.mkdirSync(work, { recursive: true })
    const env = cleanEnv({
        GIT_AUTHOR_NAME: 'someone',
        GIT_AUTHOR_EMAIL: 'someone@example.invalid',
        GIT_COMMITTER_NAME: 'someone',
        GIT_COMMITTER_EMAIL: 'someone@example.invalid'
    })
    if (bareMain(bare)) execFileSync('git', ['clone', '-q', '-b', 'main', `file://${bare}`, '.'], { cwd: work, env })
    else execFileSync('git', ['init', '-q'], { cwd: work, env })
    fs.writeFileSync(path.join(work, 'README.md'), '# made on GitHub\n')
    execFileSync('git', ['add', 'README.md'], { cwd: work, env })
    execFileSync('git', ['commit', '-q', '-m', 'Initial commit'], { cwd: work, env })
    execFileSync('git', ['push', '-q', `file://${bare}`, `HEAD:refs/heads/${branch}`], { cwd: work, env })
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
let gitCalls: { args: string[]; env: Record<string, string> }[]
let sync: GithubSync
// Stands in for Credentials: Github API rows by id and workspace, values held as the app would decrypt them.
let credentialRows: Map<string, { id: string; name: string; token: string; workspaceId: string }>
const WS = 'ws-1'
const credentialStore = {
    async get(id: string, workspaceId: string) {
        const row = credentialRows.get(id)
        return row && row.workspaceId === workspaceId ? { id: row.id, name: row.name, token: row.token } : null
    },
    async create(input: { name: string; token: string; workspaceId: string }) {
        const id = `cred-${credentialRows.size + 1}`
        credentialRows.set(id, { id, ...input })
        return { id, name: input.name }
    }
}
const savedEnv = { ...process.env }

function makeSync(options: Partial<ConstructorParameters<typeof GithubSync>[0]> = {}) {
    return new GithubSync({
        store: getStore,
        enabled: isVersioningEnabled,
        credentials: credentialStore,
        log: (message) => warnings.push(message),
        debounceMs: 0,
        retryMs: [60_000],
        onGit: (args, env) => gitCalls.push({ args, env }),
        ...options
    })
}

async function settle() {
    await flushVersions()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await sync.idle()
}

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-github-'))
    process.env.CUTTLELY_VERSIONS = 'on'
    process.env.CUTTLELY_VERSIONS_DIR = path.join(tmp, 'versions')
    process.env.CUTTLELY_GITHUB_ALLOW_FILE_REMOTES = 'on'
    useTestDeps()
    resetForTests()
    gitCalls = []
    credentialRows = new Map()
    bare = makeBare(path.join(tmp, 'remote.git'))
    sync = makeSync()
    setGithubForTests(sync)
})

afterEach(() => {
    sync.stop()
    setGithubForTests(null)
    process.env = { ...savedEnv }
    fs.rmSync(tmp, { recursive: true, force: true })
})

function expectTokenNowhere() {
    for (const call of gitCalls) expect(call.args.join(' ')).not.toContain(TOKEN)
    for (const file of allFiles(versionsDir())) expect(fs.readFileSync(file).toString('latin1')).not.toContain(TOKEN)
    expect(bareLog(bare)).not.toContain(TOKEN)
    for (const file of allFiles(bare)) expect(fs.readFileSync(file).toString('latin1')).not.toContain(TOKEN)
    expect(JSON.stringify(warnings)).not.toContain(TOKEN)
}

describe('repository and token input', () => {
    test.each([
        ['acme/flows', 'acme/flows'],
        [' acme/flows.git ', 'acme/flows'],
        ['https://github.com/acme/flows', 'acme/flows'],
        ['https://github.com/acme/flows.git/', 'acme/flows'],
        ['https://www.github.com/Acme-Co/my.flows_1', 'Acme-Co/my.flows_1'],
        ['acme/flows.GIT', 'acme/flows'],
        ['acme/flows.GiT', 'acme/flows'],
        [`acme/flows${'/'.repeat(80)}`, 'acme/flows'],
        [`acme/flows.git${'/'.repeat(40)}`, 'acme/flows']
    ])('%s is %s on github.com', (input, repo) => {
        expect(parseRepo(input)).toEqual({ repo, url: `https://github.com/${repo}.git` })
    })

    test.each([
        '',
        '/',
        '/'.repeat(40),
        '.git',
        'flows',
        'acme/flows/extra',
        'git@github.com:acme/flows.git',
        'https://user:pass@github.com/acme/flows',
        'http://github.com/acme/flows',
        'https://gitlab.com/acme/flows',
        'ssh://github.com/acme/flows',
        '-acme/flows',
        'acme/..'
    ])('refuses %j', (input) => {
        expect(() => parseRepo(input)).toThrow()
    })

    test('a file:// repository needs CUTTLELY_GITHUB_ALLOW_FILE_REMOTES', () => {
        expect(parseRepo(`file://${bare}`)).toEqual({ repo: `file://${bare}`, url: `file://${bare}` })
        delete process.env.CUTTLELY_GITHUB_ALLOW_FILE_REMOTES
        expect(() => parseRepo(`file://${bare}`)).toThrow('owner/name')
        process.env.CUTTLELY_GITHUB_ALLOW_FILE_REMOTES = 'on'
        expect(() => parseRepo('file://relative/path')).toThrow('absolute')
    })

    test('a token is one word of printable characters', () => {
        expect(checkToken(`  ${TOKEN}\n`)).toBe(TOKEN)
        expect(() => checkToken('')).toThrow('Paste a GitHub token.')
        expect(() => checkToken('two words')).toThrow()
        expect(() => checkToken('x'.repeat(401))).toThrow()
    })

    test('the token goes to git only as a header scoped to the repository, in the environment', () => {
        const env = authEnv('https://github.com/acme/flows.git', TOKEN)
        expect(env.GIT_CONFIG_COUNT).toBe('1')
        expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/acme/flows.git.extraHeader')
        expect(env.GIT_CONFIG_KEY_0).not.toContain(TOKEN)
        const header = env.GIT_CONFIG_VALUE_0.replace('Authorization: Basic ', '')
        expect(Buffer.from(header, 'base64').toString()).toBe(`x-access-token:${TOKEN}`)
        expect(authEnv(`file://${bare}`, TOKEN)).toEqual({})
    })

    test('scrub removes the token, its header, token shapes and URL passwords', () => {
        const header = Buffer.from(`x-access-token:${TOKEN}`).toString('base64')
        const shaped = ['gh', 'p_', 'a'.repeat(30)].join('')
        const text = `fatal: ${TOKEN} ${header} ${shaped} https://me:pw@github.com/x Authorization: Basic abc`
        const out = scrub(text, TOKEN)
        expect(out).not.toContain(TOKEN)
        expect(out).not.toContain(header)
        expect(out).not.toContain(shaped)
        expect(out).not.toContain('me:pw')
        expect(out).not.toContain('abc')
    })

    test.each([
        ['remote: error: GH006: Protected branch update failed', 'protected', false],
        ['remote: error: GH013: Repository rule violations found for refs/heads/main.', 'protected', false],
        [' ! [rejected]        main -> main (fetch first)', 'diverged', false],
        ['! refs/heads/main [rejected] (non-fast-forward)', 'diverged', false],
        ['remote: Repository not found.\nfatal: repository not found', 'auth', true],
        ['fatal: Authentication failed for https://github.com/acme/flows.git/', 'auth', true],
        ['fatal: unable to access: Could not resolve host: github.com', 'network', true],
        ['something new', 'other', true]
    ])('%s is %s', (stderr, kind, retry) => {
        expect(classifyFailure(stderr, 'acme/flows')).toMatchObject({ kind, retry })
    })

    test('a timeout is a network failure that retries', () => {
        expect(classifyFailure('', 'acme/flows', true)).toMatchObject({ kind: 'network', retry: true })
    })

    test('a long whitespace run before main is a rejected copy', () => {
        expect(classifyFailure(`rejected${' '.repeat(4000)}main`, 'acme/flows').kind).toBe('diverged')
        expect(classifyFailure('rejected\nmain', 'acme/flows').kind).toBe('diverged')
        expect(classifyFailure(`rejected${' '.repeat(80)}other`, 'acme/flows').kind).toBe('other')
        expect(classifyFailure('rejected foo\nmain', 'acme/flows').kind).toBe('other')
    })
})

describe('copying history to a repository', () => {
    test('not connected: history stays local and nothing is pushed', async () => {
        await save('One')
        await settle()
        expect(await sync.status()).toMatchObject({ enabled: true, connected: false, state: 'not-connected' })
        expect(bareMain(bare)).toBeNull()
        expect(gitCalls).toEqual([])
    })

    test('connect checks the repository, saves the token encrypted, and copies every version', async () => {
        await save('One')
        await save('Two')
        const status = await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const head = plainGit(versionsDir(), 'rev-parse', 'refs/heads/main').trim()
        expect(bareMain(bare)).toBe(head)
        expect(status).toMatchObject({
            connected: true,
            credential: { id: 'cred-1', name: 'GitHub: test repository' },
            state: 'up-to-date',
            waiting: 0,
            lastCopiedVersion: head.slice(0, 7)
        })
        expect(status.connectedAt).toEqual(expect.any(String))
        expect(JSON.stringify(status)).not.toContain(TOKEN)

        const file = path.join(versionsDir(), '.git', 'versions-github.json')
        expect(fs.statSync(file).mode & 0o777).toBe(0o600)
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
        expect(saved.repo).toBe(`file://${bare}`)
        // The token is a Github API credential in Credentials. The file holds only its id and name.
        expect(saved.credential).toEqual({ id: 'cred-1', name: 'GitHub: test repository', workspaceId: WS })
        expect(credentialRows.get('cred-1')).toMatchObject({ token: TOKEN, workspaceId: WS })
        // Never in the work tree, so never committed.
        expect(plainGit(versionsDir(), 'status', '--porcelain').trim()).toBe('')
        expect(plainGit(versionsDir(), 'ls-files')).not.toContain('cuttlely-github')
        // No remote is added to the repo config, and nothing is force-pushed.
        expect(plainGit(versionsDir(), 'config', '--local', '--list')).not.toContain('remote.')
        for (const call of gitCalls) expect(call.args).not.toEqual(expect.arrayContaining(['--force']))
        for (const call of gitCalls) expect(call.args.some((arg) => arg.startsWith('+'))).toBe(false)
        expectTokenNowhere()
    })

    test('each new version is copied soon after it is saved', async () => {
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const sha = await save('Two')
        expect(sha).toMatch(/^[0-9a-f]{40}$/)
        await settle()
        expect(bareMain(bare)).toBe(sha)
        expect(await sync.status()).toMatchObject({ state: 'up-to-date', waiting: 0 })
        expect(plainGit(versionsDir(), 'rev-parse', 'refs/versions/github').trim()).toBe(sha)
        expectTokenNowhere()
    })

    test('GitHub out of reach never blocks a save: it waits, retries on its own, and catches up', async () => {
        sync.stop()
        sync = makeSync({ retryMs: [40] })
        setGithubForTests(sync)
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const away = `${bare}-away`
        fs.renameSync(bare, away)
        const sha = await save('Two')
        expect(sha).toMatch(/^[0-9a-f]{40}$/)
        await settle()
        const waiting = await sync.status()
        expect(waiting.state).toBe('retrying')
        expect(waiting.message).toContain('Publishing keeps working')
        expect(waiting.nextTryAt).toEqual(expect.any(String))
        expect(waiting.waiting).toBe(1)
        fs.renameSync(away, bare)
        await new Promise((resolve) => setTimeout(resolve, 120))
        await sync.idle()
        expect(bareMain(bare)).toBe(sha)
        expect((await sync.status()).state).toBe('up-to-date')
        expectTokenNowhere()
    })

    test('Try again copies at once after a failure', async () => {
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const away = `${bare}-away`
        fs.renameSync(bare, away)
        const sha = await save('Two')
        await settle()
        expect((await sync.status()).state).toBe('retrying')
        fs.renameSync(away, bare)
        const status = await sync.tryNow()
        expect(status.state).toBe('up-to-date')
        expect(bareMain(bare)).toBe(sha)
    })

    test('changes made on GitHub stop the copy instead of being overwritten', async () => {
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        foreignCommit(bare, path.join(tmp, 'elsewhere'))
        const foreign = bareMain(bare)
        await save('Two')
        await settle()
        const status = await sync.status()
        expect(status.state).toBe('stopped')
        expect(status.message).toContain('never overwrites GitHub')
        expect(bareMain(bare)).toBe(foreign)
        // A later save does not keep trying.
        const calls = gitCalls.length
        await save('Three')
        await settle()
        expect(gitCalls.length).toBe(calls)
        expect(bareMain(bare)).toBe(foreign)
    })

    test('connect refuses a repository with content on another branch only (master), and pushes nothing', async () => {
        await save('One')
        foreignCommit(bare, path.join(tmp, 'elsewhere'), 'master')
        await expect(sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)).rejects.toMatchObject({
            status: 409,
            message: expect.stringContaining('already has other content')
        })
        expect(bareMain(bare)).toBeNull()
        expect(fs.existsSync(path.join(versionsDir(), '.git', 'versions-github.json'))).toBe(false)
        expect(credentialRows.size).toBe(0)
    })

    test('connect refuses a repository with only a tag, and pushes nothing', async () => {
        await save('One')
        const work = path.join(tmp, 'tagged')
        foreignCommit(bare, work, 'scratch')
        execFileSync('git', ['--git-dir', bare, 'tag', 'v1', 'refs/heads/scratch'], { env: cleanEnv() })
        execFileSync('git', ['--git-dir', bare, 'update-ref', '-d', 'refs/heads/scratch'], { env: cleanEnv() })
        expect(
            execFileSync('git', ['--git-dir', bare, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8', env: cleanEnv() }).trim()
        ).toBe('refs/tags/v1')
        await expect(sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)).rejects.toMatchObject({
            status: 409,
            message: expect.stringContaining('already has other content')
        })
        expect(bareMain(bare)).toBeNull()
        expect(credentialRows.size).toBe(0)
    })

    test('connect refuses a repository that already has other content on main, and saves nothing', async () => {
        await save('One')
        foreignCommit(bare, path.join(tmp, 'elsewhere'))
        await expect(sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)).rejects.toMatchObject({
            status: 409,
            message: expect.stringContaining('already has other content')
        })
        expect(fs.existsSync(path.join(versionsDir(), '.git', 'versions-github.json'))).toBe(false)
        expect((await sync.status()).connected).toBe(false)
    })

    test('connect refuses a repository it cannot reach, and saves nothing', async () => {
        await save('One')
        await expect(sync.connect({ repo: `file://${tmp}/missing.git`, token: TOKEN }, WS)).rejects.toMatchObject({ status: 400 })
        expect(fs.existsSync(path.join(versionsDir(), '.git', 'versions-github.json'))).toBe(false)
        expectTokenNowhere()
    })

    test('reconnecting to a repository this server copied to before copies only what is new', async () => {
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const first = bareMain(bare)
        const disconnected = await sync.disconnect()
        expect(disconnected).toMatchObject({ connected: false, state: 'not-connected' })
        expect(fs.existsSync(path.join(versionsDir(), '.git', 'versions-github.json'))).toBe(false)
        // Disconnect leaves GitHub as it was.
        expect(bareMain(bare)).toBe(first)
        const sha = await save('Two')
        await settle()
        expect(bareMain(bare)).toBe(first)
        const status = await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(status.state).toBe('up-to-date')
        expect(bareMain(bare)).toBe(sha)
    })

    test('secret-shaped text already in history is never copied', async () => {
        await save('One')
        // A version written around the commit-time check, as an older release might have.
        const dir = versionsDir()
        fs.writeFileSync(path.join(dir, 'flows', 'leak.txt'), `key ${['sk', 'a'.repeat(24)].join('-')}\n`)
        await runGit(dir, ['add', '-A'])
        await runGit(dir, ['commit', '-q', '--no-verify', '-m', 'old version'], {
            GIT_AUTHOR_NAME: 'cuttlely',
            GIT_AUTHOR_EMAIL: 'system@versions.local',
            GIT_COMMITTER_NAME: 'cuttlely',
            GIT_COMMITTER_EMAIL: 'system@versions.local'
        })
        const status = await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(status.state).toBe('stopped')
        expect(status.message).toContain('secret-shaped text (sk)')
        expect(status.message).not.toContain('aaaa')
        expect(bareMain(bare)).toBeNull()
    })

    test('secret-shaped text in a version title is never copied', async () => {
        await save('One')
        // A deleted flow's name is only in its last version's title and trailer, not in a file.
        const leaked = ['sk', 'b'.repeat(24)].join('-')
        await recordFlowDeletion({ id: ID, name: `Old ${leaked}` }, null)
        await flushVersions()
        expect(plainGit(versionsDir(), 'log', '-1', '--format=%B')).toContain(leaked)
        const status = await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(status.state).toBe('stopped')
        expect(status.message).toContain('secret-shaped text (sk) in its title or details')
        expect(status.message).not.toContain('bbbb')
        expect(bareMain(bare)).toBeNull()
    })

    test('a secret in a version far back in a long history is still found', async () => {
        await save('One')
        const dir = versionsDir()
        const env = {
            GIT_AUTHOR_NAME: 'cuttlely',
            GIT_AUTHOR_EMAIL: 'system@versions.local',
            GIT_COMMITTER_NAME: 'cuttlely',
            GIT_COMMITTER_EMAIL: 'system@versions.local'
        }
        // 120 versions: the secret is in one of the last.
        for (let i = 0; i < 120; i++) {
            const text = i === 110 ? `key ${['sk', 'c'.repeat(24)].join('-')}\n` : `note ${i}\n`
            fs.writeFileSync(path.join(dir, 'flows', 'notes.txt'), text)
            await runGit(dir, ['add', '-A'])
            await runGit(dir, ['commit', '-q', '--no-verify', '-m', `note ${i}`], env)
        }
        const status = await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(status.state).toBe('stopped')
        expect(status.message).toContain('secret-shaped text (sk) in flows/notes.txt')
        expect(bareMain(bare)).toBeNull()
    })

    test('an added line that itself starts with ++ is still scanned', async () => {
        await save('One')
        const dir = versionsDir()
        // Git shows this added line as "+++ key ...", which looks like a file header.
        fs.writeFileSync(path.join(dir, 'flows', 'plus.txt'), `first\n++ key ${['sk', 'e'.repeat(24)].join('-')}\n`)
        await runGit(dir, ['add', '-A'])
        await runGit(dir, ['commit', '-q', '--no-verify', '-m', 'plus'], {
            GIT_AUTHOR_NAME: 'cuttlely',
            GIT_AUTHOR_EMAIL: 'system@versions.local',
            GIT_COMMITTER_NAME: 'cuttlely',
            GIT_COMMITTER_EMAIL: 'system@versions.local'
        })
        const status = await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(status.state).toBe('stopped')
        expect(status.message).toContain('secret-shaped text (sk) in flows/plus.txt')
        expect(bareMain(bare)).toBeNull()
    })

    test('a version larger than any output buffer is still scanned to the end', async () => {
        await save('One')
        const dir = versionsDir()
        // About 70 MB of added lines, past runGit's 64 MiB buffer, with the secret on the last line.
        const line = `${'x'.repeat(99)}\n`
        const fd = fs.openSync(path.join(dir, 'flows', 'big.txt'), 'w')
        const block = line.repeat(10_000)
        for (let i = 0; i < 70; i++) fs.writeSync(fd, block)
        fs.writeSync(fd, `key ${['sk', 'd'.repeat(24)].join('-')}\n`)
        fs.closeSync(fd)
        await runGit(dir, ['add', '-A'])
        await runGit(dir, ['commit', '-q', '--no-verify', '-m', 'big'], {
            GIT_AUTHOR_NAME: 'cuttlely',
            GIT_AUTHOR_EMAIL: 'system@versions.local',
            GIT_COMMITTER_NAME: 'cuttlely',
            GIT_COMMITTER_EMAIL: 'system@versions.local'
        })
        const status = await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(status.state).toBe('stopped')
        expect(status.message).toContain('secret-shaped text (sk) in flows/big.txt')
        expect(bareMain(bare)).toBeNull()
    }, 120_000)

    test('disconnecting while a copy is being checked stops that copy before it starts', async () => {
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const copied = bareMain(bare)
        const scan = (sync as any).scanRange.bind(sync)
        ;(sync as any).scanRange = async (base: string | null, head: string) => {
            await sync.disconnect()
            return scan(base, head)
        }
        const pushes = () => gitCalls.filter((call) => call.args.includes('push')).length
        const before = pushes()
        await save('Two')
        await settle()
        expect(pushes()).toBe(before)
        expect(bareMain(bare)).toBe(copied)
        expect((await sync.status()).connected).toBe(false)
    })

    test('an unexpected error while copying retries later instead of waiting forever', async () => {
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        ;(sync as any).scanRange = async () => {
            throw new Error('maxBuffer length exceeded')
        }
        await save('Two')
        await settle()
        const status = await sync.status()
        expect(status.state).toBe('retrying')
        expect(status.message).toContain('Something went wrong while copying to GitHub.')
        expect(status.nextTryAt).toEqual(expect.any(String))
    })

    test('connect can use a GitHub credential already in Credentials, and makes no new one', async () => {
        credentialRows.set('cred-9', { id: 'cred-9', name: 'Team GitHub', token: TOKEN, workspaceId: WS })
        const sha = await save('One')
        const status = await sync.connect({ repo: `file://${bare}`, credentialId: 'cred-9' }, WS)
        expect(status).toMatchObject({ state: 'up-to-date', credential: { id: 'cred-9', name: 'Team GitHub' } })
        expect(bareMain(bare)).toBe(sha)
        expect(credentialRows.size).toBe(1)
        expectTokenNowhere()
    })

    test('a credential from another workspace is refused', async () => {
        credentialRows.set('cred-9', { id: 'cred-9', name: 'Team GitHub', token: TOKEN, workspaceId: 'ws-other' })
        await save('One')
        await expect(sync.connect({ repo: `file://${bare}`, credentialId: 'cred-9' }, WS)).rejects.toMatchObject({ status: 404 })
        expect(fs.existsSync(path.join(versionsDir(), '.git', 'versions-github.json'))).toBe(false)
    })

    test('a pasted token gets the name the owner typed', async () => {
        await save('One')
        const status = await sync.connect({ repo: `file://${bare}`, token: TOKEN, credentialName: 'Flows backup' }, WS)
        expect(status.credential).toEqual({ id: 'cred-1', name: 'Flows backup' })
    })

    test('no credential is made when the check fails', async () => {
        await save('One')
        await expect(sync.connect({ repo: `file://${tmp}/missing.git`, token: TOKEN }, WS)).rejects.toMatchObject({ status: 400 })
        expect(credentialRows.size).toBe(0)
    })

    test('a changed token in Credentials is used on the next copy', async () => {
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const rotated = `${TOKEN}-rotated`
        credentialRows.get('cred-1')!.token = rotated
        const config = await sync.config()
        expect(config?.token).toBe(rotated)
    })

    test('a deleted credential stops copying with a plain message', async () => {
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        credentialRows.delete('cred-1')
        await save('Two')
        await settle()
        const status = await sync.status()
        expect(status).toMatchObject({ connected: true, state: 'stopped', credential: { id: 'cred-1' } })
        expect(status.message).toContain('no longer in Credentials')
    })

    test('the server start copies what was saved while offline', async () => {
        const sha = await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const away = `${bare}-away`
        fs.renameSync(bare, away)
        const later = await save('Two')
        await settle()
        fs.renameSync(away, bare)
        expect(bareMain(bare)).toBe(sha)
        sync.stop()
        sync = makeSync()
        setGithubForTests(sync)
        sync.start()
        await settle()
        expect(bareMain(bare)).toBe(later)
    })

    test('a credential with no token asks for one', async () => {
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        credentialRows.get('cred-1')!.token = ''
        const status = await sync.status()
        expect(status.state).toBe('stopped')
        expect(status.message).toContain('has no access token')
    })

    test('with history off there is nothing to copy and connect is refused', async () => {
        process.env.CUTTLELY_VERSIONS = 'off'
        expect(await sync.status()).toMatchObject({ enabled: false, state: 'off' })
        await expect(sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)).rejects.toMatchObject({ status: 409 })
    })

    test('Try again with nothing connected is a clear error', async () => {
        await expect(sync.tryNow()).rejects.toMatchObject({ status: 409, message: 'GitHub is not connected.' })
    })
})

describe('picking or creating a repository', () => {
    function stubFetch(routes: Record<string, { status: number; body: unknown }>) {
        const calls: { url: string; init: any }[] = []
        const fetchStub = (async (url: string, init: any) => {
            calls.push({ url, init })
            const key = `${init?.method || 'GET'} ${String(url).replace('https://api.github.com', '')}`
            const hit = routes[key] || { status: 404, body: { message: 'Not Found' } }
            return { status: hit.status, json: async () => hit.body } as any
        }) as unknown as typeof fetch
        return { fetchStub, calls }
    }

    test('lists the repositories the token can write to, with empty ones marked', async () => {
        const { fetchStub, calls } = stubFetch({
            'GET /user': { status: 200, body: { login: 'acme-bot' } },
            'GET /user/repos?per_page=100&page=1&sort=pushed&affiliation=owner,collaborator,organization_member': {
                status: 200,
                body: [
                    { full_name: 'acme/flows', private: true, size: 0, pushed_at: null, permissions: { push: true } },
                    { full_name: 'acme/site', private: false, size: 120, pushed_at: '2026-10-01T00:00:00Z', permissions: { push: true } },
                    { full_name: 'acme/read-only', private: true, size: 5, permissions: { push: false } },
                    { full_name: 'acme/old', private: true, size: 5, archived: true, permissions: { push: true } }
                ]
            }
        })
        sync.stop()
        sync = makeSync({ fetch: fetchStub })
        const list = await sync.listRepos({ token: TOKEN }, WS)
        expect(list).toEqual({
            account: 'acme-bot',
            repos: [
                { repo: 'acme/flows', private: true, empty: true, pushedAt: null },
                { repo: 'acme/site', private: false, empty: false, pushedAt: '2026-10-01T00:00:00Z' }
            ]
        })
        expect(calls[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
        for (const call of calls) expect(call.url).not.toContain(TOKEN)
        expect(JSON.stringify(warnings)).not.toContain(TOKEN)
    })

    test('on Prod, a repository the token can only read is listed too, and no repository is created', async () => {
        const { fetchStub, calls } = stubFetch({
            'GET /user': { status: 200, body: { login: 'acme-bot' } },
            'GET /user/repos?per_page=100&page=1&sort=pushed&affiliation=owner,collaborator,organization_member': {
                status: 200,
                body: [
                    { full_name: 'acme/flows', private: true, size: 7, pushed_at: null, permissions: { push: false } },
                    { full_name: 'acme/old', private: true, size: 5, archived: true, permissions: { push: false } }
                ]
            }
        })
        sync.stop()
        sync = makeSync({ fetch: fetchStub })
        await sync.setEnvironment('prod')
        expect((await sync.listRepos({ token: TOKEN }, WS)).repos.map((r) => r.repo)).toEqual(['acme/flows'])
        const before = calls.length
        await expect(sync.createRepo({ token: TOKEN, name: 'cuttlely-flows' }, WS)).rejects.toMatchObject({
            status: 409,
            message: 'Pick the repository your Dev server copies to. A new one has nothing for this server to read.'
        })
        expect(calls.length).toBe(before)
    })

    test('a middle environment is told to use the previous environment, and Prod names Staging', async () => {
        const chain = [
            { name: 'Dev', branch: 'main', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        sync.stop()
        sync = makeSync({ fetch: (async () => ({ status: 500, json: async () => ({}) })) as unknown as typeof fetch })
        await sync.setEnvironment('staging', chain)
        await expect(sync.createRepo({ token: TOKEN, name: 'cuttlely-flows' }, WS)).rejects.toMatchObject({
            status: 409,
            message: 'Pick the repository your Dev server copies to. A new one has nothing for this server to read.'
        })
        await sync.setEnvironment('prod', chain)
        await expect(sync.createRepo({ token: TOKEN, name: 'cuttlely-flows' }, WS)).rejects.toMatchObject({
            status: 409,
            message: 'Pick the repository your Staging server copies to. A new one has nothing for this server to read.'
        })
    })

    test('reads every page of repositories', async () => {
        const page = (n: number, count: number) =>
            Array.from({ length: count }, (_, i) => ({ full_name: `acme/r${n}-${i}`, private: true, size: 1, permissions: { push: true } }))
        const q = (n: number) => `GET /user/repos?per_page=100&page=${n}&sort=pushed&affiliation=owner,collaborator,organization_member`
        const { fetchStub, calls } = stubFetch({
            'GET /user': { status: 200, body: { login: 'acme-bot' } },
            [q(1)]: { status: 200, body: page(1, 100) },
            [q(2)]: { status: 200, body: page(2, 1) }
        })
        sync.stop()
        sync = makeSync({ fetch: fetchStub })
        const list = await sync.listRepos({ token: TOKEN }, WS)
        expect(list.repos).toHaveLength(101)
        expect(list.repos[100].repo).toBe('acme/r2-0')
        expect(calls).toHaveLength(3)
    })

    test('a token GitHub refuses is a plain message', async () => {
        const { fetchStub } = stubFetch({ 'GET /user': { status: 401, body: { message: 'Bad credentials' } } })
        sync.stop()
        sync = makeSync({ fetch: fetchStub })
        await expect(sync.listRepos({ token: TOKEN }, WS)).rejects.toMatchObject({
            status: 400,
            message: expect.stringContaining('did not accept this token')
        })
    })

    test('GitHub out of reach is a plain message', async () => {
        sync.stop()
        sync = makeSync({
            fetch: (async () => {
                throw new Error('getaddrinfo ENOTFOUND api.github.com')
            }) as unknown as typeof fetch
        })
        await expect(sync.listRepos({ token: TOKEN }, WS)).rejects.toMatchObject({
            message: expect.stringContaining('Could not reach GitHub')
        })
    })

    test('lists with a saved GitHub credential instead of a pasted token', async () => {
        credentialRows.set('cred-9', { id: 'cred-9', name: 'Team GitHub', token: TOKEN, workspaceId: WS })
        const { fetchStub, calls } = stubFetch({
            'GET /user': { status: 200, body: { login: 'acme-bot' } },
            'GET /user/repos?per_page=100&page=1&sort=pushed&affiliation=owner,collaborator,organization_member': { status: 200, body: [] }
        })
        sync.stop()
        sync = makeSync({ fetch: fetchStub })
        expect(await sync.listRepos({ credentialId: 'cred-9' }, WS)).toEqual({ account: 'acme-bot', repos: [] })
        expect(calls[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    })

    test('creates a private, empty repository', async () => {
        const { fetchStub, calls } = stubFetch({
            'POST /user/repos': { status: 201, body: { full_name: 'acme-bot/cuttlely-flows', private: true } }
        })
        sync.stop()
        sync = makeSync({ fetch: fetchStub })
        expect(await sync.createRepo({ token: TOKEN, name: 'cuttlely-flows' }, WS)).toEqual({
            repo: 'acme-bot/cuttlely-flows',
            private: true,
            empty: true,
            pushedAt: null
        })
        expect(JSON.parse(calls[0].init.body)).toMatchObject({ name: 'cuttlely-flows', private: true, auto_init: false })
    })

    test.each([
        [422, 409, 'already have a repository'],
        [403, 400, 'cannot create repositories'],
        [401, 400, 'did not accept this token']
    ])('create answered %s is %s with a plain message', async (github, status, text) => {
        const { fetchStub } = stubFetch({ 'POST /user/repos': { status: github, body: {} } })
        sync.stop()
        sync = makeSync({ fetch: fetchStub })
        await expect(sync.createRepo({ token: TOKEN, name: 'cuttlely-flows' }, WS)).rejects.toMatchObject({
            status,
            message: expect.stringContaining(text)
        })
    })

    test('a repository name is checked before GitHub is asked', async () => {
        const { fetchStub, calls } = stubFetch({})
        sync.stop()
        sync = makeSync({ fetch: fetchStub })
        await expect(sync.createRepo({ token: TOKEN, name: 'two words' }, WS)).rejects.toMatchObject({ status: 400 })
        expect(calls).toEqual([])
    })
})

describe('Dev or Prod label', () => {
    test('is saved outside the history files and shows in the status', async () => {
        await save('One')
        expect((await sync.status()).environment).toBeNull()
        expect((await sync.setEnvironment('prod')).environment).toBe('prod')
        expect((await sync.status()).environment).toBe('prod')
        expect(plainGit(versionsDir(), 'status', '--porcelain').trim()).toBe('')
        expect((await sync.setEnvironment('dev')).environment).toBe('dev')
        expect((await sync.setEnvironment(null)).environment).toBeNull()
        await expect(sync.setEnvironment('staging')).rejects.toMatchObject({ status: 400, message: 'Pick Dev or Prod.' })
    })

    test('a saved Dev or Prod label stays the old file and loads as dev then prod', async () => {
        await sync.setEnvironment('prod')
        const file = path.join(versionsDir(), '.git', 'versions-environment.json')
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ environment: 'prod' })
        expect(sync.environments()).toEqual([
            { name: 'dev', branch: 'main', server: 'dev' },
            { name: 'prod', branch: 'main', server: 'prod' }
        ])
        expect((await sync.status()).promotes).toBe(true)
    })

    test('an ordered list is saved beside the server identity', async () => {
        const chain = [
            { name: 'Dev', branch: 'main', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        const status = await sync.setEnvironment('staging', chain)
        expect(status.environment).toBe('staging')
        expect(status.environments.map((item) => item.server)).toEqual(['dev', 'staging', 'prod'])
        expect(status.promotes).toBe(true)
        expect(status.role).toBe('copy')
        const file = path.join(versionsDir(), '.git', 'versions-environment.json')
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ environment: 'staging', environments: chain })
        await expect(sync.setEnvironment('nope')).rejects.toMatchObject({ status: 400, message: 'Pick an environment from the list.' })
        expect((await sync.setEnvironment('prod')).environment).toBe('prod')
        expect((await sync.status()).role).toBe('read')
    })

    test('a truncated environment file does not publish as the Dev and Prod pair', async () => {
        const chain = [
            { name: 'Dev', branch: 'main', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        await sync.setEnvironment('staging', chain)
        await save('One')
        seedRecordedVersions('refs/heads/main', chain)
        const seededMain = bareMain(bare)
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const stagingRef = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/staging'], {
            encoding: 'utf8',
            env: cleanEnv()
        }).trim()
        const pushes = gitCalls.filter((call) => call.args[0] === 'push').length
        fs.writeFileSync(path.join(versionsDir(), '.git', 'versions-environment.json'), '{')
        await save('Two')
        await settle()
        const status = await sync.status()
        expect(status.state).toBe('stopped')
        expect(status.message).toContain('could not be read')
        expect(sync.environment()).toBeNull()
        expect(sync.environments()).toEqual([])
        expect(gitCalls.filter((call) => call.args[0] === 'push').length).toBe(pushes)
        expect(bareMain(bare)).toBe(seededMain)
        expect(
            execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/staging'], { encoding: 'utf8', env: cleanEnv() }).trim()
        ).toBe(stagingRef)
    })

    test('a stopped copy on a middle environment is not retried by the next read', async () => {
        sync.stop()
        sync = makeSync({ checkEveryMs: 40 })
        setGithubForTests(sync)
        const chain = [
            { name: 'Dev', branch: 'main', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        await sync.setEnvironment('staging', chain)
        await save('One')
        seedRecordedVersions('refs/heads/main', chain)
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const work = path.join(tmp, 'elsewhere')
        fs.mkdirSync(work)
        const env = cleanEnv({
            GIT_AUTHOR_NAME: 'someone',
            GIT_AUTHOR_EMAIL: 'someone@example.invalid',
            GIT_COMMITTER_NAME: 'someone',
            GIT_COMMITTER_EMAIL: 'someone@example.invalid'
        })
        execFileSync('git', ['clone', '-q', '-b', 'staging', `file://${bare}`, '.'], { cwd: work, env })
        fs.writeFileSync(path.join(work, 'README.md'), '# made on GitHub\n')
        execFileSync('git', ['add', 'README.md'], { cwd: work, env })
        execFileSync('git', ['commit', '-q', '-m', 'Initial commit'], { cwd: work, env })
        execFileSync('git', ['push', '-q', `file://${bare}`, 'HEAD:refs/heads/staging'], { cwd: work, env })
        await save('Two')
        await settle()
        let stopped = await sync.status()
        // status() can overlap the next poll and report copying. Wait for that copy to finish.
        for (let attempt = 0; stopped.state === 'copying' && attempt < 20; attempt += 1) {
            await sync.idle()
            stopped = await sync.status()
        }
        expect(stopped.state).toBe('stopped')
        expect(stopped.message).toContain('has changes that are not on this server')
        const pushes = gitCalls.filter((call) => call.args[0] === 'push').length
        const fetches = gitCalls.filter((call) => call.args[0] === 'fetch').length
        await new Promise((resolve) => setTimeout(resolve, 80))
        await sync.idle()
        // Stop the next poll before reading status, so the assertion does not land mid-read.
        sync.stop()
        await sync.idle()
        expect(gitCalls.filter((call) => call.args[0] === 'push').length).toBe(pushes)
        expect(gitCalls.filter((call) => call.args[0] === 'fetch').length).toBeGreaterThan(fetches)
        expect((await sync.status()).state).toBe('stopped')
        expect((await sync.status()).message).toContain('has changes that are not on this server')
        let settled = await sync.tryNow()
        // status() can overlap the next poll and report copying. Wait for that copy to finish.
        // Do not stop the timer: a tryNow that never leaves copying has to fail this assertion.
        for (let attempt = 0; settled.state === 'copying' && attempt < 20; attempt += 1) {
            await sync.idle()
            settled = await sync.status()
        }
        expect(gitCalls.filter((call) => call.args[0] === 'push').length).toBeGreaterThan(pushes)
        expect(settled.state).toBe('stopped')
        expect(settled.message).toContain('has changes that are not on this server')
    })

    test('a bad environment file stays connected and can be saved again', async () => {
        const chain = [
            { name: 'Dev', branch: 'main', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        await sync.setEnvironment('prod', chain)
        seedRecordedVersions('refs/heads/staging', chain)
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        fs.writeFileSync(path.join(versionsDir(), '.git', 'versions-environment.json'), '{')
        const status = await sync.status()
        expect(status.connected).toBe(true)
        expect(status.repo).toBe(`file://${bare}`)
        expect(status.state).toBe('stopped')
        expect(status.message).toContain('could not be read')
        const saved = await sync.setEnvironment('staging', chain)
        expect(saved.environment).toBe('staging')
        expect(saved.connected).toBe(true)
        expect(saved.state).not.toBe('stopped')
    })

    test('a list change during a credential read or a fetch does not use main', async () => {
        const chain = [
            { name: 'Dev', branch: 'dev', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        const roleFile = path.join(versionsDir(), '.git', 'versions-environment.json')
        let mode: 'off' | 'get' | 'fetch' = 'off'
        sync.stop()
        sync = makeSync({
            checkEveryMs: 60_000,
            credentials: {
                async get(id: string, workspaceId: string) {
                    if (mode === 'get') fs.writeFileSync(roleFile, '{')
                    return credentialStore.get(id, workspaceId)
                },
                create: (input) => credentialStore.create(input)
            },
            onGit: (args, env) => {
                gitCalls.push({ args, env })
                if (mode === 'fetch' && args[0] === 'fetch') fs.writeFileSync(roleFile, '{')
            }
        })
        setGithubForTests(sync)
        await sync.setEnvironment('staging', chain)
        await save('One')
        seedRecordedVersions('refs/heads/dev', chain)
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const touchesMain = (call: { args: string[] }) => call.args.some((arg) => arg.includes('refs/heads/main'))
        mode = 'get'
        const mark = gitCalls.length
        await save('Two')
        await settle()
        expect((await sync.status()).state).toBe('stopped')
        expect(gitCalls.slice(mark).some(touchesMain)).toBe(false)
        expect(gitCalls.slice(mark).some((call) => call.args[0] === 'push' || call.args[0] === 'fetch')).toBe(false)
        mode = 'off'
        await sync.setEnvironment('staging', chain)
        mode = 'fetch'
        const again = gitCalls.length
        await sync.sync()
        await sync.idle()
        const during = gitCalls.slice(again)
        expect(during.some((call) => call.args[0] === 'fetch' && call.args.some((arg) => arg.includes('refs/heads/dev')))).toBe(true)
        expect(during.some(touchesMain)).toBe(false)
        expect(during.some((call) => call.args[0] === 'push' && call.args.some((arg) => arg.includes('refs/heads/')))).toBe(false)
    })

    test('a reader stops when the publisher recorded a different environment list', async () => {
        const three = [
            { name: 'Dev', branch: 'main', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        await sync.setEnvironment('dev', three)
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(bareMain(bare)).toBeTruthy()
        await sync.disconnect()
        await sync.setEnvironment('prod', [
            { name: 'dev', branch: 'main', server: 'dev' },
            { name: 'prod', branch: 'main', server: 'prod' }
        ])
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const status = await sync.status()
        expect(status.state).toBe('stopped')
        expect(status.message).toContain('same list')
        let incoming = ''
        try {
            incoming = plainGit(versionsDir(), 'rev-parse', '--verify', '-q', 'refs/versions/incoming')
        } catch {
            incoming = ''
        }
        expect(incoming.trim()).toBe('')
    })

    test('two publishers both record the environment list, and the second publish retries into a fast-forward', async () => {
        const chain = [
            { name: 'Dev', branch: 'dev', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        const devDir = versionsDir()
        const devStore = new VersionStore(devDir)
        sync.stop()
        sync = makeSync({ store: () => devStore, checkEveryMs: 60_000, retryMs: [60_000] })
        setGithubForTests(sync)
        await sync.setEnvironment('dev', chain)
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const devHead = plainGit(devDir, 'rev-parse', 'HEAD').trim()
        expect(remoteNote(bare, devHead, path.join(tmp, 'note-dev'))).toBe(environmentListFingerprint(chain))

        const stagingDir = path.join(tmp, 'staging-versions')
        process.env.CUTTLELY_VERSIONS_DIR = stagingDir
        resetForTests()
        await save('Two')
        const stagingStore = new VersionStore(stagingDir)
        let notesPushes = 0
        const staging = makeSync({
            store: () => stagingStore,
            checkEveryMs: 60_000,
            retryMs: [60_000],
            onGit: (args, env) => {
                gitCalls.push({ args, env })
                if (args[0] === 'push' && args.some((arg) => arg.includes('refs/notes/commits'))) {
                    notesPushes += 1
                    if (notesPushes === 1) {
                        const racer = path.join(tmp, 'notes-racer')
                        fs.mkdirSync(racer, { recursive: true })
                        const envGit = noteAuthorEnv()
                        execFileSync('git', ['init', '-q'], { cwd: racer, env: envGit })
                        execFileSync('git', ['fetch', '-q', `file://${bare}`, 'refs/notes/commits:refs/notes/commits'], {
                            cwd: racer,
                            env: envGit
                        })
                        execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'racer'], { cwd: racer, env: envGit })
                        const raced = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: racer, env: envGit, encoding: 'utf8' }).trim()
                        execFileSync('git', ['notes', 'add', '-m', 'racer-note', raced], { cwd: racer, env: envGit })
                        execFileSync('git', ['push', '-q', `file://${bare}`, 'refs/notes/commits:refs/notes/commits'], {
                            cwd: racer,
                            env: envGit
                        })
                    }
                }
            }
        })
        await staging.setEnvironment('staging', chain)
        const status = await staging.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const stagingHead = plainGit(stagingDir, 'rev-parse', 'HEAD').trim()
        expect(notesPushes).toBeGreaterThan(1)
        expect(status.state).toBe('up-to-date')
        const fingerprint = environmentListFingerprint(chain)
        expect(remoteNote(bare, devHead, path.join(tmp, 'note-both-dev'))).toBe(fingerprint)
        expect(remoteNote(bare, stagingHead, path.join(tmp, 'note-both-staging'))).toBe(fingerprint)
        const notePushes = gitCalls.filter((call) => call.args[0] === 'push' && call.args.some((arg) => arg.includes('refs/notes/commits')))
        expect(notePushes.length).toBeGreaterThan(1)
        for (const call of notePushes) {
            expect(call.args).not.toContain('--force')
            expect(call.args.some((arg) => arg.startsWith('+'))).toBe(false)
        }
        staging.stop()
    })

    test('a reader stops when a notes record exists but this version has none, and does not move incoming', async () => {
        sync = makeSync({ checkEveryMs: 60_000, retryMs: [60_000] })
        setGithubForTests(sync)
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const noted = plainGit(versionsDir(), 'rev-parse', 'HEAD').trim()
        await sync.disconnect()
        await sync.setEnvironment('prod')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(refOf(versionsDir(), 'refs/versions/incoming')).toBe(noted)
        foreignCommit(bare, path.join(tmp, 'extra'), 'main')
        expect(bareMain(bare)).not.toBe(noted)
        await sync.sync()
        await sync.idle()
        const status = await sync.status()
        expect(status.state).toBe('stopped')
        expect(status.message).toContain('no environment list recorded')
        expect(refOf(versionsDir(), 'refs/versions/incoming')).toBe(noted)
    })

    test('a notes fetch that cannot reach the repository stops, then succeeds on retry', async () => {
        const hidden = path.join(tmp, 'remote-hidden.git')
        let failNotes = false
        sync.stop()
        sync = makeSync({
            checkEveryMs: 60_000,
            retryMs: [60_000],
            onGit: (args, env) => {
                gitCalls.push({ args, env })
                if (failNotes && args[0] === 'fetch' && args.some((arg) => arg.includes('refs/notes/commits'))) {
                    fs.renameSync(bare, hidden)
                    fs.mkdirSync(bare)
                }
            }
        })
        setGithubForTests(sync)
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const head = plainGit(versionsDir(), 'rev-parse', 'HEAD').trim()
        await sync.disconnect()
        await sync.setEnvironment('prod')
        failNotes = true
        const stopped = await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(stopped.state).toBe('retrying')
        expect(stopped.state).not.toBe('up-to-date')
        expect(bareRef(hidden, 'refs/heads/main')).toBe(head)
        let incoming = ''
        try {
            incoming = plainGit(versionsDir(), 'rev-parse', '--verify', '-q', 'refs/versions/incoming')
        } catch {
            incoming = ''
        }
        expect(incoming.trim()).toBe('')
        failNotes = false
        fs.rmSync(bare, { recursive: true, force: true })
        fs.renameSync(hidden, bare)
        await sync.sync()
        await sync.idle()
        const status = await sync.status()
        expect(status.state).toBe('up-to-date')
        expect(plainGit(versionsDir(), 'rev-parse', 'refs/versions/incoming').trim()).toBe(head)
    })

    test('a repository with no environment-list record still offers versions', async () => {
        foreignCommit(bare, path.join(tmp, 'published'))
        const head = bareMain(bare)
        sync = makeSync({ checkEveryMs: 60_000, retryMs: [60_000] })
        setGithubForTests(sync)
        await sync.setEnvironment('prod')
        const status = await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(bareRef(bare, 'refs/notes/commits')).toBeNull()
        expect(status.state).toBe('up-to-date')
        expect(plainGit(versionsDir(), 'rev-parse', 'refs/versions/incoming').trim()).toBe(head)
    })

    test('a stale Prod list does not take new versions once any environment list is recorded', async () => {
        const chain = [
            { name: 'Dev', branch: 'main', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        const devDir = versionsDir()
        const devStore = new VersionStore(devDir)
        sync.stop()
        sync = makeSync({ store: () => devStore, checkEveryMs: 60_000, retryMs: [60_000] })
        setGithubForTests(sync)
        await sync.setEnvironment('dev', chain)
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(bareRef(bare, 'refs/notes/commits')).toBeTruthy()
        const first = bareMain(bare)
        await save('Two')
        await settle()
        const second = bareMain(bare)
        expect(second).not.toBe(first)

        const prodDir = path.join(tmp, 'prod-versions')
        process.env.CUTTLELY_VERSIONS_DIR = prodDir
        resetForTests()
        const prodStore = new VersionStore(prodDir)
        const prod = makeSync({ store: () => prodStore, checkEveryMs: 60_000, retryMs: [60_000] })
        await prod.setEnvironment('prod', [
            { name: 'dev', branch: 'main', server: 'dev' },
            { name: 'prod', branch: 'main', server: 'prod' }
        ])
        const status = await prod.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(status.state).toBe('stopped')
        expect(status.message).toContain('same list')
        expect(refOf(prodDir, 'refs/versions/incoming')).toBeNull()
        process.env.CUTTLELY_VERSIONS_DIR = devDir
        await save('Three')
        await sync.sync()
        await sync.idle()
        expect(bareMain(bare)).not.toBe(second)
        await prod.sync()
        await prod.idle()
        expect((await prod.status()).state).toBe('stopped')
        expect(refOf(prodDir, 'refs/versions/incoming')).toBeNull()
        prod.stop()
    })

    test('a failed environment-list publish leaves the copy not up to date', async () => {
        const hook = path.join(bare, 'hooks', 'update')
        fs.mkdirSync(path.dirname(hook), { recursive: true })
        fs.writeFileSync(hook, '#!/bin/sh\nif [ "$1" = "refs/notes/commits" ]; then\n  echo "notes refused" >&2\n  exit 1\nfi\nexit 0\n', {
            mode: 0o755
        })
        sync = makeSync({ checkEveryMs: 60_000, retryMs: [60_000] })
        setGithubForTests(sync)
        await save('One')
        const status = await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(bareMain(bare)).toBe(plainGit(versionsDir(), 'rev-parse', 'HEAD').trim())
        expect(bareRef(bare, 'refs/notes/commits')).toBeNull()
        expect(status.state).not.toBe('up-to-date')
        expect(status.message).toContain('environment list')
        const notePushes = gitCalls.filter((call) => call.args[0] === 'push' && call.args.some((arg) => arg.includes('refs/notes/commits')))
        expect(notePushes.length).toBeGreaterThan(1)
    })

    test('adding Staging while connected rewrites the fingerprint so Staging can promote that version', async () => {
        const chain = [
            { name: 'Dev', branch: 'main', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        sync = makeSync({ checkEveryMs: 60_000, retryMs: [60_000] })
        setGithubForTests(sync)
        await sync.setEnvironment('dev')
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const head = plainGit(versionsDir(), 'rev-parse', 'HEAD').trim()
        const before = remoteNote(bare, head, path.join(tmp, 'note-before'))
        expect(before).not.toBe(environmentListFingerprint(chain))
        const saved = await sync.setEnvironment('dev', chain)
        expect(plainGit(versionsDir(), 'rev-parse', 'HEAD').trim()).toBe(head)
        expect(saved.state).toBe('up-to-date')
        expect(remoteNote(bare, head, path.join(tmp, 'note-after'))).toBe(environmentListFingerprint(chain))

        const stagingDir = path.join(tmp, 'staging-versions')
        process.env.CUTTLELY_VERSIONS_DIR = stagingDir
        resetForTests()
        const staging = makeSync({
            store: () => new VersionStore(stagingDir),
            checkEveryMs: 60_000,
            retryMs: [60_000]
        })
        await staging.setEnvironment('staging', chain)
        const read = await staging.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(read.state).toBe('up-to-date')
        expect(refOf(stagingDir, 'refs/versions/incoming')).toBe(head)
        staging.stop()
    })

    test('the next sync restores an environment list record that was removed', async () => {
        sync = makeSync({ checkEveryMs: 60_000, retryMs: [60_000] })
        setGithubForTests(sync)
        await sync.setEnvironment('dev')
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const head = plainGit(versionsDir(), 'rev-parse', 'HEAD').trim()
        const fingerprint = remoteNote(bare, head, path.join(tmp, 'note-kept'))
        execFileSync('git', ['--git-dir', bare, 'update-ref', '-d', 'refs/notes/commits'], { env: cleanEnv() })
        expect(bareRef(bare, 'refs/notes/commits')).toBeNull()
        await sync.sync()
        await sync.idle()
        const status = await sync.status()
        expect(status.state).toBe('up-to-date')
        expect(remoteNote(bare, head, path.join(tmp, 'note-restored'))).toBe(fingerprint)
    })

    test('repairing an unreadable list drops versions from the old source and clears the stopped message', async () => {
        const chain = [
            { name: 'Dev', branch: 'main', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        sync = makeSync({ checkEveryMs: 60_000, retryMs: [60_000] })
        setGithubForTests(sync)
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const head = plainGit(versionsDir(), 'rev-parse', 'HEAD').trim()
        await sync.disconnect()
        await sync.setEnvironment('prod')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(refOf(versionsDir(), 'refs/versions/incoming')).toBe(head)
        const role = path.join(versionsDir(), '.git', 'versions-environment.json')
        fs.writeFileSync(role, '{')
        const broken = await sync.status()
        expect(broken.state).toBe('stopped')
        expect(broken.code).toBe('LIST_UNREADABLE')
        expect(broken.environments).toEqual([])
        expect(broken.message).toBe('The environment list could not be read. Save it again.')
        const repaired = await sync.setEnvironment('prod', chain)
        expect(refOf(versionsDir(), 'refs/versions/incoming')).toBeNull()
        expect(repaired.message).not.toContain('could not be read')
        expect(repaired.state).not.toBe('stopped')
    })

    test('repairing an unreadable list back to the same source clears the card and reads again', async () => {
        sync = makeSync({ checkEveryMs: 60_000, retryMs: [60_000] })
        setGithubForTests(sync)
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const head = plainGit(versionsDir(), 'rev-parse', 'HEAD').trim()
        await sync.disconnect()
        await sync.setEnvironment('prod')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(refOf(versionsDir(), 'refs/versions/incoming')).toBe(head)
        fs.writeFileSync(path.join(versionsDir(), '.git', 'versions-environment.json'), '{')
        expect((await sync.status()).message).toContain('could not be read')
        const repaired = await sync.setEnvironment('prod', [
            { name: 'dev', branch: 'main', server: 'dev' },
            { name: 'prod', branch: 'main', server: 'prod' }
        ])
        expect(repaired.message).not.toContain('could not be read')
        expect(repaired.state).toBe('up-to-date')
        expect(refOf(versionsDir(), 'refs/versions/incoming')).toBe(head)
    })

    test('the Prod repair body restores the saved pair and does not copy to main', async () => {
        const body = {
            environment: 'prod',
            environments: [
                { name: 'dev', branch: 'main', server: 'dev' },
                { name: 'prod', branch: 'main', server: 'prod' }
            ]
        }
        sync = makeSync({ checkEveryMs: 60_000, retryMs: [60_000] })
        setGithubForTests(sync)
        await save('One')
        await sync.setEnvironment('prod')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(bareMain(bare)).toBeNull()
        const role = path.join(versionsDir(), '.git', 'versions-environment.json')
        fs.writeFileSync(role, '{')
        expect((await sync.status()).message).toContain('could not be read')
        const pushes = gitCalls.filter((call) => call.args[0] === 'push' && call.args.some((arg) => arg.includes('refs/heads/main'))).length
        const repaired = await sync.setEnvironment(body.environment, body.environments)
        expect(repaired.environment).toBe('prod')
        expect(repaired.role).toBe('read')
        expect(repaired.message).not.toContain('could not be read')
        expect(JSON.parse(fs.readFileSync(role, 'utf8'))).toEqual({ environment: 'prod' })
        expect(bareMain(bare)).toBeNull()
        expect(gitCalls.filter((call) => call.args[0] === 'push' && call.args.some((arg) => arg.includes('refs/heads/main'))).length).toBe(
            pushes
        )
    })

    test('a corrupt connection keeps a valid list and a saved-pair save does not replace it', async () => {
        const chain = [
            { name: 'Dev', branch: 'main', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        sync = makeSync({ checkEveryMs: 60_000, retryMs: [60_000] })
        setGithubForTests(sync)
        await sync.setEnvironment('dev', chain)
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const role = path.join(versionsDir(), '.git', 'versions-environment.json')
        const savedList = fs.readFileSync(role, 'utf8')
        fs.writeFileSync(path.join(versionsDir(), '.git', 'versions-github.json'), '{')
        const status = await sync.status()
        expect(status.code).toBe('CONNECTION_UNREADABLE')
        expect(status.message).toBe('The saved GitHub connection could not be read. Disconnect and connect again.')
        expect(status.environments).toEqual(chain)
        expect(status.environment).toBe('dev')
        await expect(
            sync.setEnvironment('dev', [
                { name: 'dev', branch: 'main', server: 'dev' },
                { name: 'prod', branch: 'main', server: 'prod' }
            ])
        ).rejects.toMatchObject({
            status: 409,
            message: 'The environment list on this server is still valid, so it was not replaced.'
        })
        expect(fs.readFileSync(role, 'utf8')).toBe(savedList)
        expect((await sync.status()).environments).toEqual(chain)
    })

    test('an environment-only save does not repair an unreadable list or publish a note', async () => {
        const chain = [
            { name: 'Dev', branch: 'main', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        sync = makeSync({ checkEveryMs: 60_000, retryMs: [60_000] })
        setGithubForTests(sync)
        await sync.setEnvironment('dev', chain)
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        const head = plainGit(versionsDir(), 'rev-parse', 'HEAD').trim()
        const fingerprint = remoteNote(bare, head, path.join(tmp, 'note-named'))
        const role = path.join(versionsDir(), '.git', 'versions-environment.json')
        fs.writeFileSync(role, '{')
        const broken = fs.readFileSync(role, 'utf8')
        const calls = gitCalls.length
        await expect(sync.setEnvironment('dev')).rejects.toMatchObject({
            status: 409,
            message: 'The environment list could not be read. Save it again.'
        })
        await expect(sync.setEnvironment(null)).rejects.toMatchObject({
            status: 409,
            message: 'The environment list could not be read. Save it again.'
        })
        expect(fs.readFileSync(role, 'utf8')).toBe(broken)
        expect(gitCalls.length).toBe(calls)
        expect(remoteNote(bare, head, path.join(tmp, 'note-still-named'))).toBe(fingerprint)
        const status = await sync.status()
        expect(status.state).toBe('stopped')
        expect(status.message).toContain('could not be read')
    })

    test('a named list with no environment is not waiting and cannot connect', async () => {
        const chain = [
            { name: 'Dev', branch: 'main', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        await save('One')
        const chosen = await sync.setEnvironment(null, chain)
        expect(chosen.environment).toBeNull()
        expect(chosen.waiting).toBeNull()
        expect(chosen.state).toBe('stopped')
        expect(chosen.message).toContain("Pick this server's environment")
        expect(chosen.message).not.toContain('waiting to be copied')
        await expect(sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)).rejects.toMatchObject({
            status: 409,
            message: expect.stringContaining("Pick this server's environment")
        })
        expect(fs.existsSync(path.join(versionsDir(), '.git', 'versions-github.json'))).toBe(false)

        await sync.setEnvironment('dev', chain)
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        fs.writeFileSync(path.join(versionsDir(), '.git', 'versions-environment.json'), JSON.stringify({ environments: chain }) + '\n')
        const stuck = await sync.status()
        expect(stuck.connected).toBe(true)
        expect(stuck.waiting).toBeNull()
        expect(stuck.state).toBe('stopped')
        expect(stuck.message).toContain("Pick this server's environment")
        expect(stuck.message).not.toContain('waiting to be copied')
    })

    test('a server that reads cannot connect until the previous environment has versions there', async () => {
        const chain = [
            { name: 'Dev', branch: 'main', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        const saved = path.join(versionsDir(), '.git', 'versions-github.json')
        sync = makeSync({ checkEveryMs: 60_000, retryMs: [60_000] })
        setGithubForTests(sync)
        await sync.setEnvironment('staging', chain)
        await save('One')
        await expect(sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)).rejects.toMatchObject({
            status: 400,
            message: 'Connect the repository your Dev server copies to. This one has no versions from Dev yet.'
        })
        expect(fs.existsSync(saved)).toBe(false)

        await sync.setEnvironment('dev', chain)
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        await sync.disconnect()
        await sync.setEnvironment('prod', chain)
        await expect(sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)).rejects.toMatchObject({
            status: 400,
            message: 'Connect the repository your Staging server copies to. This one has no versions from Staging yet.'
        })
        expect(fs.existsSync(saved)).toBe(false)

        await sync.setEnvironment('staging', chain)
        const status = await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(status.connected).toBe(true)
        expect(status.state).not.toBe('stopped')
    })

    test('a README on main is not versions from the previous environment', async () => {
        const chain = [
            { name: 'Dev', branch: 'main', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        foreignCommit(bare, path.join(tmp, 'readme'))
        const readme = bareMain(bare)
        const saved = path.join(versionsDir(), '.git', 'versions-github.json')
        sync = makeSync({ checkEveryMs: 60_000, retryMs: [60_000] })
        setGithubForTests(sync)
        await sync.setEnvironment('staging', chain)
        await save('One')
        const calls = gitCalls.length
        await expect(sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)).rejects.toMatchObject({
            status: 400,
            message: 'Connect the repository your Dev server copies to. This one has no versions from Dev yet.'
        })
        expect(fs.existsSync(saved)).toBe(false)
        expect(gitCalls.slice(calls).some((call) => call.args[0] === 'push')).toBe(false)
        expect(bareRef(bare, 'refs/heads/staging')).toBeNull()
        expect(bareRef(bare, 'refs/notes/commits')).toBeNull()
        expect(bareMain(bare)).toBe(readme)

        const empty = makeBare(path.join(tmp, 'empty.git'))
        await sync.setEnvironment('dev', chain)
        const status = await sync.connect({ repo: `file://${empty}`, token: TOKEN }, WS)
        expect(status.connected).toBe(true)
        expect(bareMain(empty)).toBe(plainGit(versionsDir(), 'rev-parse', 'HEAD').trim())
        expect(bareRef(bare, 'refs/heads/staging')).toBeNull()
        expect(bareRef(bare, 'refs/notes/commits')).toBeNull()
    })

    test('selecting Staging while Dev is connecting does not save that list or copy there', async () => {
        const chain = [
            { name: 'Dev', branch: 'main', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        let switching: Promise<unknown> | null = null
        sync = makeSync({
            checkEveryMs: 60_000,
            retryMs: [60_000],
            onGit: (args, env) => {
                gitCalls.push({ args, env })
                if (args[0] === 'ls-remote' && !switching) switching = sync.setEnvironment('staging', chain)
            }
        })
        setGithubForTests(sync)
        await sync.setEnvironment('dev', chain)
        await save('One')
        const status = await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(switching).toBeTruthy()
        await expect(switching).rejects.toMatchObject({
            status: 409,
            message: 'Disconnect GitHub before changing what this server reads or copies.'
        })
        expect(status.connected).toBe(true)
        expect(status.environment).toBe('dev')
        expect(bareRef(bare, 'refs/heads/staging')).toBeNull()
        expect(bareMain(bare)).toBe(plainGit(versionsDir(), 'rev-parse', 'HEAD').trim())
        const role = JSON.parse(fs.readFileSync(path.join(versionsDir(), '.git', 'versions-environment.json'), 'utf8'))
        expect(role.environment).toBe('dev')
    })

    test('deleting the recorded list between the listing and the fetch saves nothing', async () => {
        const chain = [
            { name: 'Dev', branch: 'main', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        const saved = path.join(versionsDir(), '.git', 'versions-github.json')
        sync = makeSync({ checkEveryMs: 60_000, retryMs: [60_000] })
        setGithubForTests(sync)
        await sync.setEnvironment('dev', chain)
        await save('One')
        await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        await sync.disconnect()
        await sync.setEnvironment('staging', chain)
        let listed = false
        const deps = (sync as unknown as { deps: { onGit?: (args: string[], env: Record<string, string>) => void } }).deps
        deps.onGit = (args, env) => {
            gitCalls.push({ args, env })
            if (args[0] === 'ls-remote') listed = true
            else if (listed && args[0] === 'fetch') {
                listed = false
                execFileSync('git', ['--git-dir', bare, 'update-ref', '-d', 'refs/notes/commits'], { env: cleanEnv() })
            }
        }
        await expect(sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)).rejects.toMatchObject({
            status: 400,
            message: 'Connect the repository your Dev server copies to. This one has no versions from Dev yet.'
        })
        expect(fs.existsSync(saved)).toBe(false)
        expect(bareRef(bare, 'refs/heads/staging')).toBeNull()
    })

    test('a note on another commit, or a different list on the tip, is refused', async () => {
        const chain = [
            { name: 'Dev', branch: 'main', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        const saved = path.join(versionsDir(), '.git', 'versions-github.json')
        foreignCommit(bare, path.join(tmp, 'readme-tip'))
        const work = path.join(tmp, 'other-note')
        fs.mkdirSync(work)
        const env = noteAuthorEnv()
        execFileSync('git', ['init', '-q'], { cwd: work, env })
        execFileSync('git', ['fetch', '-q', `file://${bare}`, 'refs/heads/main:refs/heads/main'], { cwd: work, env })
        execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'other'], { cwd: work, env })
        const other = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, env, encoding: 'utf8' }).trim()
        execFileSync('git', ['notes', 'add', '-m', environmentListFingerprint(chain), other], { cwd: work, env })
        execFileSync('git', ['push', '-q', `file://${bare}`, 'HEAD:refs/heads/other', 'refs/notes/commits:refs/notes/commits'], {
            cwd: work,
            env
        })
        sync = makeSync({ checkEveryMs: 60_000, retryMs: [60_000] })
        setGithubForTests(sync)
        await sync.setEnvironment('staging', chain)
        await save('One')
        await expect(sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)).rejects.toMatchObject({
            status: 400,
            message: 'Connect the repository your Dev server copies to. This one has no versions from Dev yet.'
        })
        expect(fs.existsSync(saved)).toBe(false)
        expect(bareRef(bare, 'refs/heads/staging')).toBeNull()

        execFileSync('git', ['notes', 'add', '-f', '-m', 'not-this-list', bareMain(bare) as string], { cwd: work, env })
        execFileSync('git', ['push', '-q', `file://${bare}`, 'refs/notes/commits:refs/notes/commits'], { cwd: work, env })
        await expect(sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)).rejects.toMatchObject({
            status: 400,
            message: 'Connect the repository your Dev server copies to. This one has no versions from Dev yet.'
        })
        expect(fs.existsSync(saved)).toBe(false)
        expect(bareRef(bare, 'refs/heads/staging')).toBeNull()
    })

    test('a newer tip with a matching note is installed and a middle environment copies on that pass', async () => {
        const chain = [
            { name: 'Dev', branch: 'main', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        const fingerprint = environmentListFingerprint(chain)
        sync = makeSync({ checkEveryMs: 60_000, retryMs: [60_000] })
        setGithubForTests(sync)
        await sync.setEnvironment('staging', chain)
        await save('One')
        seedRecordedVersions('refs/heads/main', chain)
        const listed = bareMain(bare)
        let fetches = 0
        let newer = ''
        sync.stop()
        sync = makeSync({
            checkEveryMs: 60_000,
            retryMs: [60_000],
            onGit: (args, env) => {
                gitCalls.push({ args, env })
                if (args[0] !== 'fetch') return
                fetches += 1
                if (fetches === 2) newer = advancePrevious('refs/heads/main', fingerprint)
            }
        })
        setGithubForTests(sync)
        const status = await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(newer).not.toBe('')
        expect(newer).not.toBe(listed)
        expect(status.state).not.toBe('stopped')
        expect(refOf(versionsDir(), 'refs/versions/incoming')).toBe(newer)
        expect(bareRef(bare, 'refs/heads/staging')).toBe(plainGit(versionsDir(), 'rev-parse', 'HEAD').trim())
    })

    test.each([
        ['mismatched', 'mismatch'],
        ['missing', 'absent']
    ] as const)('a newer tip with a %s note is not installed and is not copied', async (_label, mode) => {
        const chain = [
            { name: 'Dev', branch: 'main', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        sync = makeSync({ checkEveryMs: 60_000, retryMs: [60_000] })
        setGithubForTests(sync)
        await sync.setEnvironment('staging', chain)
        await save('One')
        seedRecordedVersions('refs/heads/main', chain)
        const listed = bareMain(bare)
        let fetches = 0
        let newer = ''
        sync.stop()
        sync = makeSync({
            checkEveryMs: 60_000,
            retryMs: [60_000],
            onGit: (args, env) => {
                gitCalls.push({ args, env })
                if (args[0] !== 'fetch') return
                fetches += 1
                if (fetches === 2) newer = advancePrevious('refs/heads/main', mode === 'mismatch' ? 'not-this-list' : null)
                if (mode === 'absent' && fetches === 3) {
                    execFileSync('git', ['--git-dir', bare, 'update-ref', '-d', 'refs/notes/commits'], { env: cleanEnv() })
                }
            }
        })
        setGithubForTests(sync)
        const status = await sync.connect({ repo: `file://${bare}`, token: TOKEN }, WS)
        expect(newer).not.toBe(listed)
        expect(status.state).toBe('stopped')
        expect(refOf(versionsDir(), 'refs/versions/incoming')).toBeNull()
        expect(bareRef(bare, 'refs/heads/staging')).toBeNull()
    })
})

describe('local stand-in for GitHub (end-to-end runs without an account)', () => {
    test('owner/name maps to a bare repository under CUTTLELY_GITHUB_TEST_ROOT and copying works', async () => {
        const root = path.join(tmp, 'gh')
        process.env.CUTTLELY_GITHUB_TEST_ROOT = root
        const standIn = makeBare(path.join(root, 'acme', 'flows.git'))
        expect(parseRepo('acme/flows')).toEqual({ repo: 'acme/flows', url: `file://${path.join(root, 'acme', 'flows.git')}` })
        await save('One')
        const status = await sync.connect({ repo: 'acme/flows', token: TOKEN }, WS)
        expect(bareMain(standIn)).toBe(plainGit(versionsDir(), 'rev-parse', 'refs/heads/main').trim())
        expect(status).toMatchObject({ repo: 'acme/flows', url: 'https://github.com/acme/flows', state: 'up-to-date' })
        expectTokenNowhere()
    })

    test('turning the stand-in off later stops copying instead of sending it to github.com', async () => {
        const root = path.join(tmp, 'gh')
        process.env.CUTTLELY_GITHUB_TEST_ROOT = root
        makeBare(path.join(root, 'acme', 'flows.git'))
        await save('One')
        await sync.connect({ repo: 'acme/flows', token: TOKEN }, WS)
        delete process.env.CUTTLELY_GITHUB_TEST_ROOT
        const before = gitCalls.length
        await save('Two')
        await settle()
        const status = await sync.status()
        expect(status.state).toBe('stopped')
        expect(status.message).toContain('Disconnect and connect again')
        expect(gitCalls.slice(before).some((call) => call.args.join(' ').includes('github.com'))).toBe(false)
    })

    test('ignored unless file remotes are allowed, and only for an absolute folder', () => {
        process.env.CUTTLELY_GITHUB_TEST_ROOT = path.join(tmp, 'gh')
        delete process.env.CUTTLELY_GITHUB_ALLOW_FILE_REMOTES
        expect(parseRepo('acme/flows').url).toBe('https://github.com/acme/flows.git')
        process.env.CUTTLELY_GITHUB_ALLOW_FILE_REMOTES = 'on'
        process.env.CUTTLELY_GITHUB_TEST_ROOT = 'relative/gh'
        expect(parseRepo('acme/flows').url).toBe('https://github.com/acme/flows.git')
    })

    test('CUTTLELY_GITHUB_TEST_API replaces api.github.com only with the stand-in on', async () => {
        const urls: string[] = []
        const fetchStub = (async (url: string) => {
            urls.push(String(url))
            return { status: 401, json: async () => ({ message: 'Bad credentials' }) } as any
        }) as unknown as typeof fetch
        sync.stop()
        sync = makeSync({ fetch: fetchStub })
        process.env.CUTTLELY_GITHUB_TEST_API = 'http://127.0.0.1:9/'
        await expect(sync.listRepos({ token: TOKEN }, WS)).rejects.toMatchObject({ status: 400 })
        expect(urls[0]).toBe('https://api.github.com/user')
        process.env.CUTTLELY_GITHUB_TEST_ROOT = path.join(tmp, 'gh')
        await expect(sync.listRepos({ token: TOKEN }, WS)).rejects.toMatchObject({ status: 400 })
        expect(urls[1]).toBe('http://127.0.0.1:9/user')
    })
})
