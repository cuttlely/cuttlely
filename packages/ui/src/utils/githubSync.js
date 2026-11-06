// Plain-words helpers for the Version History settings page: the GitHub copy and the Dev or Prod label.
// No Git words on screen: versions are "synced" or "copied", never pushed or committed.
import { isSavedDevProdPair } from './promote'

export const OWNER_PERMISSION = 'server:owner'
export const TOKEN_HELP_URL = 'https://github.com/settings/personal-access-tokens/new'
// The guide section that says which token to make, and why.
export const TOKEN_GUIDE_URL = 'https://github.com/cuttlely/cuttlely/blob/main/docs/how-to/versioning.md#which-github-token-to-use'
export const DEFAULT_GITHUB_HOST = 'github.com'

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const HOST_ERROR = 'Enter a GitHub host such as github.com or github.example.com. Use https, and do not include a path, user or password.'

// The same host rules as packages/versioning/src/githubHost.ts. The server checks again on every request.
export const githubHostInput = (input = '') => {
    const raw = String(input ?? '').trim()
    const github = {
        host: DEFAULT_GITHUB_HOST,
        kind: 'github.com',
        apiBase: 'https://api.github.com',
        gitOrigin: 'https://github.com'
    }
    if (!raw || raw.toLowerCase() === 'github.com' || raw.toLowerCase() === 'www.github.com') return github
    if (/[\u0000-\u0020\u007f\\]/.test(raw) || raw.includes('@') || raw.includes('?') || raw.includes('#')) return { error: HOST_ERROR }
    let candidate = raw
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `https://${candidate}`
    let url
    try {
        url = new URL(candidate)
    } catch {
        return { error: HOST_ERROR }
    }
    if (url.protocol !== 'https:') return { error: 'A GitHub host has to start with https. http is not used.' }
    if (url.username || url.password) return { error: 'A GitHub host cannot include a username or password.' }
    if (url.search || url.hash) return { error: HOST_ERROR }
    if (url.pathname !== '/' && url.pathname !== '') return { error: 'Enter only the GitHub host, not a repository path.' }
    let hostname = url.hostname.toLowerCase()
    while (hostname.endsWith('.')) hostname = hostname.slice(0, -1)
    if (!hostname || hostname.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
        return { error: 'Enter a host name, not an IP address.' }
    }
    if (
        hostname === 'localhost' ||
        hostname === 'ip6-localhost' ||
        hostname === 'metadata.google.internal' ||
        hostname.endsWith('.localhost') ||
        hostname.endsWith('.local')
    ) {
        return { error: "That GitHub host is blocked by this server's outbound policy." }
    }
    const port = url.port
    if (hostname === 'github.com' || hostname === 'www.github.com') {
        if (port) return { error: 'github.com does not use a custom port.' }
        return github
    }
    if (hostname === 'api.github.com') return { error: 'Enter github.com. Cuttlely calls api.github.com on its own.' }
    const labels = hostname.split('.')
    if (hostname.length > 253 || labels.length < 2 || labels.some((label) => !HOST_LABEL.test(label))) return { error: HOST_ERROR }
    if (hostname.endsWith('.ghe.com')) {
        if (port)
            return { error: 'A ghe.com host does not use a custom port. Enter the host you open in the browser, such as example.ghe.com.' }
        if (labels.length !== 3 || labels[0] === 'api' || labels[0] === 'www') {
            return { error: 'Enter the GitHub Enterprise Cloud host you open in the browser, such as example.ghe.com.' }
        }
        return { host: hostname, kind: 'ghe.com', apiBase: `https://api.${hostname}`, gitOrigin: `https://${hostname}` }
    }
    const host = port ? `${hostname}:${port}` : hostname
    return { host, kind: 'enterprise-server', apiBase: `https://${host}/api/v3`, gitOrigin: `https://${host}` }
}

export const githubHostHelp = (input = '') => {
    const parsed = githubHostInput(input)
    if (parsed.error) return parsed.error
    if (parsed.kind === 'ghe.com') {
        return `Repository calls use ${parsed.gitOrigin}. The API uses ${parsed.apiBase}. Create the token on this host, not on github.com.`
    }
    if (parsed.kind === 'enterprise-server') {
        return `Repository calls use ${parsed.gitOrigin}. The API uses ${parsed.apiBase}. Create the token on this host, not on github.com. A private-network address is refused.`
    }
    return 'github.com is the default. For GitHub Enterprise, enter the host you open in the browser, such as github.example.com.'
}

