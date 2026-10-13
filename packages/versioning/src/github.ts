// Optional copy of version history to a GitHub repository.
//
// History stays a local Git repo. When an owner connects a repository in Settings, every new
// version is copied to that repository's main branch in the background. Copying never blocks or fails a save, a Publish or a Roll back:
// it runs after the version is committed, one copy at a time, and retries on its own when GitHub
// cannot be reached.
//
// Safety rules:
// - The token is a normal Cuttlely credential (Github API) in the owner's workspace, so it is
//   encrypted like every credential and can be changed on the Credentials page. The connection file,
//   inside the repo's .git folder (never committed), holds only the credential's id and name.
//   The token is never logged or returned.
// - Flow credentials are never copied: versions hold each credential's name and type only, so
//   another server maps them by name to its own Credentials.
// - The token reaches git only through the child's environment, as an HTTP header scoped to the
//   repository URL. It is never on a command line, in a remote URL, or in the repo config.
// - No force push, ever. If GitHub's main has commits this server does not have, copying stops
//   and says so.
// - Before each copy, the commits being copied are checked for secret-shaped text again.
import { execFile, spawn } from 'child_process'
import readline from 'readline'
import fs from 'fs'
import path from 'path'
import {
    isLegacyChain,
    legacyEnvironments,
    parseEnvironmentFile,
    parseEnvironmentsAllowingLegacy,
    syncPlan,
    environmentListFingerprint,
    sourceTitle,
    type EnvironmentConfig,
    type NamedEnvironment,
    type SyncPlan
} from './environments'
import { gitEnv, runGit, VersionStore } from './store'
import { scanForSecrets } from './secrets'

export type ServerRole = 'dev' | 'prod' | null
export type { NamedEnvironment }

export type GithubState = 'off' | 'not-connected' | 'up-to-date' | 'waiting' | 'copying' | 'retrying' | 'stopped'

// LIST_UNREADABLE is the environment file. CONNECTION_UNREADABLE is the connection file.
export type GithubStatusCode = 'LIST_UNREADABLE' | 'CONNECTION_UNREADABLE' | null

export interface GithubStatus {
    // History is on. With history off there is nothing to copy.
    enabled: boolean
    connected: boolean
    // The Github API credential that holds the token. Never the token itself.
    credential: { id: string; name: string } | null
    repo: string | null
    url: string | null
    state: GithubState
    // One plain sentence for the screen. Never holds the token or raw git output.
    message: string
    // Which failure `message` is, when two sentences both say something could not be read. Null otherwise.
    code: GithubStatusCode
    // Versions saved on this server that are not on GitHub yet. Null when not known.
    waiting: number | null
    lastCopiedAt: string | null
    lastCopiedVersion: string | null
    nextTryAt: string | null
    connectedAt: string | null
    // Which environment this server is: a server identity from `environments`, or null.
    environment: string | null
    // Promotion order. A saved Dev or Prod label with no list is dev, then prod.
    environments: NamedEnvironment[]
    // This server promotes versions from the previous environment.
    promotes: boolean
    // What this server does with the repository. copy: its published versions are copied there (the first
    // environment, a middle one, or no label). read: it only reads new versions from the previous one (the last).
    role: 'copy' | 'read'
    // Prod: when it last read the repository, and the newest version it found there. Null on Dev.
    lastCheckedAt: string | null
    incomingVersion: string | null
}

// A repository the token can write to, for the picker.
export interface GithubRepoChoice {
    repo: string
    private: boolean
    // GitHub reports no content yet. Only an empty repository, or one this server copied to, can be connected.
    empty: boolean
    pushedAt: string | null
}

export interface GithubRepoList {
    account: string
    repos: GithubRepoChoice[]
}

export class GithubError extends Error {
    readonly status: number
    constructor(status: number, message: string) {
        super(message)
        this.status = status
    }
}

interface SavedConfig {
    version: 1
    repo: string
    // A Github API credential in this workspace. The token stays in Credentials.
    credential: { id: string; name: string; workspaceId: string }
    connectedAt: string
    // The address copies go to, as resolved when connecting. If the settings now resolve the repository
    // somewhere else (the test stand-in was turned on or off), copying stops instead of retargeting.
    remote?: string
}

interface ActiveConfig {
    repo: string
    url: string
    token: string
    credential: { id: string; name: string; workspaceId: string }
    connectedAt: string | null
}

export interface GithubCredentialStore {
    get(id: string, workspaceId: string): Promise<{ id: string; name: string; token: string } | null>
    create(input: { name: string; token: string; workspaceId: string }): Promise<{ id: string; name: string }>
}

export interface GithubDeps {
    store: () => VersionStore
    enabled: () => boolean
    // Github API credentials in Credentials. get answers null for any other id, type or workspace.
    credentials: GithubCredentialStore
    log?: (message: string) => void
    now?: () => number
    // Wait after a new version before copying, so a burst of saves is one copy.
    debounceMs?: number
    // Waits between failed tries, in order. The last one repeats.
    retryMs?: number[]
    // Test hook: sees every git argument list, so a test can prove the token is never on one.
    onGit?: (args: string[], env: Record<string, string>) => void
    // The GitHub REST API. Tests pass a stub, so no test talks to GitHub.
    fetch?: typeof fetch
    // Prod: how often to look for new versions from Dev.
    checkEveryMs?: number
}

// The Github API credential type that already exists in Credentials.
export const GITHUB_CREDENTIAL = 'githubApi'
const CONFIG_FILE = 'versions-github.json'
const ROLE_FILE = 'versions-environment.json'
const API = 'https://api.github.com'
const API_TIMEOUT_MS = 15_000
// The picker reads at most this many pages of 100 repositories.
const REPO_PAGES = 10
const PUSHED_REF = 'refs/versions/github'
// Prod: the newest versions read from Dev through the repository. Local main and the work tree are never touched.
export const INCOMING_REF = 'refs/versions/incoming'
// Each read lands here first and moves to INCOMING_REF only if the connection is still the same one.
const INCOMING_NEXT_REF = 'refs/versions/incoming-next'
// The publisher's environment list, as a note on the copied commit. Not a force-push of history.
const ENVIRONMENT_NOTE_REMOTE = 'refs/notes/commits'
const ENVIRONMENT_NOTE_LOCAL = 'refs/notes/environment-list'
const LIST_MISMATCH =
    "This server's environment list does not match the list used to publish these versions. Save the same list on every server, then select Try again."
const LIST_UNREADABLE = 'The environment list could not be read. Save it again.'
const CONNECTION_UNREADABLE = 'The saved GitHub connection could not be read. Disconnect and connect again.'
const LIST_STILL_VALID = 'The environment list on this server is still valid, so it was not replaced.'

const statusCode = (message: string): GithubStatusCode =>
    message === LIST_UNREADABLE ? 'LIST_UNREADABLE' : message === CONNECTION_UNREADABLE ? 'CONNECTION_UNREADABLE' : null
const LIST_UNVERIFIED = 'These versions have no environment list recorded yet, so nothing new is offered.'
const LIST_NOTE_FAILED = 'Could not record the environment list with this copy.'
const PICK_ENVIRONMENT = "Pick this server's environment. Nothing is copied until you do."
// A second publisher can land its note between our fetch and our push. Retry that race a few times, then stop.
const NOTE_PUSH_ATTEMPTS = 4
const NOTE_REMOTE_CACHE = 'refs/notes/remote-list'
// The previous environment's tip, fetched while connecting. It is not offered until the note on it matches.
const CONNECT_SOURCE_REF = 'refs/versions/connect-source'

interface ActivePlan extends SyncPlan {
    invalid: boolean
    environments: NamedEnvironment[]
    environment: string | null
    // Set only for the connect-time copy: the source tip whose note already matched this list.
    verifiedSource: string | null
}

const NOTE_ENV = {
    GIT_AUTHOR_NAME: 'Cuttlely',
    GIT_AUTHOR_EMAIL: 'system@versions.local',
    GIT_COMMITTER_NAME: 'Cuttlely',
    GIT_COMMITTER_EMAIL: 'system@versions.local'
}
const DEFAULT_CHECK_EVERY_MS = 120_000
const DEFAULT_RETRY_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 900_000]
const NETWORK_TIMEOUT_MS = 60_000
const CHECK_TIMEOUT_MS = 20_000

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const NAME = /^[A-Za-z0-9._-]{1,100}$/

function isOn(value: string | undefined): boolean {
    return ['on', 'true', '1', 'yes'].includes(
        String(value ?? '')
            .trim()
            .toLowerCase()
    )
}

// Test stand-in for GitHub, for end-to-end runs without an account: with CUTTLELY_GITHUB_TEST_ROOT set
// (and CUTTLELY_GITHUB_ALLOW_FILE_REMOTES=on), owner/name is the bare repository <root>/owner/name.git,
// and CUTTLELY_GITHUB_TEST_API replaces https://api.github.com. Never set on a real server.
function testRoot(): string | null {
    const root = String(process.env.CUTTLELY_GITHUB_TEST_ROOT || '').trim()
    return root && isOn(process.env.CUTTLELY_GITHUB_ALLOW_FILE_REMOTES) && path.isAbsolute(root) ? root : null
}

