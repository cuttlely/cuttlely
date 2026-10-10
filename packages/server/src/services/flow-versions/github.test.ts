import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

jest.mock('../../utils/logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))

import logger from '../../utils/logger'
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
import { gitEnv, runGit } from './store'
import { GIT_WORDS, gitWordsIn, messagesInSource } from '../../utils/plainWords'

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

function bareLog(bare: string): string {
    return execFileSync('git', ['--git-dir', bare, 'log', '-p', '--all'], { encoding: 'utf8', env: cleanEnv() })
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
        log: (message) => (logger as any).warn(message),
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
    resetForTests()
    gitCalls = []
    credentialRows = new Map()
    bare = makeBare(path.join(tmp, 'remote.git'))
    sync = makeSync()
    setGithubForTests(sync)
    ;(logger.warn as jest.Mock).mockClear()
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
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain(TOKEN)
}

describe('repository and token input', () => {
    test.each([
        ['acme/flows', 'acme/flows'],
        [' acme/flows.git ', 'acme/flows'],
        ['https://github.com/acme/flows', 'acme/flows'],
        ['https://github.com/acme/flows.git/', 'acme/flows'],
        ['https://www.github.com/Acme-Co/my.flows_1', 'Acme-Co/my.flows_1']
    ])('%s is %s on github.com', (input, repo) => {
        expect(parseRepo(input)).toEqual({ repo, url: `https://github.com/${repo}.git` })
    })

    test.each([
        '',
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
        expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain(TOKEN)
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
        await expect(sync.createRepo({ token: TOKEN, name: 'cuttlely-flows' }, WS)).rejects.toMatchObject({ status: 409 })
        expect(calls.length).toBe(before)
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

describe('plain words on screen', () => {
    // Every message the GitHub card can show: no Git words such as main, branch, commit or push.
    // The scanner and its own tests are in utils/plainWords.
    const messagesIn = (file: string) => messagesInSource(fs.readFileSync(file, 'utf8'))

    test('every message in github.ts uses no Git words', () => {
        const file = path.join(__dirname, 'github.ts')
        expect(messagesIn(file).length).toBeGreaterThan(40)
        expect(gitWordsIn(fs.readFileSync(file, 'utf8'))).toEqual([])
    })

    test('the scan sees messages built in local variables and ternaries', () => {
        const messages = messagesIn(path.join(__dirname, 'github.ts'))
        expect(messages).toContain('Up to date. Every version on this server is on GitHub.')
        expect(messages).toContain('Copying to GitHub now.')
        expect(messages.some((text) => text.startsWith('Could not reach GitHub to check X.'))).toBe(true)
    })

    test.each([
        'remote: error: GH006: Protected branch update failed',
        ' ! [rejected]        main -> main (fetch first)',
        'fatal: Authentication failed',
        'fatal: unable to access: Could not resolve host: github.com',
        'something new'
    ])('the message for %j uses no Git words', (stderr) => {
        expect(GIT_WORDS.test(classifyFailure(stderr, 'acme/flows').message)).toBe(false)
    })
})
