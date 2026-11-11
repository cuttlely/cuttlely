// Keep these checks in sync with packages/etl/git-url.mjs (inspectGitUrl / gitUrlHint).
const HTTPS_ONLY = 'Code Repository clones https URLs only.'
const PRIVATE_ADDRESS = 'Code Repository does not clone from loopback or private addresses.'
const SSH_HINT = 'Use the https address of the repository. SSH URLs are not cloned.'
const CREDENTIALS_HINT = 'Do not put a username or password in the Git URL.'
const GITHUB_PAGE_HINT = 'This GitHub page cannot be cloned. Use the repository URL, or a folder or file link (/tree/ or /blob/).'
const MISSING_BRANCH_HINT = 'This GitHub link is missing a branch.'
const TRAVERSAL_HINT = 'The folder in this URL is not a path inside the repository.'
const WEB_PAGE_HINT = 'Use a git repository URL, not a web page. GitHub folder and file links are supported.'
const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd])/i
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])

function decodePath(value) {
    try {
        return decodeURIComponent(value)
    } catch {
        return null
    }
}

function decodedPathEscapes(value) {
    const normalized = String(value || '').replace(/\\/g, '/')
    if (normalized.includes('\0') || normalized.startsWith('/') || normalized.startsWith('//')) return true
    return normalized.split('/').some((part) => part === '..')
}

export function gitSourceUrlHint(raw) {
    const text = String(raw || '').trim()
    if (!text) return ''
    if (/^(git@|ssh:\/\/|git\+ssh:\/\/)/i.test(text)) return SSH_HINT
    let parsed
    try {
        parsed = new URL(text)
    } catch {
        return `"${text}" is not a git URL.`
    }
    if (parsed.protocol !== 'https:') return HTTPS_ONLY
    if (parsed.username || parsed.password) return CREDENTIALS_HINT
    if (PRIVATE_HOST.test(parsed.hostname)) return PRIVATE_ADDRESS
    const pathDecoded = decodePath(parsed.pathname || '')
    if (pathDecoded == null) return `"${text}" is not a git URL.`
    const segments = pathDecoded.split('/').filter(Boolean)
    if (GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) {
        if (segments.length < 2) return GITHUB_PAGE_HINT
        const owner = segments[0]
        const repo = segments[1].replace(/\.git$/i, '')
        if (!owner || !repo || owner === '..' || repo === '..' || owner.includes('\\') || repo.includes('\\')) return GITHUB_PAGE_HINT
        if (segments.length === 2) return ''
        const page = segments[2]
        if (page !== 'tree' && page !== 'blob') return GITHUB_PAGE_HINT
        const rest = segments.slice(3)
        if (!rest.length) return MISSING_BRANCH_HINT
        // pathDecoded already decoded the URL pathname. Validate that text without decoding it again,
        // matching packages/etl/git-url.mjs so literal percent text keeps its identity.
        if (decodedPathEscapes(rest.join('/'))) return TRAVERSAL_HINT
        return ''
    }
    if (segments.includes('tree') || segments.includes('blob')) return WEB_PAGE_HINT
    return ''
}
