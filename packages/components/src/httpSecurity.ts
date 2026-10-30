import axios, { AxiosRequestConfig, AxiosResponse } from 'axios'
import dns from 'dns/promises'
import http from 'http'
import https from 'https'
import * as ipaddr from 'ipaddr.js'
import fetch, { RequestInit, Response } from 'node-fetch'

const DEFAULT_DENY_LIST = [
    '0.0.0.0',
    '10.0.0.0/8',
    '100.64.0.0/10', // carrier-grade NAT shared address space (RFC 6598)
    '100.100.100.200', // Alibaba Cloud metadata
    '127.0.0.0/8',
    '169.254.0.0/16',
    '169.254.169.253',
    '169.254.169.254',
    '172.16.0.0/12',
    '192.0.0.192', // Oracle Cloud Infrastructure metadata
    '192.168.0.0/16',
    '224.0.0.0/4',
    '240.0.0.0/4',
    '255.255.255.255/32',
    '::',
    '::1',
    'fc00::/7',
    'fd00:ec2::254',
    'fe80::/10',
    'ff00::/8',
    'localhost',
    'ip6-localhost'
]

/**
 * The loopback entries HTTP_ALLOW_LOCALHOST takes out of the default list. Nothing else is opened:
 * 0.0.0.0, ::, link-local and metadata addresses, private ranges and HTTP_DENY_LIST entries stay blocked.
 */
const LOCALHOST_ENTRIES = new Set(['localhost', 'ip6-localhost', '127.0.0.0/8', '::1'])

export const HTTP_ALLOW_LOCALHOST = 'HTTP_ALLOW_LOCALHOST'

type AllowLocalhostReader = () => boolean

// The server installs a reader that resolves the Server settings value (host, then the saved file, then off) on each call.
// The slot is on globalThis so a node pack that loads its own copy of this module reads the same setting.
const READER_SLOT = Symbol.for('cuttlely.httpAllowLocalhostReader')

/** The server calls this at start with a reader for the live Server settings value. Undefined removes it. */
export function setHttpAllowLocalhostReader(reader: AllowLocalhostReader | undefined): void {
    ;(globalThis as Record<symbol, unknown>)[READER_SLOT] = reader
}

/**
 * True when HTTP building blocks may call the server's own loopback addresses.
 * Read on each request. Without a reader (no server, for example a script), only the environment value exactly 'true' turns it on.
 * A reader that throws counts as off.
 */
export function httpAllowLocalhost(): boolean {
    const reader = (globalThis as Record<symbol, unknown>)[READER_SLOT] as AllowLocalhostReader | undefined
    if (typeof reader === 'function') {
        try {
            return reader() === true
        } catch {
            return false
        }
    }
    return process.env[HTTP_ALLOW_LOCALHOST] === 'true'
}

/**
 * Gets the HTTP deny list.
 * When HTTP_SECURITY_CHECK=false, the default deny list is omitted and only
 * HTTP_DENY_LIST entries are used. Defaults to true (secure).
 * When HTTP_ALLOW_LOCALHOST is on, the loopback entries are left out of the default list only.
 * HTTP_DENY_LIST entries always apply.
 * @returns Array of denied IP addresses, hostnames, or CIDR ranges
 */
function getHttpDenyList(): string[] {
    const securityCheckEnabled = process.env.HTTP_SECURITY_CHECK !== 'false'
    const httpDenyListString = process.env.HTTP_DENY_LIST
    const customList = httpDenyListString
        ? httpDenyListString
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
        : []

    if (securityCheckEnabled) {
        const defaults = httpAllowLocalhost() ? DEFAULT_DENY_LIST.filter((entry) => !LOCALHOST_ENTRIES.has(entry)) : DEFAULT_DENY_LIST
        return [...new Set([...defaults, ...customList])]
    }
    return customList
}

function normalizeHostname(name: string): string {
    return name.toLowerCase().replace(/\.+$/, '')
}

/**
 * Checks a requested host name against the name entries of the deny list (for example localhost).
 * Addresses and ranges are checked against the resolved address by isDeniedIP.
 * @throws Error if the name is in the deny list
 */
function isDeniedHostname(hostname: string, denyList: string[]): void {
    const name = normalizeHostname(hostname)
    for (const entry of denyList) {
        if (entry.includes('/') || ipaddr.isValid(entry)) continue
        if (normalizeHostname(entry) === name) {
            throw new Error('Access to this host is denied by policy.')
        }
    }
}

/**
 * Checks if an IP address is in the deny list
 * @param ip - IP address to check
 * @param denyList - Array of denied IP addresses/CIDR ranges
 * @throws Error if IP is in deny list
 */