// GitHub's fine-grained token page, filled in: a name, a 90-day expiry, and Contents only (Read and write on Dev,
// Read-only on Prod). The person still picks the one repository there; GitHub adds Metadata (Read-only) on its own.
// A custom host opens that host's token page. The query string is only added for github.com.
export const tokenCreateUrl = (reading = false, hostInput = '') => {
    const parsed = githubHostInput(hostInput)
    if (parsed.error || parsed.kind !== 'github.com') {
        if (parsed.error || !parsed.gitOrigin) return TOKEN_HELP_URL
        return `${parsed.gitOrigin}/settings/tokens`
    }
    const params = new URLSearchParams({
        name: 'Cuttlely version history',
        description: reading ? 'Cuttlely Prod reads published flow versions' : 'Cuttlely copies flow versions to this repository',
        expires_in: '90',
        contents: reading ? 'read' : 'write'
    })
    return `${TOKEN_HELP_URL}?${params.toString()}`
}

// What to pick on GitHub's token page, line by line, in the words that page uses.
export const tokenHelp = (reading = false, from = '', hostInput = '') => {
    const parsed = githubHostInput(hostInput)
    const enterprise = !parsed.error && parsed.kind !== 'github.com'
    return {
        title: 'Which token to use',
        rows: [
            {
                label: 'Token type',
                value: enterprise ? 'Personal access token on this host' : 'Fine-grained'
            },
            { label: 'Repository access', value: 'Only select repositories, then just the one for Cuttlely' },
            {
                label: 'Permissions',
                value: reading ? 'Contents: Read-only. Nothing else.' : 'Contents: Read and write. Nothing else.',
                hint: 'GitHub adds Metadata: Read-only on its own.'
            },
            {
                label: 'Expiration',
                value: '90 days, or a date you choose',
                hint: 'When it runs out, paste a new token into the saved sign-in in Credentials.'
            }
        ],
        // `from` is the previous environment. A server that reads, including one that also copies, uses that repository.
        note: enterprise
            ? `Create the token on ${parsed.host}, not on github.com. On GitHub Enterprise Server, the usual token is a personal access token with the repo scope. Fine-grained tokens, when that host offers them, need Contents read and write on the one repository. A saved sign-in for a different host is not reused.`
            : from || reading
            ? `Pick the repository your ${
                  from || 'Dev'
              } server copies to. The link below fills in the name, expiry and Contents. You pick the repository.`
            : 'Create the empty private repository on GitHub first, so you can pick it there. The link below fills in the name, expiry and Contents. You pick the repository.'
    }
}

// The short line under the token box.
export const tokenHint = (reading = false, hostInput = '') => {
    const parsed = githubHostInput(hostInput)
    if (!parsed.error && parsed.kind !== 'github.com') {
        return reading
            ? `Use a token issued by ${parsed.host} that can read that one repository. It is saved in Credentials and is not sent to github.com.`
            : `Use a token issued by ${parsed.host} that can read and write that one repository. It is saved in Credentials and is not sent to github.com.`
    }
    return reading
        ? 'Use a fine-grained token for just that one repository, with Contents set to Read-only. It is saved in Credentials.'
        : 'Use a fine-grained token for just one repository, with Contents set to Read and write. It is saved in Credentials.'
}
export const DEFAULT_REPO_NAME = 'cuttlely-flows'
export const NEW_TOKEN = '__new__'

// The chip on the card for each state the server reports.
export const statusChip = (status) => {
    const state = status?.state
    if (state === 'off') return { label: 'History off', color: 'default', tone: 'muted' }
    if (!status?.connected) return { label: 'Not connected', color: 'default', tone: 'muted' }
    if (state === 'up-to-date') return { label: 'Up to date', color: 'success', tone: 'ok' }
    if (state === 'copying') return { label: 'Syncing', color: 'info', tone: 'busy' }
    if (state === 'waiting') return { label: 'Syncing soon', color: 'info', tone: 'busy' }
    if (state === 'retrying') return { label: 'Retrying', color: 'warning', tone: 'warn' }
    if (state === 'stopped') return { label: 'Needs attention', color: 'error', tone: 'error' }
    return { label: 'Connected', color: 'success', tone: 'ok' }
}

// Poll faster while something is moving.
export const pollMs = (status) => (['copying', 'waiting', 'retrying'].includes(status?.state) ? 3000 : 15000)