function apiBase(): string {
    const test = String(process.env.CUTTLELY_GITHUB_TEST_API || '').trim()
    return test && testRoot() ? test.replace(/\/+$/, '') : API
}

function trimTrailingSlashes(value: string): string {
    let end = value.length
    while (end > 0 && value[end - 1] === '/') end--
    return end === value.length ? value : value.slice(0, end)
}

function withoutGitSuffix(value: string): string {
    if (value.length < 4 || value[value.length - 4] !== '.') return value
    const suffix = value.slice(value.length - 3)
    if (suffix[0] !== 'g' && suffix[0] !== 'G') return value
    if (suffix[1] !== 'i' && suffix[1] !== 'I') return value
    if (suffix[2] !== 't' && suffix[2] !== 'T') return value
    return value.slice(0, -4)
}

function isLineEnd(ch: string): boolean {
    return ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029'
}

// The whitespace set a JavaScript regular expression uses for \s, one character at a time.
function isJsWhitespace(ch: string): boolean {
    const c = ch.charCodeAt(0)
    return (
        c === 0x20 ||
        c === 0x09 ||
        c === 0x0a ||
        c === 0x0b ||
        c === 0x0c ||
        c === 0x0d ||
        c === 0x00a0 ||
        c === 0x1680 ||
        (c >= 0x2000 && c <= 0x200a) ||
        c === 0x2028 ||
        c === 0x2029 ||
        c === 0x202f ||
        c === 0x205f ||
        c === 0x3000 ||
        c === 0xfeff
    )
}

// "rejected", then whitespace, then "main" later on that same line. The text is already lower case.
// Walking forward once stays linear when the gap before "main" is a long run of spaces.
function rejectedThenMain(text: string): boolean {
    const needle = 'rejected'
    let from = 0
    while (from <= text.length - needle.length) {
        const at = text.indexOf(needle, from)
        if (at < 0) return false
        let i = at + needle.length
        if (i >= text.length || !isJsWhitespace(text[i])) {
            from = at + needle.length
            continue
        }
        while (i < text.length && isJsWhitespace(text[i])) i++
        let lineEnd = i
        while (lineEnd < text.length && !isLineEnd(text[lineEnd])) lineEnd++
        if (text.slice(i, lineEnd).includes('main')) return true
        from = at + needle.length
    }
    return false
}

// "owner/repo", "https://github.com/owner/repo" or ".../repo.git" becomes owner/repo and its HTTPS URL.
// A local bare repo (file:///path) is accepted only with CUTTLELY_GITHUB_ALLOW_FILE_REMOTES=on, for tests.
export function parseRepo(input: string): { repo: string; url: string } {
    const text = String(input ?? '').trim()
    if (!text) throw new GithubError(400, 'Enter the repository as owner/name, for example acme/cuttlely-flows.')
    if (text.startsWith('file://')) {
        if (!isOn(process.env.CUTTLELY_GITHUB_ALLOW_FILE_REMOTES)) {
            throw new GithubError(400, 'Enter a GitHub repository as owner/name, for example acme/cuttlely-flows.')
        }
        const local = text.slice('file://'.length)
        if (!path.isAbsolute(local) || /[\0\n\r]/.test(local)) throw new GithubError(400, 'A file:// repository needs an absolute path.')
        return { repo: text, url: text }
    }
    let rest = text
    const match = /^https:\/\/(?:www\.)?github\.com\/(.+)$/i.exec(text)
    if (match) rest = match[1]
    else if (/^[a-z]+:\/\//i.test(text) || text.includes('@')) {
        throw new GithubError(400, 'Enter a github.com repository as owner/name or as its https://github.com address.')
    }
    rest = withoutGitSuffix(trimTrailingSlashes(rest))
    const parts = rest.split('/')
    if (parts.length !== 2) throw new GithubError(400, 'Enter the repository as owner/name, for example acme/cuttlely-flows.')
    const [owner, name] = parts
    if (!OWNER.test(owner) || !NAME.test(name) || name === '.' || name === '..') {
        throw new GithubError(400, 'That is not a valid GitHub owner/name.')
    }
    const root = testRoot()
    if (root) return { repo: `${owner}/${name}`, url: `file://${path.join(root, owner, `${name}.git`)}` }
    return { repo: `${owner}/${name}`, url: `https://github.com/${owner}/${name}.git` }
}

// The name for a credential made from a pasted token: what the owner typed, or "GitHub: owner/name".
export function credentialLabel(name: string | undefined, repo: string): string {
    const typed = String(name ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, 100)
    if (typed) return typed
    return `GitHub: ${repo.startsWith('file://') ? 'test repository' : repo}`.slice(0, 100)
}

export function checkToken(token: string): string {
    const value = String(token ?? '').trim()
    if (!value) throw new GithubError(400, 'Paste a GitHub token.')
    if (value.length > 400 || /\s/.test(value) || /[^\x21-\x7e]/.test(value)) {
        throw new GithubError(400, 'That does not look like a GitHub token. Paste the token exactly as GitHub shows it.')
    }
    return value
}

// Removes the token and anything secret-shaped from text before it is logged.
export function scrub(text: string, token?: string): string {
    let out = String(text ?? '')
    if (token) {
        out = out.split(token).join('[token]')
        const header = Buffer.from(`x-access-token:${token}`).toString('base64')
        out = out.split(header).join('[token]')
    }
    return out
        .replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[token]')
        .replace(/(authorization:\s*)(\S+\s+)?\S+/gi, '$1[hidden]')
        .replace(/(https?:\/\/)[^/\s:@]+:[^@\s]+@/gi, '$1[hidden]@')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(' ')
        .slice(0, 300)
}

type Failure = { kind: 'diverged' | 'protected' | 'auth' | 'network' | 'other'; message: string; retry: boolean }

export function classifyFailure(stderr: string, repo: string, timedOut = false): Failure {
    const text = String(stderr || '').toLowerCase()
    if (timedOut) {
        return { kind: 'network', retry: true, message: `Could not reach GitHub in time to copy to ${repo}.` }
    }
    // GH006 is a classic branch protection rule, GH013 a repository ruleset.
    if (/gh006|gh013|protected branch|branch protection|rule violations|ruleset/.test(text)) {
        return {
            kind: 'protected',
            retry: false,
            message: `GitHub refused the copy because a rule on ${repo} protects it. Let this token update the repository, or turn the rule off for it, then select Try again.`
        }
    }
    if (
        text.includes('non-fast-forward') ||
        text.includes(['fetch', 'first'].join(' ')) ||
        text.includes('[rejected]') ||
        text.includes('updates were rejected') ||
        rejectedThenMain(text)
    ) {
        return {
            kind: 'diverged',
            retry: false,
            message: `${repo} on GitHub has changes that are not on this server, so copying stopped. Cuttlely never overwrites GitHub. Connect an empty repository, or undo those changes on GitHub, then select Try again.`
        }
    }
    if (
        /authentication failed|invalid username or password|could not read username|repository not found|not found|permission to .* denied|403|401|access denied|bad credentials/.test(
            text
        )
    ) {
        return {
            kind: 'auth',
            retry: true,
            message: `GitHub did not accept the token for ${repo}, or the repository is not there. Check that the token can read and write Contents on it.`
        }
    }
    if (/could not resolve host|unable to access|connection|timed out|network|ssl|tls|proxy|temporary failure/.test(text)) {
        return { kind: 'network', retry: true, message: `Could not reach GitHub to copy to ${repo}.` }
    }
    return { kind: 'other', retry: true, message: `GitHub did not take the copy to ${repo}.` }
}

// Prod reads the repository and never writes to it, so only these can go wrong.
export function classifyReadFailure(stderr: string, repo: string, timedOut = false): Failure | { kind: 'empty' } {
    const text = String(stderr || '').toLowerCase()
    if (timedOut) return { kind: 'network', retry: true, message: `Could not reach GitHub in time to look for new versions in ${repo}.` }
    if (/could(n.t| not) find remote ref/.test(text)) return { kind: 'empty' }
    if (
        /authentication failed|invalid username or password|could not read username|repository not found|not found|permission to .* denied|403|401|access denied|bad credentials/.test(
            text
        )
    ) {
        return {
            kind: 'auth',
            retry: true,
            message: `GitHub did not accept the token for ${repo}, or the repository is not there. Check that the token can read Contents on it.`
        }
    }
    if (/could not resolve host|unable to access|connection|timed out|network|ssl|tls|proxy|temporary failure/.test(text)) {
        return { kind: 'network', retry: true, message: `Could not reach GitHub to look for new versions in ${repo}.` }
    }
    return { kind: 'other', retry: true, message: `GitHub did not answer when looking for new versions in ${repo}.` }
}

