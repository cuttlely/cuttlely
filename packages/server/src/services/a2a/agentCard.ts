import type { AgentCard } from '@a2a-js/sdk'
import { Request } from 'express'

export type A2aAgentCard = AgentCard

export function parseA2aPublicBaseUrl(raw: string | undefined): string | undefined {
    if (raw === undefined || raw === '') return undefined
    let parsed: URL
    try {
        parsed = new URL(raw)
    } catch {
        throw new Error('A2A_PUBLIC_BASE_URL must be an origin such as https://x.example, with no path and no trailing slash')
    }
    const path = parsed.pathname
    if (
        (path && path !== '/') ||
        raw.endsWith('/') ||
        parsed.search ||
        parsed.hash ||
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    ) {
        throw new Error('A2A_PUBLIC_BASE_URL must be an origin such as https://x.example, with no path and no trailing slash')
    }
    return `${parsed.protocol}//${parsed.host}`
}

export function assertA2aPublicBaseUrl(): void {
    parseA2aPublicBaseUrl(process.env.A2A_PUBLIC_BASE_URL)
}

export function a2aPublicOrigin(req: Request): string {
    const fromEnv = parseA2aPublicBaseUrl(process.env.A2A_PUBLIC_BASE_URL)
    if (fromEnv) return fromEnv
    const host = req.get('host') || 'localhost'
    return `${req.protocol}://${host}`
}

export function buildAgentCard(req: Request, flow: { id: string; name?: string | null; updatedDate?: Date | string | null }): A2aAgentCard {
    const name = typeof flow.name === 'string' && flow.name ? flow.name : flow.id
    const version = flow.updatedDate ? new Date(flow.updatedDate).toISOString() : new Date(0).toISOString()
    const description = `Cuttlely chatflow ${name}`
    return {
        protocolVersion: '0.3.0',
        name,
        description,
        url: `${a2aPublicOrigin(req)}/api/v1/a2a/${flow.id}`,
        version,
        preferredTransport: 'JSONRPC',
        capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [{ id: flow.id, name, description, tags: ['cuttlely'] }],
        securitySchemes: {
            bearer: { type: 'http', scheme: 'bearer' },
            apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' }
        },
        security: [{ bearer: [] }, { apiKey: [] }]
    }
}
