import express, { RequestHandler } from 'express'
import { isMcpEndpointPath, normalizeApiPath } from '../identity/apiGate'

export const EXTERNAL_JSON_LIMIT = '1mb'
export const SCIM_JSON_LIMIT = '256kb'

export const mcpJsonParser = express.json({ limit: EXTERNAL_JSON_LIMIT, type: 'application/json' })
export const scimJsonParser = express.json({ limit: SCIM_JSON_LIMIT, type: ['application/scim+json', 'application/json'] })

export function isScimEndpointPath(path: string): boolean {
    return path === '/api/v1/scim/v2' || path.startsWith('/api/v1/scim/v2/')
}

export function requestApiPath(req: { originalUrl?: string; url?: string; baseUrl?: string; path?: string }): string {
    const raw = req.originalUrl || `${req.baseUrl || ''}${req.path || req.url || ''}`
    return normalizeApiPath(raw.split('?')[0])
}

export function skipGlobalJsonParser(req: { originalUrl?: string; url?: string; baseUrl?: string; path?: string }): boolean {
    const path = requestApiPath(req)
    return (
        path === '/api/v1/a2a' ||
        path.startsWith('/api/v1/a2a/') ||
        path === '/api/v1/orchestrate' ||
        path.startsWith('/api/v1/orchestrate/') ||
        isMcpEndpointPath(path) ||
        isScimEndpointPath(path)
    )
}

export function unlessExternalJson(parser: RequestHandler): RequestHandler {
    return (req, res, next) => {
        if (skipGlobalJsonParser(req)) return next()
        return parser(req, res, next)
    }
}

export function whenMcpEndpoint(parser: RequestHandler): RequestHandler {
    return (req, res, next) => {
        if (!isMcpEndpointPath(requestApiPath(req))) return next()
        return parser(req, res, next)
    }
}
