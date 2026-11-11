import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EtlError } from './errors.mjs'

const run = promisify(execFile)

export const HTTPS_ONLY = 'Code Repository clones https URLs only.'
export const PRIVATE_ADDRESS = 'Code Repository does not clone from loopback or private addresses.'
export const SSH_HINT = 'Use the https address of the repository. SSH URLs are not cloned.'
export const NOT_A_GIT_URL = 'This is not a git URL.'
export const CREDENTIALS_HINT = 'Do not put a username or password in the Git URL.'
export const GITHUB_PAGE_HINT = 'This GitHub page cannot be cloned. Use the repository URL, or a folder or file link (/tree/ or /blob/).'
export const MISSING_BRANCH_HINT = 'This GitHub link is missing a branch.'
export const TRAVERSAL_HINT = 'The folder in this URL is not a path inside the repository.'
export const SLASH_BRANCH_HINT =
    'No branch in this repository matches the link. Check the link, or fill in Branch when its name contains slashes.'
export const LIST_REFS_HINT =
    'Could not list branches for this repository. Set the Branch field, or check that the URL is a public https repository.'
export const WEB_PAGE_HINT = 'Use a git repository URL, not a web page. GitHub folder and file links are supported.'

const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd])/i
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])
function bad(hint) {
    return { ok: false, hint }
}

function decodePath(value) {
    try {
        return decodeURIComponent(value)
    } catch {
        return null
    }
}

export function safeSubPath(raw) {
    const decoded = decodePath(String(raw || '').trim())
    if (decoded == null) throw new EtlError('bad_source', TRAVERSAL_HINT)
    return normalizeSubPath(decoded)
}

function normalizeSubPath(value) {
    if (!value) return ''
    const normalized = String(value).replace(/\\/g, '/')
    if (normalized.includes('\0') || normalized.startsWith('/') || normalized.startsWith('//')) {
        throw new EtlError('bad_source', TRAVERSAL_HINT)
    }
    const parts = []
    for (const part of normalized.split('/')) {
        if (!part || part === '.') continue
        if (part === '..') throw new EtlError('bad_source', TRAVERSAL_HINT)
        parts.push(part)
    }
    return parts.join('/')
}

export function inspectGitUrl(raw) {
    const text = String(raw || '').trim()
    if (!text) return bad('')
    if (/^(git@|ssh:\/\/|git\+ssh:\/\/)/i.test(text)) return bad(SSH_HINT)

    let parsed
    try {
        parsed = new URL(text)
    } catch {
        return bad(`"${text}" is not a git URL.`)
    }

    if (parsed.protocol !== 'https:') return bad(HTTPS_ONLY)
    if (parsed.username || parsed.password) return bad(CREDENTIALS_HINT)
    const host = parsed.hostname
    if (PRIVATE_HOST.test(host)) return bad(PRIVATE_ADDRESS)

    const pathDecoded = decodePath(parsed.pathname || '')
    if (pathDecoded == null) return bad(NOT_A_GIT_URL)
    const segments = pathDecoded.split('/').filter(Boolean)

    if (GITHUB_HOSTS.has(host.toLowerCase())) {
        return inspectGithub(segments, parsed)
    }

    if (segments.includes('tree') || segments.includes('blob')) return bad(WEB_PAGE_HINT)

    return { ok: true, hint: '', kind: 'repo', cloneUrl: parsed.toString(), rest: '', subPath: '' }
}

function inspectGithub(segments) {
    if (segments.length < 2) return bad(GITHUB_PAGE_HINT)
    const owner = segments[0]
    const repo = segments[1].replace(/\.git$/i, '')
    if (!owner || !repo || owner === '..' || repo === '..' || owner.includes('\\') || repo.includes('\\')) {
        return bad(GITHUB_PAGE_HINT)
    }
    const cloneUrl = `https://github.com/${owner}/${repo}.git`
    if (segments.length === 2) {
        return { ok: true, hint: '', kind: 'repo', cloneUrl, rest: '', subPath: '' }
    }
    const page = segments[2]
    if (page !== 'tree' && page !== 'blob') return bad(GITHUB_PAGE_HINT)
    const restParts = segments.slice(3)
    if (!restParts.length) return bad(MISSING_BRANCH_HINT)
    try {
        // inspectGitUrl decoded the URL pathname before splitting it. Validate that text without decoding it again,
        // so a literal percent escape in a repository filename keeps its exact name.
        for (const part of restParts) normalizeSubPath(part)
        const rest = normalizeSubPath(restParts.join('/'))
        if (!rest) return bad(MISSING_BRANCH_HINT)
        return { ok: true, hint: '', kind: page, cloneUrl, rest, subPath: '' }
    } catch (error) {
        if (error instanceof EtlError) return bad(error.message)
        throw error
    }
}

