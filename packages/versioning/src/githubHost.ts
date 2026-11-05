// GitHub host for the version-history copy.
//
// github.com is the default. A custom host is the name the owner opens in a browser:
// GitHub Enterprise Cloud with data residency (tenant.ghe.com) or GitHub Enterprise Server
// (any other hostname, including a hostname such as github.example.com). The token is a
// personal access token, not an OAuth grant. It is sent only to the API and Git origins
// derived here.
import { BlockList, isIP } from 'net'
import dns from 'dns/promises'
import http from 'http'
import https from 'https'

export class GithubError extends Error {
    readonly status: number
    constructor(status: number, message: string) {
        super(message)
        this.status = status
    }
}

export type GithubHostKind = 'github.com' | 'ghe.com' | 'enterprise-server'

export interface GithubEndpoint {
    // Normalized host the owner typed, with a non-default port when they set one.
    host: string
    kind: GithubHostKind
    // REST API origin plus path, no trailing slash. github.com uses https://api.github.com.
    // Data residency uses https://api.<tenant>.ghe.com. Enterprise Server uses https://<host>/api/v3.
    apiBase: string
    // Scheme and host for git, no path. https://github.com or https://<host>[:port].
    gitOrigin: string
}

export const GITHUB_COM: GithubEndpoint = {
    host: 'github.com',
    kind: 'github.com',
    apiBase: 'https://api.github.com',
    gitOrigin: 'https://github.com'
}

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const HOST_MESSAGE = 'Enter a GitHub host such as github.com or github.example.com. Use https, and do not include a path, user or password.'

export interface ResolvedAddress {
    address: string
    family: 4 | 6
}

export type HostLookup = (hostname: string) => Promise<ResolvedAddress[]>

// Loopback, unspecified, link-local and metadata stay blocked for this token even when the
// HTTP building-block switch HTTP_ALLOW_LOCALHOST is on. That switch is for flows, not for a
// GitHub credential. Private ranges follow HTTP_SECURITY_CHECK, the same way other outbound
// checks do. There is no private-network exception for a GitHub Enterprise host.
const ALWAYS_BLOCKED = [
    '0.0.0.0/8',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '192.0.0.192/32',
    '100.100.100.200/32',
    '224.0.0.0/4',
    '240.0.0.0/4',
    '255.255.255.255/32',
    '::/128',
    '::1/128',
    'fe80::/10',
    'ff00::/8',
    'fd00:ec2::254/128'
]