export function isDeniedIP(ip: string, denyList: string[]): void {
    let parsedIp = ipaddr.parse(ip)

    // Normalize IPv4-mapped IPv6 addresses to IPv4 before checking
    // This prevents bypass of IPv4 deny list rules via ::ffff:x.x.x.x addresses
    if (parsedIp.kind() === 'ipv6') {
        const ipv6Addr = parsedIp as ipaddr.IPv6
        if (ipv6Addr.isIPv4MappedAddress()) {
            parsedIp = ipv6Addr.toIPv4Address()
        }
    }

    for (const entry of denyList) {
        if (entry.includes('/')) {
            try {
                const [rangeAddr, mask] = ipaddr.parseCIDR(entry)
                let parsedRange = rangeAddr
                let adjustedMask = mask

                // Also normalize deny list entries
                if (parsedRange.kind() === 'ipv6' && (parsedRange as ipaddr.IPv6).isIPv4MappedAddress()) {
                    if (mask < 96) continue // malformed IPv4-mapped CIDR — skip
                    parsedRange = (parsedRange as ipaddr.IPv6).toIPv4Address()
                    adjustedMask -= 96
                }

                if (parsedIp.kind() === parsedRange.kind()) {
                    if (parsedIp.match(parsedRange, adjustedMask)) {
                        throw new Error('Access to this host is denied by policy.')
                    }
                }
            } catch (error) {
                throw new Error(`isDeniedIP: ${error}`)
            }
        } else {
            // Try to parse and normalize the deny list entry for consistent comparison
            // This handles non-canonical IPv6 addresses (e.g., FE80::1, 2001:0DB8::1)
            if (ipaddr.isValid(entry)) {
                let parsedEntry = ipaddr.parse(entry)

                // Normalize IPv4-mapped IPv6 entries
                if (parsedEntry.kind() === 'ipv6' && (parsedEntry as ipaddr.IPv6).isIPv4MappedAddress()) {
                    parsedEntry = (parsedEntry as ipaddr.IPv6).toIPv4Address()
                }

                // Compare normalized forms
                if (parsedIp.toString() === parsedEntry.toString()) {
                    throw new Error('Access to this host is denied by policy.')
                }
            } else {
                // Not a valid IP - compare as-is (e.g., hostname like "localhost")
                if (parsedIp.toString() === entry) {
                    throw new Error('Access to this host is denied by policy.')
                }
            }
        }
    }
}

/**
 * Checks if a URL is allowed based on HTTP_DENY_LIST environment variable.
 * @param url - URL to check
 * @throws Error if URL hostname resolves to a denied IP
 */
export async function checkDenyList(url: string): Promise<void> {
    const httpDenyList = getHttpDenyList()

    const urlObj = new URL(url)
    let hostname = urlObj.hostname
    // Strip IPv6 brackets if present
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
        hostname = hostname.slice(1, -1)
    }

    if (ipaddr.isValid(hostname)) {
        isDeniedIP(hostname, httpDenyList)
    } else {
        isDeniedHostname(hostname, httpDenyList)
        const addresses = await dns.lookup(hostname, { all: true })
        for (const address of addresses) {
            isDeniedIP(address.address, httpDenyList)
        }
    }
}

/**
 * Optional TLS options for secureAxiosRequest (e.g. custom CA for mutual TLS or private CAs).
 */
export interface SecureRequestAgentOptions {
    ca?: string | string[] | Buffer
}

/**
 * Makes a secure HTTP request that validates all URLs in redirect chains against the deny list
 * @param config - Axios request configuration (httpsAgent/httpAgent are ignored; use agentOptions for custom CA)
 * @param maxRedirects - Maximum number of redirects to follow (default: 5)
 * @param agentOptions - Optional TLS options (e.g. { ca } for custom CA PEM)
 * @returns Promise<AxiosResponse>
 * @throws Error if any URL in the redirect chain is denied
 */
export async function secureAxiosRequest(
    config: AxiosRequestConfig,
    maxRedirects: number = 5,
    agentOptions?: SecureRequestAgentOptions
): Promise<AxiosResponse> {
    let currentUrl = config.url
    if (!currentUrl) {
        throw new Error('secureAxiosRequest: url is required')
    }

    let redirects = 0
    let currentConfig: AxiosRequestConfig = {
        ...config,
        maxRedirects: 0,
        validateStatus: () => true,
        httpsAgent: undefined,
        httpAgent: undefined
    } // Disable automatic redirects; agents set per-request below

    while (redirects <= maxRedirects) {
        const target = await resolveAndValidate(currentUrl)
        const agent = createPinnedAgent(target, agentOptions)

        currentConfig = {
            ...currentConfig,
            url: currentUrl,
            ...(target.protocol === 'http' ? { httpAgent: agent } : { httpsAgent: agent }),
            headers: {
                ...currentConfig.headers,
                Host: target.hostname
            }
        }

        const response = await axios(currentConfig)

        // If it's a successful response (not a redirect), return it
        if (response.status < 300 || response.status >= 400) {
            return response
        }

        // Handle redirect
        const location = response.headers.location
        if (!location) {
            // No location header, but it's a redirect status - return the response
            return response
        }

        redirects++
        if (redirects > maxRedirects) {
            throw new Error('Too many redirects')
        }

        currentUrl = new URL(location, currentUrl).toString()

        // For redirects, we only need to preserve certain headers and change method if needed
        if (response.status === 301 || response.status === 302 || response.status === 303) {
            // For 303, or when redirecting POST requests, change to GET
            if (
                response.status === 303 ||
                (currentConfig.method && ['POST', 'PUT', 'PATCH'].includes(currentConfig.method.toUpperCase()))
            ) {
                currentConfig.method = 'GET'
                delete currentConfig.data
            }
        }
    }

    throw new Error('Too many redirects')
}