export function gitUrlHint(raw) {
    const text = String(raw || '').trim()
    if (!text) return ''
    return inspectGitUrl(text).hint
}

export function parseRemoteRefs(stdout) {
    const refs = new Set()
    for (const line of String(stdout || '').split('\n')) {
        const tab = line.indexOf('\t')
        if (tab === -1) continue
        let ref = line.slice(tab + 1).trim()
        if (ref.endsWith('^{}')) ref = ref.slice(0, -3)
        if (ref.startsWith('refs/heads/')) refs.add(ref.slice('refs/heads/'.length))
        else if (ref.startsWith('refs/tags/')) refs.add(ref.slice('refs/tags/'.length))
    }
    return refs
}

export function resolveRest(rest, { branch = '', refs = null, decoded = false } = {}) {
    const path = decoded ? normalizeSubPath(rest) : safeSubPath(rest)
    if (!path) throw new EtlError('bad_source', MISSING_BRANCH_HINT)
    const segments = path.split('/')
    const chosen = String(branch || '').trim()
    if (chosen) {
        if (chosen.startsWith('-')) throw new EtlError('bad_source', `Branch "${chosen}" is not a branch name.`)
        if (refs) {
            const match = longestRefPrefix(segments, refs)
            if (match) return { branch: chosen, subPath: match.subPath }
            throw new EtlError('bad_source', SLASH_BRANCH_HINT)
        }
        const prefix = normalizeSubPath(chosen).split('/').filter(Boolean)
        if (prefix.length && startsWithSegments(segments, prefix)) {
            return { branch: chosen, subPath: segments.slice(prefix.length).join('/') }
        }
        return { branch: chosen, subPath: segments.slice(1).join('/') }
    }
    if (refs && refs.size) {
        const match = longestRefPrefix(segments, refs)
        if (match) return match
        throw new EtlError('bad_source', SLASH_BRANCH_HINT)
    }
    if (refs && refs.size === 0) throw new EtlError('bad_source', SLASH_BRANCH_HINT)
    if (segments.length === 1) return { branch: segments[0], subPath: '' }
    return { branch: segments[0], subPath: segments.slice(1).join('/') }
}

function startsWithSegments(segments, prefix) {
    if (prefix.length > segments.length) return false
    return prefix.every((part, i) => segments[i] === part)
}

function longestRefPrefix(segments, refs) {
    for (let n = segments.length; n >= 1; n -= 1) {
        const name = segments.slice(0, n).join('/')
        if (refs.has(name)) return { branch: name, subPath: segments.slice(n).join('/') }
    }
    return null
}

export async function listRemoteRefs(url, runGit = run) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    const { stdout } = await runGit('git', ['ls-remote', '--heads', '--tags', '--', url], { env, timeout: 120000 })
    return parseRemoteRefs(stdout)
}

export async function resolveGitSource({ gitUrl, branch = '', listRefs } = {}) {
    const inspected = inspectGitUrl(gitUrl)
    if (!inspected.ok) throw new EtlError('bad_source', inspected.hint || NOT_A_GIT_URL)
    if (inspected.kind === 'repo') {
        const chosen = String(branch || '').trim()
        if (chosen.startsWith('-')) throw new EtlError('bad_source', `Branch "${chosen}" is not a branch name.`)
        return { cloneUrl: inspected.cloneUrl, branch: chosen, subPath: '', kind: 'repo' }
    }
    const chosen = String(branch || '').trim()
    if (chosen.startsWith('-')) throw new EtlError('bad_source', `Branch "${chosen}" is not a branch name.`)
    let refs = null
    // A slash can belong to the link's branch or its selected path. Resolve the link's longest
    // remote ref first, even when Branch is a matching prefix, then apply Branch as an override.
    const needsRefs = inspected.rest.includes('/')
    if (needsRefs) {
        try {
            refs = await (listRefs || listRemoteRefs)(inspected.cloneUrl)
        } catch {
            throw new EtlError('bad_source', LIST_REFS_HINT)
        }
    }
    const resolved = resolveRest(inspected.rest, { branch: chosen, refs, decoded: true })
    if (inspected.kind === 'blob' && !resolved.subPath) {
        throw new EtlError('bad_source', 'This file link is missing a path inside the repository.')
    }
    return { cloneUrl: inspected.cloneUrl, branch: resolved.branch, subPath: resolved.subPath, kind: inspected.kind }
}
