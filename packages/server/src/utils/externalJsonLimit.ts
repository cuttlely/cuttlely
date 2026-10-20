import express, { RequestHandler } from 'express'
import { isMcpEndpointPath, normalizeApiPath } from '../identity/apiGate'

export const EXTERNAL_JSON_LIMIT = '1mb'

export const mcpJsonParser = express.json({ limit: EXTERNAL_JSON_LIMIT, type: 'application/json' })

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
        isMcpEndpointPath(path)
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
