// The ordered list of environments a promotion walks. A saved Dev or Prod label with no list is the
// pair [dev, prod], both publishing to the same place, which is how a two-server setup already works.
import { createHash } from 'crypto'

export interface NamedEnvironment {
    // Shown on the promote page.
    name: string
    // Where this environment publishes. The app does not show this.
    branch: string
    // Stable identity. The saved `environment` value matches this.
    server: string
}

export interface EnvironmentConfig {
    environment: string | null
    environments: NamedEnvironment[]
    // The file named a list that could not be read. Nothing is copied or promoted until it is saved again.
    invalid: boolean
}

export interface EnvironmentSlot {
    chain: NamedEnvironment[]
    index: number
    here: NamedEnvironment | null
    source: NamedEnvironment | null
    next: NamedEnvironment | null
}

export interface SyncPlan {
    reads: boolean
    copies: boolean
    sourceBranch: string | null
    publishBranch: string | null
}

export const LEGACY_ENVIRONMENTS: readonly NamedEnvironment[] = [
    { name: 'dev', branch: 'main', server: 'dev' },
    { name: 'prod', branch: 'main', server: 'prod' }
]

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/
const SERVER = /^[a-z][a-z0-9-]{0,31}$/
const PUBLISH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

export function legacyEnvironments(): NamedEnvironment[] {
    return LEGACY_ENVIRONMENTS.map((item) => ({ ...item }))
}

// Same text for the same list on every server. A publisher records it; a reader stops when its own list differs.
export function environmentListFingerprint(environments: NamedEnvironment[]): string {
    const body = JSON.stringify(environments.map(({ name, branch, server }) => ({ name, branch, server })))
    return createHash('sha256').update(body).digest('hex')
}

export function isLegacyChain(environments: NamedEnvironment[]): boolean {
    return (
        environments.length === LEGACY_ENVIRONMENTS.length &&
        environments.every((item, index) => {
            const legacy = LEGACY_ENVIRONMENTS[index]
            return item.name === legacy.name && item.branch === legacy.branch && item.server === legacy.server
        })
    )
}

function publishNameOk(value: string): boolean {
    if (!PUBLISH.test(value)) return false
    if (value.includes('..') || value.includes('@{') || value.endsWith('.lock') || value.endsWith('.')) return false
    return true
}

export function parseEnvironments(input: unknown): { ok: true; environments: NamedEnvironment[] } | { ok: false; error: string } {
    if (!Array.isArray(input) || input.length < 2 || input.length > 8) {
        return { ok: false, error: 'List 2 to 8 environments, in the order a version is promoted.' }
    }
    const environments: NamedEnvironment[] = []
    const names = new Set<string>()
    const servers = new Set<string>()
    const branches = new Set<string>()
    for (const item of input) {
        if (!item || typeof item !== 'object') return { ok: false, error: 'Each environment needs a name and a server identity.' }
        const record = item as Record<string, unknown>
        const name = typeof record.name === 'string' ? record.name.trim() : ''
        const server = typeof record.server === 'string' ? record.server.trim() : ''
        const branch = typeof record.branch === 'string' ? record.branch.trim() : ''
        if (!NAME.test(name) || name.endsWith('.')) {
            return { ok: false, error: 'An environment name uses letters, numbers, spaces, dots, dashes or underscores.' }
        }
        if (!SERVER.test(server)) {
            return { ok: false, error: 'A server identity uses lower-case letters, numbers and dashes, and starts with a letter.' }
        }
        if (!publishNameOk(branch)) {
            return {
                ok: false,
                error: 'Each environment needs a publish name of letters, numbers, dots, dashes or underscores.'
            }
        }
        const nameKey = name.toLowerCase()
        if (names.has(nameKey) || servers.has(server) || branches.has(branch)) {
            return { ok: false, error: 'Environment names, server identities and publish names have to be different.' }
        }
        names.add(nameKey)
        servers.add(server)
        branches.add(branch)
        environments.push({ name, branch, server })
    }
    return { ok: true, environments }
}

// The legacy pair is the only list whose publish names match. parseEnvironments rejects it because of that
// duplicate, so callers that accept the saved pair use isLegacyChain before this, and a hand-written pair
// is recognized here.
export function parseEnvironmentsAllowingLegacy(
    input: unknown
): { ok: true; environments: NamedEnvironment[] } | { ok: false; error: string } {
    if (Array.isArray(input) && input.length === 2) {
        const parsed = input.map((item) => {
            if (!item || typeof item !== 'object') return null
            const record = item as Record<string, unknown>
            return {
                name: typeof record.name === 'string' ? record.name.trim() : '',
                branch: typeof record.branch === 'string' ? record.branch.trim() : '',
                server: typeof record.server === 'string' ? record.server.trim() : ''
            }
        })
        if (parsed[0] && parsed[1] && isLegacyChain(parsed as NamedEnvironment[])) {
            return { ok: true, environments: legacyEnvironments() }
        }
    }
    return parseEnvironments(input)
}

export function parseEnvironmentFile(raw: unknown): EnvironmentConfig {
    if (!raw || typeof raw !== 'object') return { environment: null, environments: legacyEnvironments(), invalid: false }
    const record = raw as Record<string, unknown>
    if (Object.prototype.hasOwnProperty.call(record, 'environments')) {
        const parsed = parseEnvironmentsAllowingLegacy(record.environments)
        if (!parsed.ok) return { environment: null, environments: [], invalid: true }
        const environment =
            typeof record.environment === 'string' && parsed.environments.some((item) => item.server === record.environment)
                ? record.environment
                : null
        return { environment, environments: parsed.environments, invalid: false }
    }
    const value = record.environment
    return {
        environment: value === 'dev' || value === 'prod' ? value : null,
        environments: legacyEnvironments(),
        invalid: false
    }
}

export function slotFor(chain: NamedEnvironment[], server: string | null): EnvironmentSlot {
    const index = server ? chain.findIndex((item) => item.server === server) : -1
    const here = index >= 0 ? chain[index] : null
    return {
        chain,
        index,
        here,
        source: index > 0 ? chain[index - 1] : null,
        next: index >= 0 && index < chain.length - 1 ? chain[index + 1] : null
    }
}

export function syncPlan(chain: NamedEnvironment[], server: string | null): SyncPlan {
    const legacy = isLegacyChain(chain)
    const slot = slotFor(chain, server)
    const reads = slot.index > 0
    const copies = slot.index < 0 ? legacy : slot.index < chain.length - 1
    return {
        reads,
        copies,
        sourceBranch: reads ? slot.source?.branch || null : null,
        publishBranch: copies ? slot.here?.branch || 'main' : null
    }
}

// Null when `fromServer` promotes straight to `toServer`. A message when the hop would skip one.
export function adjacentError(chain: NamedEnvironment[], fromServer: string, toServer: string): string | null {
    const from = chain.findIndex((item) => item.server === fromServer)
    const to = chain.findIndex((item) => item.server === toServer)
    if (from >= 0 && to === from + 1) return null
    return 'Promotion only moves to the next environment.'
}

// The name on screen for the environment this server promotes from. "Dev" for the saved pair.
export function sourceTitle(chain: NamedEnvironment[], server: string | null): string {
    const source = slotFor(chain, server).source
    if (!source || source.name.toLowerCase() === 'dev') return 'Dev'
    if (source.name.toLowerCase() === 'prod') return 'Prod'
    return source.name
}