/**
 * Makes a secure fetch request that validates all URLs in redirect chains against the deny list
 * @param url - URL to fetch
 * @param init - Fetch request options
 * @param maxRedirects - Maximum number of redirects to follow (default: 5)
 * @param agentOptions - Optional TLS options (e.g. { ca } for custom CA PEM)
 * @returns Promise<Response>
 * @throws Error if any URL in the redirect chain is denied
 */
export async function secureFetch(
    url: string,
    init?: RequestInit,
    maxRedirects: number = 5,
    agentOptions?: SecureRequestAgentOptions
): Promise<Response> {
    let currentUrl = url
    let redirectCount = 0
    let currentInit = { ...init, redirect: 'manual' as const } // Disable automatic redirects

    while (redirectCount <= maxRedirects) {
        const resolved = await resolveAndValidate(currentUrl)
        const agent = createPinnedAgent(resolved, agentOptions)

        const response = await fetch(currentUrl, { ...currentInit, agent: () => agent })

        // If it's a successful response (not a redirect), return it
        if (response.status < 300 || response.status >= 400) {
            return response
        }

        // Handle redirect
        const location = response.headers.get('location')
        if (!location) {
            // No location header, but it's a redirect status - return the response
            return response
        }

        redirectCount++

        if (redirectCount > maxRedirects) {
            throw new Error('Too many redirects')
        }

        // Resolve the redirect URL (handle relative URLs)
        currentUrl = new URL(location, currentUrl).toString()

        // Handle method changes for redirects according to HTTP specs
        if (response.status === 301 || response.status === 302 || response.status === 303) {
            // For 303, or when redirecting POST/PUT/PATCH requests, change to GET
            if (response.status === 303 || (currentInit.method && ['POST', 'PUT', 'PATCH'].includes(currentInit.method.toUpperCase()))) {
                currentInit = {
                    ...currentInit,
                    method: 'GET',
                    body: undefined
                }
            }
        }
    }

    throw new Error('Too many redirects')
}

type ResolvedTarget = {
    hostname: string
    ip: string
    family: 4 | 6
    protocol: 'http' | 'https'
}

async function resolveAndValidate(url: string): Promise<ResolvedTarget> {
    const denyList = getHttpDenyList()

    const u = new URL(url)
    let hostname = u.hostname
    // Strip IPv6 brackets if present
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
        hostname = hostname.slice(1, -1)
    }
    const protocol: 'http' | 'https' = u.protocol === 'https:' ? 'https' : 'http'

    if (ipaddr.isValid(hostname)) {
        isDeniedIP(hostname, denyList)
        return {
            hostname,
            ip: hostname,
            family: hostname.includes(':') ? 6 : 4,
            protocol
        }
    }

    isDeniedHostname(hostname, denyList)

    const records = await dns.lookup(hostname, { all: true })
    if (records.length === 0) {
        throw new Error(`DNS resolution failed for ${hostname}`)
    }

    for (const r of records) {
        isDeniedIP(r.address, denyList)
    }

    const chosen = records.find((r) => r.family === 4) ?? records[0]

    return {
        hostname,
        ip: chosen.address,
        family: chosen.family as 4 | 6,
        protocol
    }
}

function createPinnedAgent(target: ResolvedTarget, options?: { ca?: string | string[] | Buffer }): http.Agent | https.Agent {
    const Agent = target.protocol === 'https' ? https.Agent : http.Agent

    // Every connection goes to the address that was checked. Node 20 and later ask for all addresses
    // ({ all: true }) when they try IPv4 and IPv6 in turn, and expect a list back.
    const lookup = (_host: string, opts: { all?: boolean } | undefined, cb: (...args: any[]) => void): void => {
        if (opts?.all) cb(null, [{ address: target.ip, family: target.family }])
        else cb(null, target.ip, target.family)
    }

    return new Agent({
        lookup: lookup as any,
        ...options
    })
}