const PRIVATE_BLOCKED = ['10.0.0.0/8', '100.64.0.0/10', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7']

const BLOCKED_NAMES = new Set(['localhost', 'ip6-localhost', 'metadata.google.internal'])

function securityCheckOn(): boolean {
    return process.env.HTTP_SECURITY_CHECK !== 'false'
}

function blockedList(): BlockList {
    const list = new BlockList()
    const entries = securityCheckOn() ? ALWAYS_BLOCKED.concat(PRIVATE_BLOCKED) : ALWAYS_BLOCKED.slice()
    for (const entry of entries) addBlock(list, entry, false)
    const custom = String(process.env.HTTP_DENY_LIST || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    for (const entry of custom) addBlock(list, entry, true)
    return list
}

function addBlock(list: BlockList, entry: string, optional: boolean): void {
    try {
        if (entry.includes('/')) {
            const slash = entry.lastIndexOf('/')
            const base = entry.slice(0, slash)
            const prefix = Number(entry.slice(slash + 1))
            const family = isIP(base)
            if ((family === 4 || family === 6) && Number.isInteger(prefix)) {
                list.addSubnet(base, prefix, family === 4 ? 'ipv4' : 'ipv6')
            } else if (!optional) {
                throw new Error(`bad block ${entry}`)
            }
            return
        }
        const family = isIP(entry)
        if (family === 4) list.addAddress(entry, 'ipv4')
        else if (family === 6) list.addAddress(entry, 'ipv6')
        else if (!optional) throw new Error(`bad block ${entry}`)
    } catch (error) {
        if (!optional) throw error
    }
}

function normalizeName(name: string): string {
    const lower = name.toLowerCase()
    let end = lower.length
    while (end > 0 && lower.charCodeAt(end - 1) === 0x2e) end--
    return lower.slice(0, end)
}

function blockedName(hostname: string): boolean {
    const name = normalizeName(hostname)
    if (!name || BLOCKED_NAMES.has(name) || name.endsWith('.localhost') || name.endsWith('.local')) return true
    const custom = String(process.env.HTTP_DENY_LIST || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    return custom.some((entry) => !entry.includes('/') && isIP(entry) === 0 && normalizeName(entry) === name)
}

function mappedV4(address: string): string | null {
    const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
    if (!match || isIP(match[1]) !== 4) return null
    return match[1]
}

export function addressBlocked(address: string): boolean {
    const mapped = mappedV4(address)
    const check = mapped || address
    const family = isIP(check)
    if (family !== 4 && family !== 6) return true
    return blockedList().check(check, family === 4 ? 'ipv4' : 'ipv6')
}

function reject(message: string): never {
    throw new GithubError(400, message)
}

function validHostname(hostname: string): boolean {
    if (!hostname || hostname.length > 253 || hostname.includes(':')) return false
    const labels = hostname.split('.')
    if (labels.length < 2) return false
    return labels.every((label) => HOST_LABEL.test(label))
}

// Empty, github.com and www.github.com are the public default. Anything else is an enterprise host.
export function githubEndpoint(input: unknown): GithubEndpoint {
    const raw = String(input ?? '').trim()
    if (!raw) return GITHUB_COM
    if (/[\u0000-\u0020\u007f\\]/.test(raw) || raw.includes('@') || raw.includes('?') || raw.includes('#')) reject(HOST_MESSAGE)
    let candidate = raw
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `https://${candidate}`
    let url: URL
    try {
        url = new URL(candidate)
    } catch {
        reject(HOST_MESSAGE)
    }
    if (url.protocol !== 'https:') reject('A GitHub host has to start with https. http is not used.')
    if (url.username || url.password) reject('A GitHub host cannot include a username or password.')
    if (url.search || url.hash) reject(HOST_MESSAGE)
    if (url.pathname !== '/' && url.pathname !== '') reject('Enter only the GitHub host, not a repository path.')
    const hostname = normalizeName(url.hostname)
    if (!hostname || isIP(hostname)) reject('Enter a host name, not an IP address.')
    if (blockedName(hostname)) reject('That GitHub host is blocked by the outbound policy.')
    const port = url.port
    if (hostname === 'github.com' || hostname === 'www.github.com') {
        if (port) reject('github.com does not use a custom port.')
        return GITHUB_COM
    }
    if (hostname === 'api.github.com') reject('Enter github.com. Cuttlely calls api.github.com on its own.')
    if (!validHostname(hostname)) reject(HOST_MESSAGE)
    if (hostname.endsWith('.ghe.com')) {
        if (port) reject('A ghe.com host does not use a custom port. Enter the host you open in the browser, such as example.ghe.com.')
        const labels = hostname.split('.')
        if (labels.length !== 3 || labels[0] === 'api' || labels[0] === 'www') {
            reject('Enter the GitHub Enterprise Cloud host you open in the browser, such as example.ghe.com.')
        }
        return { host: hostname, kind: 'ghe.com', apiBase: `https://api.${hostname}`, gitOrigin: `https://${hostname}` }
    }
    const host = port ? `${hostname}:${port}` : hostname
    return { host, kind: 'enterprise-server', apiBase: `https://${host}/api/v3`, gitOrigin: `https://${host}` }
}

export function endpointAllows(url: string, endpoint: GithubEndpoint): boolean {
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        return false
    }
    if (parsed.username || parsed.password || parsed.hash) return false
    if (endpoint.kind === 'github.com') {
        return parsed.origin === 'https://github.com' || parsed.origin === 'https://api.github.com' || standInOrigin(parsed.origin)
    }
    if (parsed.protocol !== 'https:') return false
    const apiOrigin = new URL(endpoint.apiBase).origin
    return parsed.origin === endpoint.gitOrigin || parsed.origin === apiOrigin
}

function standInOrigin(origin: string): boolean {
    const test = String(process.env.CUTTLELY_GITHUB_TEST_API || '').trim()
    const root = String(process.env.CUTTLELY_GITHUB_TEST_ROOT || '').trim()
    const allowed = ['on', 'true', '1', 'yes'].includes(
        String(process.env.CUTTLELY_GITHUB_ALLOW_FILE_REMOTES || '')
            .trim()
            .toLowerCase()
    )
    if (!test || !root || !allowed) return false
    try {
        return origin === new URL(test).origin
    } catch {
        return false
    }
}

export async function resolveGithubHost(hostname: string, lookup?: HostLookup): Promise<ResolvedAddress> {
    const name = normalizeName(hostname)
    if (blockedName(name)) reject('That GitHub host is blocked by the outbound policy.')
    const ask =
        lookup ||
        (async (host: string) => {
            const records = await dns.lookup(host, { all: true, verbatim: true })
            return records.map((record) => ({ address: record.address, family: record.family === 6 ? 6 : 4 } as ResolvedAddress))
        })
    let records: ResolvedAddress[]
    try {
        records = await ask(name)
    } catch (error) {
        if (error instanceof GithubError) throw error
        reject(`Could not look up ${name}. Check the host name, then try again.`)
    }
    if (!records.length) reject(`Could not look up ${name}. Check the host name, then try again.`)
    for (const record of records) {
        if (addressBlocked(record.address)) {
            reject(
                `${name} is blocked by this server's outbound policy. Version history does not send a GitHub token to a private-network, loopback or link-local address.`
            )
        }
    }
    const chosen = records.find((record) => record.family === 4) || records[0]
    return chosen
}

export interface PinnedResponse {
    status: number
    json: () => Promise<unknown>
}

// One HTTPS request to the address that was just checked. TLS hostname verification stays on.
// Redirects are not followed: a 3xx is returned to the caller, which refuses it.
export function pinnedRequest(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    pin: ResolvedAddress,
    timeoutMs: number
): Promise<PinnedResponse> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') reject('A GitHub host has to use https.')
    return new Promise((resolve, rejectPromise) => {
        const req = https.request(
            parsed,
            {
                method: init.method,
                headers: { ...init.headers, Host: parsed.host },
                servername: parsed.hostname,
                rejectUnauthorized: true,
                timeout: timeoutMs,
                lookup: (_hostname, _options, callback) => {
                    callback(null, pin.address, pin.family)
                }
            },
            (res: http.IncomingMessage) => {
                const chunks: Buffer[] = []
                res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8')
                    resolve({
                        status: res.statusCode || 0,
                        json: async () => (text ? JSON.parse(text) : null)
                    })
                })
            }
        )
        req.on('timeout', () => req.destroy(new Error('timeout')))
        req.on('error', (error) => rejectPromise(error))
        if (init.body) req.write(init.body)
        req.end()
    })
}