// Basic auth as an HTTP header, scoped to the repository URL, passed only in the child's environment.
export function authEnv(url: string, token: string): Record<string, string> {
    if (!/^https:\/\//i.test(url)) return {}
    const header = Buffer.from(`x-access-token:${token}`).toString('base64')
    return {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `http.${url}.extraHeader`,
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${header}`,
        GIT_ASKPASS: '',
        SSH_ASKPASS: '',
        GIT_HTTP_LOW_SPEED_LIMIT: '1000',
        GIT_HTTP_LOW_SPEED_TIME: '30'
    }
}

interface NetResult {
    ok: boolean
    stdout: string
    stderr: string
    timedOut: boolean
}

export class GithubSync {
    private readonly deps: GithubDeps
    private state: GithubState = 'waiting'
    private message = ''
    private lastCopiedAt: string | null = null
    private lastCopiedVersion: string | null = null
    private nextTryAt: number | null = null
    private failures = 0
    private timer: NodeJS.Timeout | null = null
    private running: Promise<void> | null = null
    private again = false
    private generation = 0
    private known = false
    private lastCheckedAt: string | null = null
    // A non-retryable copy failure. Reads keep polling, but the copy stays stopped until Try again, disconnect, or connect.
    private copyHold: string | null = null
    // The commit and list fingerprint whose note was read back from the remote. A later pass still reads it again.
    private notedHead: string | null = null
    private notedFingerprint: string | null = null
    // connect and setEnvironment share this until the connect-time copy finishes, so the list cannot change under the check.
    private envGate: Promise<void> = Promise.resolve()
    // The plan connect already checked. The connect-time copy uses it instead of reading the file again.
    private pinnedPlan: ActivePlan | null = null

    constructor(deps: GithubDeps) {
        this.deps = deps
    }

    private now(): number {
        return this.deps.now ? this.deps.now() : Date.now()
    }

    private log(message: string): void {
        if (this.deps.log) this.deps.log(message)
    }

    private configPath(): string {
        return path.join(this.deps.store().dir, '.git', CONFIG_FILE)
    }

    private readSaved(): SavedConfig | null {
        const file = this.configPath()
        if (!fs.existsSync(file)) return null
        try {
            const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
            if (typeof saved?.repo !== 'string' || typeof saved?.credential?.id !== 'string') throw new Error('bad file')
            return saved
        } catch {
            throw new GithubError(409, CONNECTION_UNREADABLE)
        }
    }

    // A repository is connected (it may be stopped). Reads no credential.
    isConnected(): boolean {
        return fs.existsSync(this.configPath())
    }

    // The connection in use, with the token read from its credential.
    async config(): Promise<ActiveConfig | null> {
        const saved = this.readSaved()
        if (!saved) return null
        const parsed = parseRepo(saved.repo)
        if (saved.remote && saved.remote !== parsed.url) {
            throw new GithubError(
                409,
                `${saved.repo} now points somewhere other than where it was connected, so nothing is copied. Disconnect and connect again.`
            )
        }
        const found = await this.deps.credentials.get(saved.credential.id, saved.credential.workspaceId)
        if (!found) {
            throw new GithubError(
                409,
                `The GitHub credential "${saved.credential.name}" is no longer in Credentials, so nothing is copied. Pick or add a GitHub credential to keep copying.`
            )
        }
        if (!found.token) {
            throw new GithubError(
                409,
                `The GitHub credential "${found.name}" has no access token. Add one on the Credentials page, then select Try again.`
            )
        }
        return {
            ...parsed,
            token: found.token,
            credential: { ...saved.credential, name: found.name },
            connectedAt: saved.connectedAt || null
        }
    }

    // A token pasted now, or the one in a saved Github API credential of this workspace.
    private async tokenFrom(input: { token?: string; credentialId?: string }, workspaceId?: string) {
        if (input?.credentialId) {
            if (!workspaceId) throw new GithubError(400, 'No active workspace.')
            const found = await this.deps.credentials.get(String(input.credentialId), workspaceId)
            if (!found) throw new GithubError(404, 'That GitHub credential is not in this workspace.')
            if (!found.token) throw new GithubError(400, `The GitHub credential "${found.name}" has no access token.`)
            return { token: found.token, credential: { id: found.id, name: found.name } }
        }
        return { token: checkToken(String(input?.token ?? '')), credential: null }
    }

    private async git(args: string[], env: Record<string, string> = {}, timeoutMs = NETWORK_TIMEOUT_MS): Promise<NetResult> {
        if (this.deps.onGit) this.deps.onGit(args, env)
        const cwd = this.deps.store().dir
        return new Promise((resolve) => {
            execFile(
                'git',
                ['-c', 'core.autocrlf=false', '-c', 'credential.helper=', '-c', 'protocol.ext.allow=never', ...args],
                { cwd, env: gitEnv(cwd, env), timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 },
                (error, stdout, stderr) => {
                    const timedOut = Boolean(error && ((error as any).killed || (error as any).signal === 'SIGKILL'))
                    resolve({
                        ok: !error,
                        stdout: String(stdout || ''),
                        stderr: String(stderr || (error && !timedOut ? error.message : '')),
                        timedOut
                    })
                }
            )
        })
    }

    private async refSha(ref: string): Promise<string | null> {
        try {
            const out = await runGit(this.deps.store().dir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])
            return out.stdout.trim() || null
        } catch {
            return null
        }
    }

    private async isAncestor(sha: string, of: string): Promise<boolean> {
        try {
            await runGit(this.deps.store().dir, ['merge-base', '--is-ancestor', sha, of])
            return true
        } catch {
            return false
        }
    }

    private async waitingCount(): Promise<number | null> {
        const head = await this.refSha('refs/heads/main')
        if (!head) return 0
        const base = await this.refSha(PUSHED_REF)
        try {
            const out = await runGit(this.deps.store().dir, ['rev-list', '--count', base ? `${base}..${head}` : head])
            return Number(out.stdout.trim()) || 0
        } catch {
            return null
        }
    }

    async status(): Promise<GithubStatus> {
        const blank: GithubStatus = {
            enabled: this.deps.enabled(),
            connected: false,
            credential: null,
            repo: null,
            url: null,
            state: 'not-connected',
            message: 'Not connected. History stays on this server.',
            code: null,
            waiting: null,
            lastCopiedAt: null,
            lastCopiedVersion: null,
            nextTryAt: null,
            connectedAt: null,
            environment: null,
            environments: legacyEnvironments(),
            promotes: false,
            role: 'copy',
            lastCheckedAt: null,
            incomingVersion: null
        }
        if (!blank.enabled) {
            return { ...blank, state: 'off', message: 'Version history is off on this server, so there is nothing to copy.' }
        }
        const plan = this.plan()
        const saved = this.readEnvironment()
        blank.environment = saved.environment
        blank.environments = saved.invalid ? [] : saved.environments
        blank.promotes = plan.reads
        blank.role = plan.reads && !plan.copies ? 'read' : 'copy'
        if (saved.invalid) {
            // The repository file is still there. The card needs connected so Disconnect stays available.
            const link = this.savedConnection()
            return {
                ...blank,
                ...link,
                state: 'stopped',
                promotes: false,
                waiting: null,
                role: 'copy',
                message: LIST_UNREADABLE,
                code: 'LIST_UNREADABLE'
            }
        }
        if (!plan.reads && !plan.copies) {
            // A named list with no environment chosen does not copy and does not read. Do not count local versions as waiting.
            const link = this.savedConnection()
            return {
                ...blank,
                ...link,
                state: 'stopped',
                promotes: false,
                waiting: null,
                role: 'copy',
                message: PICK_ENVIRONMENT
            }
        }
        if (blank.role === 'read') {
            blank.message =
                this.fromLabel() === 'Dev'
                    ? 'Not connected. Connect the repository Dev copies to, to see its new versions here.'
                    : `Not connected. Connect the repository ${this.fromLabel()} copies to, to see its new versions here.`
        }
        let config: ActiveConfig | null
        try {
            config = await this.config()
        } catch (error) {
            let saved: SavedConfig | null = null
            try {
                saved = this.readSaved()
            } catch {
                saved = null
            }
            return {
                ...blank,
                connected: Boolean(saved),
                repo: saved ? saved.repo : null,
                credential: saved ? { id: saved.credential.id, name: saved.credential.name } : null,
                state: 'stopped',
                message: (error as Error).message,
                code: statusCode((error as Error).message)
            }
        }
        if (!config) return blank
        if (!this.known) {
            this.known = true
            this.schedule(0)
        }
        if (blank.role === 'read') return this.readStatus(blank, config)
        const waiting = await this.waitingCount()
        let state = this.state
        let message = this.message
        if (state === 'up-to-date' && waiting) state = 'waiting'
        if (state === 'waiting' && waiting === 0 && !this.running) state = 'up-to-date'
        if (state === 'up-to-date') message = 'Up to date. Every version on this server is on GitHub.'
        if (state === 'waiting')
            message = waiting === 1 ? '1 version is waiting to be copied.' : `${waiting ?? 'New'} versions are waiting to be copied.`
        if (state === 'copying') message = 'Copying to GitHub now.'
        return {
            ...blank,
            connected: true,
            credential: { id: config.credential.id, name: config.credential.name },
            repo: config.repo,
            url: /^https:\/\//.test(config.url)
                ? config.url.replace(/\.git$/, '')
                : testRoot() && !config.repo.startsWith('file://')
                ? `https://github.com/${config.repo}`
                : null,
            state,
            message,
            code: statusCode(message),
            waiting,
            lastCopiedAt: this.lastCopiedAt,
            lastCopiedVersion: this.lastCopiedVersion,
            nextTryAt: this.nextTryAt && state === 'retrying' ? new Date(this.nextTryAt).toISOString() : null,
            connectedAt: config.connectedAt,
            lastCheckedAt: plan.reads ? this.lastCheckedAt : null,
            incomingVersion: plan.reads ? (await this.refSha(INCOMING_REF))?.slice(0, 7) || null : null
        }
    }

    // The last environment: what the card shows. It never counts versions waiting to be copied.
    private async readStatus(blank: GithubStatus, config: ActiveConfig): Promise<GithubStatus> {
        const incoming = await this.refSha(INCOMING_REF)
        const fromDev = this.fromLabel() === 'Dev'
        let state = this.state
        let message = this.message
        if (state === 'up-to-date')
            message = incoming
                ? fromDev
                    ? 'Looks for new versions from Dev every few minutes. Nothing on this server is copied to GitHub.'
                    : `Looks for new versions from ${this.fromLabel()} every few minutes. Nothing on this server is copied to GitHub.`
                : fromDev
                ? 'Nothing from Dev yet. Cuttlely looks again every few minutes.'
                : `Nothing from ${this.fromLabel()} yet. Cuttlely looks again every few minutes.`
        if (state === 'waiting')
            message = fromDev ? 'Looking for new versions from Dev soon.' : `Looking for new versions from ${this.fromLabel()} soon.`
        if (state === 'copying') {
            state = 'waiting'
            message = fromDev ? 'Looking for new versions from Dev now.' : `Looking for new versions from ${this.fromLabel()} now.`
        }
        return {
            ...blank,
            connected: true,
            credential: { id: config.credential.id, name: config.credential.name },
            repo: config.repo,
            url: /^https:\/\//.test(config.url)
                ? config.url.replace(/\.git$/, '')
                : testRoot() && !config.repo.startsWith('file://')
                ? `https://github.com/${config.repo}`
                : null,
            state,
            message,
            code: statusCode(message),
            nextTryAt: this.nextTryAt && state === 'retrying' ? new Date(this.nextTryAt).toISOString() : null,
            connectedAt: config.connectedAt,
            lastCheckedAt: this.lastCheckedAt,
            incomingVersion: incoming ? incoming.slice(0, 7) : null
        }
    }

    // The last environment only reads. The first, and a server with no label on the Dev/Prod pair, only copies.
    private readOnly(): boolean {
        const plan = this.plan()
        return plan.reads && !plan.copies
    }

    private rolePath(): string {
        return path.join(this.deps.store().dir, '.git', ROLE_FILE)
    }

    private readEnvironment(): EnvironmentConfig {
        try {
            if (!fs.existsSync(this.rolePath())) return { environment: null, environments: legacyEnvironments(), invalid: false }
            return parseEnvironmentFile(JSON.parse(fs.readFileSync(this.rolePath(), 'utf8')))
        } catch {
            // A missing file is the unlabeled server. A file that cannot be read must not fall back to Dev and Prod:
            // that would publish a Staging or Prod server's history where Dev publishes.
            return { environment: null, environments: [], invalid: true }
        }
    }

    private plan(): SyncPlan {
        return this.capturedPlan()
    }

    // One read of the environment file for a sync pass. Callers must not read it again to choose a branch.
    private capturedPlan(): ActivePlan {
        const saved = this.readEnvironment()
        if (saved.invalid) {
            return {
                reads: false,
                copies: false,
                sourceBranch: null,
                publishBranch: null,
                invalid: true,
                environments: [],
                environment: null,
                verifiedSource: null
            }
        }
        return {
            ...syncPlan(saved.environments, saved.environment),
            invalid: false,
            environments: saved.environments,
            environment: saved.environment,
            verifiedSource: null
        }
    }

    private savedConnection(): { connected: boolean; repo: string | null; credential: { id: string; name: string } | null } {
        try {
            const saved = this.readSaved()
            if (!saved) return { connected: false, repo: null, credential: null }
            return { connected: true, repo: saved.repo, credential: { id: saved.credential.id, name: saved.credential.name } }
        } catch {
            return { connected: true, repo: null, credential: null }
        }
    }

    // The previous environment, as the screen names it. "Dev" for the saved pair.
    private fromLabel(): string {
        const saved = this.readEnvironment()
        const index = saved.environments.findIndex((item) => item.server === saved.environment)
        const previous = index > 0 ? saved.environments[index - 1] : null
        if (!previous || previous.name.toLowerCase() === 'dev') return 'Dev'
        if (previous.name.toLowerCase() === 'prod') return 'Prod'
        return previous.name
    }

    environments(): NamedEnvironment[] {
        const saved = this.readEnvironment()
        return saved.invalid ? [] : saved.environments
    }

    environment(): string | null {
        return this.readEnvironment().environment
    }

    // Names this server, or saves the ordered list. A Dev or Prod label with no list stays the old file.
    async setEnvironment(value: unknown, environmentsInput?: unknown): Promise<GithubStatus> {
        if (!this.deps.enabled()) throw new GithubError(409, 'Version history is off on this server.')
        return this.withEnvironmentLock(() => this.setEnvironmentBody(value, environmentsInput))
    }

    private async setEnvironmentBody(value: unknown, environmentsInput?: unknown): Promise<GithubStatus> {
        const current = this.readEnvironment()
        // An environment-only save cannot invent the Dev and Prod pair when the file does not parse.
        // That would delete a named list and rewrite the fingerprint on versions already copied.
        if (current.invalid && environmentsInput === undefined) throw new GithubError(409, LIST_UNREADABLE)
        let nextChain = current.invalid ? legacyEnvironments() : current.environments
        let nextEnv: string | null
        if (environmentsInput !== undefined) {
            const parsed = parseEnvironmentsAllowingLegacy(environmentsInput)
            if (!parsed.ok) throw new GithubError(400, parsed.error)
            nextChain = parsed.environments
        }
        if (value === null || value === '') nextEnv = null
        else if (typeof value === 'string' && nextChain.some((item) => item.server === value)) nextEnv = value
        else {
            throw new GithubError(400, isLegacyChain(nextChain) ? 'Pick Dev or Prod.' : 'Pick an environment from the list.')
        }
        const before = current.invalid
            ? { reads: false, copies: false, sourceBranch: null, publishBranch: null }
            : syncPlan(current.environments, current.environment)
        const after = syncPlan(nextChain, nextEnv)
        let connected = false
        try {
            connected = Boolean(this.readSaved())
        } catch {
            connected = true
        }
        const changed =
            before.reads !== after.reads ||
            before.copies !== after.copies ||
            before.sourceBranch !== after.sourceBranch ||
            before.publishBranch !== after.publishBranch
        // An unreadable file is not a real plan. Saving the list again is how the operator fixes it.
        if (connected && !current.invalid && changed) {
            throw new GithubError(409, 'Disconnect GitHub before changing what this server reads or copies.')
        }
        // The saved pair is stored as one environment field. That write must not replace a named list that still parses
        // when the read and copy plan stays the same: the disconnect check above does not see that save.
        if (
            !current.invalid &&
            environmentsInput !== undefined &&
            isLegacyChain(nextChain) &&
            !isLegacyChain(current.environments) &&
            !changed
        ) {
            throw new GithubError(409, LIST_STILL_VALID)
        }
        const beforeFingerprint = current.invalid ? null : environmentListFingerprint(current.environments)
        const afterFingerprint = environmentListFingerprint(nextChain)
        const fingerprintChanged = beforeFingerprint !== afterFingerprint
        await this.deps.store().ensure()
        const file = this.rolePath()
        if (isLegacyChain(nextChain)) {
            if (nextEnv) fs.writeFileSync(file, JSON.stringify({ environment: nextEnv }) + '\n')
            else fs.rmSync(file, { force: true })
        } else {
            const body: { environment?: string; environments: NamedEnvironment[] } = { environments: nextChain }
            if (nextEnv) body.environment = nextEnv
            fs.writeFileSync(file, JSON.stringify(body) + '\n')
        }
        const sourceChanged = before.sourceBranch !== after.sourceBranch
        // Versions read from the previous source must not stay promotable after the list is repaired or the source changes.
        if (current.invalid || sourceChanged) {
            await runGit(this.deps.store().dir, ['update-ref', '-d', INCOMING_REF]).catch(() => undefined)
            if (current.invalid || this.message === LIST_UNREADABLE) {
                this.state = 'waiting'
                this.message = ''
                this.nextTryAt = null
                this.copyHold = null
            }
        }
        if (fingerprintChanged) {
            this.notedHead = null
            this.notedFingerprint = null
        }
        if (connected && (current.invalid || sourceChanged || fingerprintChanged)) await this.sync()
        return this.status()
    }

    private async api(token: string, method: 'GET' | 'POST', route: string, body?: unknown): Promise<{ status: number; data: any }> {
        const doFetch = this.deps.fetch || fetch
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
        try {
            const res = await doFetch(`${apiBase()}${route}`, {
                method,
                headers: {
                    Accept: 'application/vnd.github+json',
                    Authorization: `Bearer ${token}`,
                    'X-GitHub-Api-Version': '2022-11-28',
                    'User-Agent': 'cuttlely',
                    ...(body ? { 'Content-Type': 'application/json' } : {})
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal
            })
            let data: any = null
            try {
                data = await res.json()
            } catch {
                data = null
            }
            return { status: res.status, data }
        } catch {
            throw new GithubError(400, 'Could not reach GitHub. Check that this server can reach github.com, then try again.')
        } finally {
            clearTimeout(timer)
        }
    }

    // The repositories this token can write to, most recently changed first. Nothing is saved.
    async listRepos(input: { token?: string; credentialId?: string }, workspaceId?: string): Promise<GithubRepoList> {
        const { token } = await this.tokenFrom(input, workspaceId)
        const reading = this.readOnly()
        const user = await this.api(token, 'GET', '/user')
        if (user.status === 401 || user.status === 403)
            throw new GithubError(400, 'GitHub did not accept this token. Check it and paste it again.')
        if (user.status !== 200 || typeof user.data?.login !== 'string')
            throw new GithubError(400, 'GitHub did not answer. Try again in a moment.')
        // Every page, up to REPO_PAGES of 100, so an older repository is in the list too.
        const items: any[] = []
        for (let page = 1; page <= REPO_PAGES; page++) {
            const list = await this.api(
                token,
                'GET',
                `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`
            )
            if (list.status !== 200 || !Array.isArray(list.data))
                throw new GithubError(400, 'GitHub did not list the repositories for this token.')
            items.push(...list.data)
            if (list.data.length < 100) break
        }
        const repos: GithubRepoChoice[] = items
            // Prod only reads, so a repository the token can only read is fine there.
            .filter((item: any) => typeof item?.full_name === 'string' && (reading || item?.permissions?.push !== false) && !item?.archived)
            .map((item: any) => ({
                repo: String(item.full_name),
                private: Boolean(item.private),
                empty: Number(item.size) === 0,
                pushedAt: typeof item.pushed_at === 'string' ? item.pushed_at : null
            }))
        return { account: String(user.data.login), repos }
    }

    // Makes a new private, empty repository for this history. Then connect it.
    async createRepo(input: { token?: string; credentialId?: string; name?: string }, workspaceId?: string): Promise<GithubRepoChoice> {
        // A server that reads uses the repository the previous environment already uses. A new one has nothing to read.
        if (this.plan().reads) {
            throw new GithubError(
                409,
                `Pick the repository your ${this.fromLabel()} server copies to. A new one has nothing for this server to read.`
            )
        }
        const { token } = await this.tokenFrom(input, workspaceId)
        const name = String(input?.name ?? '').trim()
        if (!NAME.test(name) || name === '.' || name === '..') {
            throw new GithubError(400, 'Use letters, numbers, dots, dashes or underscores for the name, for example cuttlely-flows.')
        }
        const res = await this.api(token, 'POST', '/user/repos', {
            name,
            private: true,
            auto_init: false,
            description: 'Flow version history from Cuttlely'
        })
        if (res.status === 201 && typeof res.data?.full_name === 'string') {
            return { repo: res.data.full_name, private: Boolean(res.data.private), empty: true, pushedAt: null }
        }
        if (res.status === 422)
            throw new GithubError(409, `You already have a repository named ${name}. Pick it from the list, or choose another name.`)
        if (res.status === 401) throw new GithubError(400, 'GitHub did not accept this token. Check it and paste it again.')
        if (res.status === 403 || res.status === 404) {
            throw new GithubError(
                400,
                'This token cannot create repositories. Create an empty private repository on GitHub, give the token access to it, then pick it here.'
            )
        }
        throw new GithubError(400, 'GitHub did not create the repository. Try again in a moment.')
    }

    // One lock for connect and setEnvironment. The next caller waits until this body, including the connect-time copy, finishes.
    private async withEnvironmentLock<T>(body: () => Promise<T>): Promise<T> {
        const previous = this.envGate
        let release: () => void = () => undefined
        this.envGate = new Promise<void>((resolve) => {
            release = resolve
        })
        await previous
        try {
            return await body()
        } finally {
            release()
        }
    }

    private sameConnectPlan(left: ActivePlan, right: ActivePlan): boolean {
        return (
            left.invalid === right.invalid &&
            left.environment === right.environment &&
            left.reads === right.reads &&
            left.copies === right.copies &&
            left.sourceBranch === right.sourceBranch &&
            left.publishBranch === right.publishBranch &&
            environmentListFingerprint(left.environments) === environmentListFingerprint(right.environments)
        )
    }

    private listedSha(refs: string[], mark: string): string {
        return (refs.find((line) => line.endsWith(` ${mark}`) || line.endsWith(`\t${mark}`)) || '').split(/\s/)[0] || ''
    }

    // The branch and notes checks for the list on disk. Nothing is written. A later environment must have this
    // server's list recorded on the previous environment's tip from the listing.
    private async acceptConnection(
        plan: ActivePlan,
        refs: string[],
        repo: string,
        url: string,
        token: string
    ): Promise<{ plan: ActivePlan; pushed: string | null }> {
        if (plan.invalid) throw new GithubError(409, LIST_UNREADABLE)
        if (!plan.reads && !plan.copies) throw new GithubError(409, PICK_ENVIRONMENT)
        const remoteMain = this.listedSha(refs, 'refs/heads/main')
        const otherContent = `${repo} already has other content. Connect an empty repository (create it without a README or license), or one this server copied to before.`
        let pushed: string | null = null
        let verifiedSource: string | null = null
        if (isLegacyChain(plan.environments)) {
            const reading = plan.reads && !plan.copies
            if (reading) {
                // Prod reads what Dev copied. An empty repository is fine: Dev has not copied anything yet.
                if (!remoteMain && refs.length) {
                    throw new GithubError(
                        409,
                        `${repo} has other content and no versions from a Dev server. Connect the repository your Dev server copies to.`
                    )
                }
            } else if (remoteMain) {
                const head = await this.refSha('refs/heads/main')
                if (!head || !(await this.isAncestor(remoteMain, head))) throw new GithubError(409, otherContent)
                pushed = remoteMain
            } else if (refs.length) {
                throw new GithubError(409, otherContent)
            }
        } else {
            if (plan.reads && plan.sourceBranch) verifiedSource = await this.requireSourceNote(plan, refs, repo, url, token)
            if (plan.publishBranch) {
                // Other environments may already publish here. Only this server's own publish name has to match its history.
                const remotePublish = this.listedSha(refs, `refs/heads/${plan.publishBranch}`)
                if (remotePublish) {
                    const head = await this.refSha('refs/heads/main')
                    if (!head || !(await this.isAncestor(remotePublish, head))) throw new GithubError(409, otherContent)
                    pushed = remotePublish
                }
            }
        }
        return { plan: { ...plan, verifiedSource }, pushed }
    }

    // Fetch the previous tip named in the listing and require this server's list on that tip. Absent, unverified
    // and a different list are the same refusal, and nothing is saved.
    private async requireSourceNote(plan: ActivePlan, refs: string[], repo: string, url: string, token: string): Promise<string> {
        const from = sourceTitle(plan.environments, plan.environment)
        const refused = new GithubError(
            400,
            `Connect the repository your ${from} server copies to. This one has no versions from ${from} yet.`
        )
        const sourceSha = plan.sourceBranch ? this.listedSha(refs, `refs/heads/${plan.sourceBranch}`) : ''
        if (!sourceSha || !this.listedSha(refs, ENVIRONMENT_NOTE_REMOTE)) throw refused
        const dir = this.deps.store().dir
        await runGit(dir, ['update-ref', '-d', CONNECT_SOURCE_REF]).catch(() => undefined)
        const fetched = await this.git(
            ['fetch', '--no-tags', '--no-recurse-submodules', '--quiet', url, `refs/heads/${plan.sourceBranch}:${CONNECT_SOURCE_REF}`],
            authEnv(url, token)
        )
        const tip = fetched.ok ? await this.refSha(CONNECT_SOURCE_REF) : null
        await runGit(dir, ['update-ref', '-d', CONNECT_SOURCE_REF]).catch(() => undefined)
        if (!fetched.ok || tip !== sourceSha) throw refused
        const note = await this.environmentNoteCheck(
            { repo, url, token, credential: { id: '', name: '', workspaceId: '' }, connectedAt: null },
            sourceSha,
            plan,
            this.generation
        )
        if (note.kind !== 'match') throw refused
        return sourceSha
    }

    // Checks the repository and token, then saves the connection and starts the first copy.
    // A pasted token is saved as a new Github API credential in this workspace, after the check passes.
    async connect(
        input: { repo?: string; token?: string; credentialId?: string; credentialName?: string },
        workspaceId?: string
    ): Promise<GithubStatus> {
        if (!this.deps.enabled()) throw new GithubError(409, 'Version history is off on this server.')
        if (!workspaceId) throw new GithubError(400, 'No active workspace.')
        return this.withEnvironmentLock(() => this.connectBody(input, workspaceId))
    }

    private async connectBody(
        input: { repo?: string; token?: string; credentialId?: string; credentialName?: string },
        workspaceId: string
    ): Promise<GithubStatus> {
        const { repo, url } = parseRepo(String(input?.repo ?? ''))
        const picked = await this.tokenFrom(input, workspaceId)
        const token = picked.token
        const store = this.deps.store()
        await store.ensure()
        const opened = this.capturedPlan()
        if (opened.invalid) throw new GithubError(409, LIST_UNREADABLE)
        if (!opened.reads && !opened.copies) throw new GithubError(409, PICK_ENVIRONMENT)
        const reading = opened.reads && !opened.copies

        // Every ref, not just main: a repository with only master, trunk or a tag is not empty.
        const check = await this.git(['ls-remote', url], authEnv(url, token), CHECK_TIMEOUT_MS)
        if (!check.ok) {
            const failure = classifyFailure(check.stderr, repo, check.timedOut)
            this.log(`[versions] GitHub check for ${repo} failed: ${scrub(check.stderr, token)}`)
            const message =
                failure.kind === 'auth'
                    ? `GitHub did not accept this token for ${repo}, or the repository is not there. Use a token that can ${
                          reading ? 'read' : 'read and write'
                      } Contents on that repository.`
                    : failure.kind === 'network'
                    ? `Could not reach GitHub to check ${repo}. Nothing was saved. Try again in a moment.`
                    : `GitHub did not answer the check for ${repo}. Nothing was saved.`
            throw new GithubError(400, message)
        }
        const refs = check.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => /\srefs\//.test(line))
        // The list can be saved while the listing is in flight. Check the list that is on disk now.
        let accepted = await this.acceptConnection(this.capturedPlan(), refs, repo, url, token)
        // And again immediately before the connection file is written, so a later list is not saved under the earlier check.
        const fresh = this.capturedPlan()
        if (!this.sameConnectPlan(fresh, accepted.plan)) accepted = await this.acceptConnection(fresh, refs, repo, url, token)
        const confirm = this.capturedPlan()
        if (!this.sameConnectPlan(confirm, accepted.plan)) throw new GithubError(409, LIST_UNREADABLE)
        const plan = accepted.plan
        const pushed = accepted.pushed

        this.generation += 1
        this.clearTimer()
        const credential =
            picked.credential ||
            (await this.deps.credentials.create({
                name: credentialLabel(input?.credentialName, repo),
                token,
                workspaceId
            }))
        const saved: SavedConfig = {
            version: 1,
            repo,
            credential: { id: credential.id, name: credential.name, workspaceId },
            connectedAt: new Date(this.now()).toISOString(),
            remote: url
        }
        const file = this.configPath()
        const temp = `${file}.${process.pid}.tmp`
        fs.writeFileSync(temp, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 })
        fs.renameSync(temp, file)
        try {
            fs.chmodSync(file, 0o600)
        } catch {
            // best effort on file systems without modes
        }
        if (pushed) await runGit(store.dir, ['update-ref', PUSHED_REF, pushed])
        else await runGit(store.dir, ['update-ref', '-d', PUSHED_REF]).catch(() => undefined)
        // A new connection starts from what this repository holds now.
        await runGit(store.dir, ['update-ref', '-d', INCOMING_REF]).catch(() => undefined)
        this.resetState()
        this.known = true
        this.log(`[versions] Connected version history to GitHub ${repo}.`)
        await this.sync(plan)
        return this.status()
    }

    // Forgets the repository. Nothing on GitHub changes, and the credential stays in Credentials.
    async disconnect(): Promise<GithubStatus> {
        this.generation += 1
        this.clearTimer()
        const store = this.deps.store()
        if (fs.existsSync(path.join(store.dir, '.git'))) {
            fs.rmSync(this.configPath(), { force: true })
            await runGit(store.dir, ['update-ref', '-d', PUSHED_REF]).catch(() => undefined)
            await runGit(store.dir, ['update-ref', '-d', INCOMING_REF]).catch(() => undefined)
        }
        this.resetState()
        this.known = false
        this.log('[versions] Disconnected version history from GitHub.')
        return this.status()
    }

    // Copy now, without waiting for the next try.
    async tryNow(): Promise<GithubStatus> {
        const config = await this.config()
        if (!config) throw new GithubError(409, 'GitHub is not connected.')
        this.clearTimer()
        this.failures = 0
        // Try again is the operator intervening. A stopped copy may run once more.
        this.copyHold = null
        await this.sync()
        return this.status()
    }

    // A new version was committed. Copy it soon. Never throws.
    notify(): void {
        try {
            // The last environment copies nothing, so its own saves never start a copy.
            if (this.state === 'stopped' || !this.plan().copies) return
            this.schedule(this.deps.debounceMs ?? 3000, true)
        } catch {
            // never break a save
        }
    }

    // At server start: copy anything saved while GitHub could not be reached.
    start(): void {
        this.known = true
        this.schedule(this.deps.debounceMs ?? 10_000)
    }

    stop(): void {
        this.clearTimer()
    }

    // Waits for a copy in progress. Used by tests.
    async idle(): Promise<void> {
        while (this.running) await this.running
    }

    private resetState(): void {
        this.state = 'waiting'
        this.message = ''
        this.failures = 0
        this.nextTryAt = null
        this.lastCopiedAt = null
        this.lastCopiedVersion = null
        this.lastCheckedAt = null
        this.copyHold = null
        this.notedHead = null
        this.notedFingerprint = null
    }

    private clearTimer(): void {
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
        if (this.state === 'retrying') this.nextTryAt = null
    }

    private schedule(delayMs: number, followUp = false): void {
        if (this.timer) {
            if (this.state === 'retrying') return
            clearTimeout(this.timer)
        }
        this.timer = setTimeout(() => {
            this.timer = null
            if (this.running) {
                // A save during a copy runs again when this pass finishes. A poll that comes due mid-pass waits.
                if (followUp) this.again = true
                else this.schedule(delayMs, false)
                return
            }
            void this.sync()
        }, delayMs)
        if (typeof this.timer.unref === 'function') this.timer.unref()
    }

    // One copy at a time. A version saved while a copy runs is copied right after.
    // A plan passed from connect is the one that passed the check. That copy does not read the file again.
    sync(pinned?: ActivePlan): Promise<void> {
        if (pinned) this.pinnedPlan = pinned
        if (this.running) {
            this.again = true
            return this.running
        }
        const gate: { run?: Promise<void> } = {}
        gate.run = (async () => {
            try {
                do {
                    this.again = false
                    const plan = this.pinnedPlan ?? this.capturedPlan()
                    if (plan.invalid) {
                        this.state = 'stopped'
                        this.message = LIST_UNREADABLE
                        this.nextTryAt = null
                        return
                    }
                    if (!plan.reads && !plan.copies) {
                        this.state = 'stopped'
                        this.message = PICK_ENVIRONMENT
                        this.nextTryAt = null
                        return
                    }
                    if (plan.reads) await this.readOnce(plan)
                    // A read that just failed must not be followed by a copy in the same pass.
                    // A copy that already stopped for a reason the operator has to fix is not retried by the next read.
                    const readFailed = plan.reads && (this.state === 'retrying' || this.state === 'stopped')
                    if (plan.copies && !readFailed && !this.copyHold) await this.pushOnce(plan)
                    if (this.copyHold) {
                        this.state = 'stopped'
                        this.message = this.copyHold
                        this.nextTryAt = null
                        // The read that ran before the copy stopped may already have consumed its timer.
                        if (plan.reads && !this.timer) this.schedule(this.deps.checkEveryMs ?? DEFAULT_CHECK_EVERY_MS)
                    }
                } while (this.again && this.state !== 'stopped' && this.state !== 'retrying')
            } catch (error) {
                const reading = this.readOnly()
                this.log(`[versions] GitHub ${reading ? 'check' : 'copy'} failed: ${scrub((error as Error)?.message || String(error))}`)
                // Never sit in "waiting": try again later like any other failure.
                this.scheduleRetry(
                    reading
                        ? this.fromLabel() === 'Dev'
                            ? 'Something went wrong while looking for new versions from Dev.'
                            : `Something went wrong while looking for new versions from ${this.fromLabel()}.`
                        : 'Something went wrong while copying to GitHub.',
                    reading
                )
            } finally {
                this.pinnedPlan = null
                // Yield so this.running is assigned before we clear it when the body never awaits.
                await Promise.resolve()
                if (this.running === gate.run) this.running = null
            }
        })()
        this.running = gate.run
        return gate.run
    }

    private async pushOnce(plan: ActivePlan): Promise<void> {
        const generation = this.generation
        if (!this.deps.enabled()) return
        const branch = plan.publishBranch
        if (plan.invalid || !branch) {
            this.state = 'stopped'
            this.message = LIST_UNREADABLE
            this.nextTryAt = null
            return
        }
        let config: ActiveConfig | null
        try {
            config = await this.config()
        } catch (error) {
            this.holdCopy((error as Error).message)
            return
        }
        // The file can go bad while the credential is read. Do not publish anywhere else, including main.
        if (!config || generation !== this.generation) return
        if (this.readEnvironment().invalid) {
            this.state = 'stopped'
            this.message = LIST_UNREADABLE
            this.nextTryAt = null
            return
        }
        const store = this.deps.store()
        await store.ensure()
        const head = await this.refSha('refs/heads/main')
        const base = await this.refSha(PUSHED_REF)
        if (!head || head === base) {
            const noted = await this.publishEnvironmentNote(config, head, plan, generation)
            if (generation !== this.generation) return
            if (!noted) {
                this.scheduleRetry(LIST_NOTE_FAILED)
                return
            }
            if (this.state === 'stopped') return
            this.state = 'up-to-date'
            this.failures = 0
            this.nextTryAt = null
            return
        }

        const hit = await this.scanRange(base, head)
        // Disconnected or switched while scanning: never copy with the old connection.
        if (generation !== this.generation) return
        if (hit) {
            this.holdCopy(
                `Not copied to GitHub: version ${hit.sha.slice(0, 7)} has secret-shaped text (${hit.pattern}) in ${
                    hit.file
                }. Nothing was copied.`
            )
            this.log(`[versions] ${this.message}`)
            return
        }

        this.state = 'copying'
        const result = await this.git(
            ['push', '--porcelain', '--no-verify', config.url, `${head}:refs/heads/${branch}`],
            authEnv(config.url, config.token)
        )
        if (generation !== this.generation) return
        if (result.ok) {
            await runGit(store.dir, ['update-ref', PUSHED_REF, head])
            const noted = await this.publishEnvironmentNote(config, head, plan, generation)
            if (generation !== this.generation) return
            if (!noted) {
                this.scheduleRetry(LIST_NOTE_FAILED)
                return
            }
            this.copyHold = null
            this.state = 'up-to-date'
            this.message = ''
            this.failures = 0
            this.nextTryAt = null
            this.lastCopiedAt = new Date(this.now()).toISOString()
            this.lastCopiedVersion = head.slice(0, 7)
            return
        }
        const failure = classifyFailure(`${result.stderr}\n${result.stdout}`, config.repo, result.timedOut)
        this.log(`[versions] Copy to GitHub ${config.repo} failed (${failure.kind}): ${scrub(result.stderr, config.token)}`)
        if (!failure.retry) {
            this.holdCopy(failure.message)
            return
        }
        this.scheduleRetry(failure.message)
    }

    // Remembers a copy that needs the operator. Later reads must not clear it or try the copy again.
    private holdCopy(message: string): void {
        this.copyHold = message
        this.state = 'stopped'
        this.message = message
        this.nextTryAt = null
    }

    // Prod: reads the newest versions from Dev into INCOMING_REF. It writes nothing to the repository and never
    // changes local main, the work tree, a draft or Live: promoting a version is always a person's choice.
    private async readOnce(plan: ActivePlan): Promise<void> {
        const generation = this.generation
        if (!this.deps.enabled()) return
        const branch = plan.sourceBranch
        if (plan.invalid || !branch) {
            this.state = 'stopped'
            this.message = LIST_UNREADABLE
            this.nextTryAt = null
            return
        }
        let config: ActiveConfig | null
        try {
            config = await this.config()
        } catch (error) {
            this.state = 'stopped'
            this.message = (error as Error).message
            return
        }
        // The file can go bad while the credential is read. Do not fetch main in its place.
        if (!config || generation !== this.generation) return
        if (this.readEnvironment().invalid) {
            this.state = 'stopped'
            this.message = LIST_UNREADABLE
            this.nextTryAt = null
            return
        }
        await this.deps.store().ensure()
        this.state = 'copying'
        const result = await this.git(
            ['fetch', '--no-tags', '--no-recurse-submodules', '--quiet', config.url, `+refs/heads/${branch}:${INCOMING_NEXT_REF}`],
            authEnv(config.url, config.token)
        )
        const dir = this.deps.store().dir
        const drop = (ref: string) => runGit(dir, ['update-ref', '-d', ref]).catch(() => undefined)
        if (generation !== this.generation) {
            await drop(INCOMING_NEXT_REF)
            return
        }
        const failure = result.ok ? null : classifyReadFailure(`${result.stderr}\n${result.stdout}`, config.repo, result.timedOut)
        if (!failure) {
            const next = await runGit(dir, ['rev-parse', '--verify', '-q', `${INCOMING_NEXT_REF}^{commit}`]).catch(() => null)
            const sha = next?.stdout.trim()
            if (sha) {
                const note = await this.environmentNoteCheck(config, sha, plan, generation)
                if (generation !== this.generation) {
                    await drop(INCOMING_NEXT_REF)
                    return
                }
                // A transport error retries. A notes ref with no note for this tip, or a different list, does not
                // install the new versions and does not drop versions that were already accepted.
                if (note.kind === 'transport') {
                    await drop(INCOMING_NEXT_REF)
                    this.scheduleRetry(note.message, true)
                    return
                }
                const namedReader = !isLegacyChain(plan.environments)
                // A matching note installs this tip, including one published after the connect listing.
                // A later environment never installs a tip whose note is missing or a different list.
                // The saved Dev and Prod pair still offers versions when the repository has no record at all.
                if ((namedReader && note.kind !== 'match') || note.kind === 'mismatch' || note.kind === 'unverified') {
                    await drop(INCOMING_NEXT_REF)
                    this.state = 'stopped'
                    this.message = note.kind === 'mismatch' ? LIST_MISMATCH : LIST_UNVERIFIED
                    this.nextTryAt = null
                    this.schedule(this.deps.checkEveryMs ?? DEFAULT_CHECK_EVERY_MS)
                    return
                }
                await runGit(dir, ['update-ref', INCOMING_REF, sha])
            }
            await drop(INCOMING_NEXT_REF)
            // Disconnect may have run while the ref moved: it never leaves a read behind.
            if (generation !== this.generation) {
                await drop(INCOMING_REF)
                return
            }
        } else if (failure.kind === 'empty') {
            // No versions from Dev any more (for example the repository was emptied): nothing is offered.
            await drop(INCOMING_NEXT_REF)
            await drop(INCOMING_REF)
            if (generation !== this.generation) return
        }
        if (!failure || failure.kind === 'empty') {
            this.state = 'up-to-date'
            this.message = ''
            this.failures = 0
            this.nextTryAt = null
            this.lastCheckedAt = new Date(this.now()).toISOString()
            this.schedule(this.deps.checkEveryMs ?? DEFAULT_CHECK_EVERY_MS)
            return
        }
        this.log(`[versions] Reading GitHub ${config.repo} failed (${failure.kind}): ${scrub(result.stderr, config.token)}`)
        this.scheduleRetry(failure.message, true)
    }

    // Records this server's list on the copied commit and publishes that note. Fetches and merges any note
    // already on the remote first, so two publishers can both land. True only when this tip's note is on the remote.
    private async publishEnvironmentNote(
        config: ActiveConfig,
        head: string | null,
        plan: ActivePlan,
        generation: number
    ): Promise<boolean> {
        if (!head) return true
        if (plan.invalid || !plan.environments.length || generation !== this.generation) return false
        const fingerprint = environmentListFingerprint(plan.environments)
        // Done only when this commit and this list were recorded, and the remote note still says so.
        if (this.notedHead === head && this.notedFingerprint === fingerprint && (await this.remoteNoteMatches(config, head, fingerprint))) {
            return true
        }
        const dir = this.deps.store().dir
        for (let attempt = 0; attempt < NOTE_PUSH_ATTEMPTS; attempt++) {
            if (generation !== this.generation) return false
            const fetched = await this.fetchNoteRef(config, NOTE_REMOTE_CACHE)
            if (fetched.kind === 'transport') continue
            if (fetched.kind === 'present' && !(await this.mergeRemoteNotes(dir))) continue
            if (!(await this.writeLocalNote(dir, head, fingerprint))) continue
            if (generation !== this.generation) return false
            const pushed = await this.pushRemoteNotes(config)
            if (pushed === 'ok' && (await this.remoteNoteMatches(config, head, fingerprint))) {
                this.notedHead = head
                this.notedFingerprint = fingerprint
                return true
            }
        }
        this.log(`[versions] Could not record the environment list on ${config.repo}.`)
        return false
    }

    // present: the remote has refs/notes/commits. absent: that ref does not exist. transport: the fetch failed otherwise.
    private async fetchNoteRef(
        config: ActiveConfig,
        destination: string
    ): Promise<{ kind: 'present' } | { kind: 'absent' } | { kind: 'transport'; message: string }> {
        const dir = this.deps.store().dir
        await runGit(dir, ['update-ref', '-d', destination]).catch(() => undefined)
        const result = await this.git(
            ['fetch', '--no-tags', '--no-recurse-submodules', '--quiet', config.url, `${ENVIRONMENT_NOTE_REMOTE}:${destination}`],
            authEnv(config.url, config.token)
        )
        if (result.ok) return { kind: 'present' }
        const failure = classifyReadFailure(`${result.stderr}\n${result.stdout}`, config.repo, result.timedOut)
        if (failure.kind === 'empty') return { kind: 'absent' }
        return { kind: 'transport', message: failure.message }
    }

    private async mergeRemoteNotes(dir: string): Promise<boolean> {
        try {
            await runGit(dir, ['notes', 'merge', '-q', '-s', 'cat_sort_uniq', NOTE_REMOTE_CACHE], NOTE_ENV)
            return true
        } catch (error) {
            await runGit(dir, ['notes', 'merge', '--abort']).catch(() => undefined)
            this.log(`[versions] Could not combine environment lists: ${scrub((error as Error)?.message || String(error))}`)
            return false
        }
    }

    private async writeLocalNote(dir: string, head: string, fingerprint: string): Promise<boolean> {
        try {
            let existing = ''
            try {
                existing = (await runGit(dir, ['notes', 'show', head])).stdout.trim()
            } catch {
                existing = ''
            }
            if (existing !== fingerprint) await runGit(dir, ['notes', 'add', '-f', '-m', fingerprint, head], NOTE_ENV)
            return true
        } catch (error) {
            this.log(`[versions] Could not record the environment list: ${scrub((error as Error)?.message || String(error))}`)
            return false
        }
    }

    private async pushRemoteNotes(config: ActiveConfig): Promise<'ok' | 'rejected' | 'error'> {
        const result = await this.git(
            ['push', '--porcelain', '--no-verify', config.url, `${ENVIRONMENT_NOTE_REMOTE}:${ENVIRONMENT_NOTE_REMOTE}`],
            authEnv(config.url, config.token)
        )
        if (result.ok) return 'ok'
        const text = `${result.stderr}\n${result.stdout}`.toLowerCase()
        if (
            text.includes('non-fast-forward') ||
            text.includes(['fetch', 'first'].join(' ')) ||
            text.includes('[rejected]') ||
            text.includes('updates were rejected')
        ) {
            return 'rejected'
        }
        this.log(`[versions] Could not publish the environment list: ${scrub(result.stderr, config.token)}`)
        return 'error'
    }

    // Reads the note back from the remote, so a push that did not land this tip is not treated as done.
    private async remoteNoteMatches(config: ActiveConfig, head: string, fingerprint: string): Promise<boolean> {
        const fetched = await this.fetchNoteRef(config, NOTE_REMOTE_CACHE)
        if (fetched.kind !== 'present') return false
        try {
            const note = (await runGit(this.deps.store().dir, ['notes', '--ref=remote-list', 'show', head])).stdout.trim()
            return note === fingerprint
        } catch {
            return false
        }
    }

    // match: the note equals this server's list. absent: the remote has no notes ref at all (the one fail-open window).
    // unverified: the notes ref exists but this tip has no note. mismatch: the note is a different list.
    // transport: the notes fetch failed for a reason other than a missing notes ref.
    private async environmentNoteCheck(
        config: ActiveConfig,
        sha: string,
        plan: ActivePlan,
        generation: number
    ): Promise<{ kind: 'match' | 'mismatch' | 'unverified' | 'absent' } | { kind: 'transport'; message: string }> {
        if (plan.invalid || !plan.environments.length || generation !== this.generation) {
            return { kind: 'transport', message: LIST_UNREADABLE }
        }
        const fetched = await this.fetchNoteRef(config, ENVIRONMENT_NOTE_LOCAL)
        if (fetched.kind === 'absent') return { kind: 'absent' }
        if (fetched.kind === 'transport') return fetched
        let note = ''
        try {
            note = (await runGit(this.deps.store().dir, ['notes', '--ref=environment-list', 'show', sha])).stdout.trim()
        } catch {
            return { kind: 'unverified' }
        }
        if (!note) return { kind: 'unverified' }
        return note === environmentListFingerprint(plan.environments) ? { kind: 'match' } : { kind: 'mismatch' }
    }

    private scheduleRetry(reason: string, reading = this.readOnly()): void {
        const waits = this.deps.retryMs?.length ? this.deps.retryMs : DEFAULT_RETRY_MS
        const wait = waits[Math.min(this.failures, waits.length - 1)]
        this.failures += 1
        this.state = 'retrying'
        this.nextTryAt = this.now() + wait
        this.message = reading
            ? `${reason} Live flows keep working. Cuttlely tries again on its own.`
            : `${reason} Publishing keeps working. Cuttlely tries again on its own.`
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => {
            this.timer = null
            void this.sync()
        }, wait)
        if (typeof this.timer.unref === 'function') this.timer.unref()
    }

    // The commits about to be copied, checked with the same patterns as a commit: the lines each one adds,
    // and its title, trailers and author (a deleted flow's name, for example, is only in its title).
    // git's output is read line by line as it streams, so a long history or a large flow never fills a buffer.
    // Every pattern matches within one line, so a line-by-line check finds what a whole-file check would.
    private scanRange(base: string | null, head: string): Promise<{ sha: string; file: string; pattern: string } | null> {
        const dir = this.deps.store().dir
        return new Promise((resolve, reject) => {
            const child = spawn(
                'git',
                [
                    '-c',
                    'core.quotepath=false',
                    'log',
                    '-p',
                    '--no-color',
                    '--no-ext-diff',
                    '--format=%x00commit %H%n%an <%ae>%n%cn <%ce>%n%B%x00end',
                    base ? `${base}..${head}` : head
                ],
                { cwd: dir, env: gitEnv(dir), stdio: ['ignore', 'pipe', 'pipe'] }
            )
            let done = false
            let sha = ''
            let inMeta = false
            let inHeader = false
            let file = ''
            let stderr = ''
            const finish = (hit: { sha: string; file: string; pattern: string } | null, error?: Error) => {
                if (done) return
                done = true
                lines.close()
                if (child.exitCode === null) child.kill()
                if (error) reject(error)
                else resolve(hit)
            }
            const check = (text: string, name: string) => {
                const hits = scanForSecrets({ [name]: text })
                if (hits.length) finish({ sha, file: name === 'message' ? 'its title or details' : name, pattern: hits[0].pattern })
            }
            const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
            lines.on('line', (line) => {
                if (done) return
                if (line.startsWith('\u0000commit ')) {
                    sha = line.slice('\u0000commit '.length).trim()
                    inMeta = true
                    inHeader = false
                    file = ''
                    return
                }
                if (inMeta) {
                    const end = line.indexOf('\u0000end')
                    if (end >= 0) inMeta = false
                    check(end >= 0 ? line.slice(0, end) : line, 'message')
                    return
                }
                // File headers sit between "diff --git" and the first "@@". After that, every "+" line is
                // added content, even one that starts with "+++".
                if (line.startsWith('diff --git ')) {
                    inHeader = true
                    file = ''
                    return
                }
                if (inHeader) {
                    if (line.startsWith('@@')) inHeader = false
                    else if (line.startsWith('+++ ')) file = line.replace(/^\+\+\+ (b\/)?/, '')
                    return
                }
                if (line.startsWith('+') && file) check(line.slice(1), file)
            })
            child.stderr.on('data', (chunk) => {
                if (stderr.length < 4000) stderr += String(chunk)
            })
            child.on('error', (error) => finish(null, error))
            child.on('close', (code) => {
                if (done) return
                // Let readline hand over the last lines before deciding.
                setImmediate(() => {
                    if (code === 0) finish(null)
                    else finish(null, new Error(`git log exited ${code}: ${stderr.trim().slice(0, 300)}`))
                })
            })
        })
    }
}