// "just now", "2 minutes ago", "3 hours ago", "on Oct 8".
export const timeAgo = (iso, now = Date.now()) => {
    if (!iso) return ''
    const then = new Date(iso).getTime()
    if (Number.isNaN(then)) return ''
    const seconds = Math.max(0, Math.round((now - then) / 1000))
    if (seconds < 45) return 'just now'
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
    return `on ${new Date(then).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

// "Retrying in 2 minutes".
export const retryIn = (iso, now = Date.now()) => {
    if (!iso) return ''
    const seconds = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000))
    if (seconds < 60) return 'Trying again in a few seconds'
    const minutes = Math.round(seconds / 60)
    return `Trying again in ${minutes} minute${minutes === 1 ? '' : 's'}`
}

// The line under the repository name.
export const syncLine = (status, now = Date.now()) => {
    if (!status?.connected) return ''
    if (status.state === 'up-to-date')
        return status.lastCopiedAt ? `Last synced ${timeAgo(status.lastCopiedAt, now)}` : 'Every version is on GitHub'
    if (status.state === 'copying') return 'Syncing your versions now'
    if (status.state === 'waiting') return status.waiting === 1 ? '1 new version syncs in a moment' : 'New versions sync in a moment'
    if (status.state === 'retrying') return retryIn(status.nextTryAt, now)
    return ''
}

// The repository list, filtered by what was typed, empty ones first.
export const filterRepos = (repos = [], query = '') => {
    const text = String(query || '')
        .trim()
        .toLowerCase()
    const list = text ? repos.filter((r) => r.repo.toLowerCase().includes(text)) : repos.slice()
    return list.sort((a, b) => Number(b.empty) - Number(a.empty))
}

// A new repository name, or an error to show under the box.
export const checkRepoName = (name) => {
    const value = String(name || '').trim()
    if (!value) return { error: 'Give the new repository a name.' }
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(value) || value === '.' || value === '..') {
        return { error: 'Use letters, numbers, dots, dashes or underscores.' }
    }
    return { name: value }
}

const SAVED_PAIR_HINT = 'Dev copies its published versions to GitHub. Prod reads them from there, and you choose what to promote to Live.'

export const UNREADABLE_LIST = 'The environment list could not be read. Save it again.'
export const LIST_UNREADABLE_CODE = 'LIST_UNREADABLE'

// The environment file only. A connection file that cannot be read uses a different sentence and a different code.
export const listUnreadable = (status) => status?.code === LIST_UNREADABLE_CODE || status?.message === UNREADABLE_LIST

// The saved pair: both publish names match, and the names are dev and prod. A capitalized name is a different list.
export const SAVED_REPAIR_ROWS = [
    { name: 'dev', branch: 'main', server: 'dev' },
    { name: 'prod', branch: 'main', server: 'prod' }
]

// The full list a repair save sends. This server's identity is required. Null is never sent.
export const repairListBody = (rows, environment) => {
    const environments = (Array.isArray(rows) ? rows : []).map((row) => ({
        name: String(row?.name || '').trim(),
        branch: String(row?.branch || '').trim(),
        server: String(row?.server || '').trim()
    }))
    if (!environment || !environments.some((item) => item.server === environment)) {
        return { error: 'Pick which row is this server.' }
    }
    return { environment, environments }
}

const environmentLabel = (env) => {
    const name = String(env?.name || '')
    if (name.toLowerCase() === 'dev') return 'Dev'
    if (name.toLowerCase() === 'prod') return 'Prod'
    return name
}

// What each environment does, from the list this server saved. The saved Dev and Prod pair keeps its sentence.
export const environmentHint = (environments) => {
    const chain = Array.isArray(environments) ? environments : []
    if (!chain.length) return ''
    if (chain.length < 2 || isSavedDevProdPair(chain)) return SAVED_PAIR_HINT
    return (
        chain
            .map((env, index) => {
                if (index === 0) return `${environmentLabel(env)} copies its published versions`
                const previous = environmentLabel(chain[index - 1])
                if (index === chain.length - 1) return `${environmentLabel(env)} reads ${previous}, and you choose what to promote to Live`
                return `${environmentLabel(env)} reads ${previous} and copies what it publishes`
            })
            .join('. ') + '.'
    )
}

// Shown while GitHub is connected. Names the neighbors, then the disconnect rule.
export const environmentSwitchNote = (status) => {
    const chain = status?.environments || []
    const index = chain.findIndex((item) => item.server === status?.environment)
    const here = index >= 0 ? chain[index] : null
    const previous = index > 0 ? chain[index - 1] : null
    const next = here && index < chain.length - 1 ? chain[index + 1] : null
    const place =
        here && previous && next
            ? `${environmentLabel(here)} reads ${environmentLabel(previous)}, and ${environmentLabel(next)} reads ${environmentLabel(
                  here
              )}. `
            : here && previous
            ? `${environmentLabel(here)} reads ${environmentLabel(previous)}. `
            : here && next
            ? `${environmentLabel(next)} reads ${environmentLabel(here)}. `
            : ''
    return `${place}Disconnect GitHub before changing what this server reads or copies.`
}

// Saved GitHub sign-ins the copy can use: this workspace's own, not ones shared in from another workspace.
export const ownCredentials = (list) => (Array.isArray(list) ? list.filter((c) => c && !c.shared) : [])
