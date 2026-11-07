import { AccessKeyPolicyError, AccessKeyUnavailableError } from './errors'
import { assertCapacity } from './limiter'
import { accessRollout, requireAccessRollout } from './rollout'
import { RequestHandler } from 'express'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { AppError } from '../../errors/appError'
import { bearerApiKey } from '../../utils/apiKey'
import { normalizeApiPath } from '../../identity/apiGate'
import { authenticateRequest, authorizeFlowKey, flowOperation } from './authorization'
import { accessData } from './data'
import { callerPolicyAllows } from './policy'
import { externalAgentHeaders } from '../../utils/externalAgentAuth'

/** Caller policies and URL-resolved flow admission run before global JSON parsing and multipart storage. */
export const accessKeyPreflight: RequestHandler = (req, _res, next) => {
    const path = normalizeApiPath(req.path)
    const adapter = /^\/api\/v1\/(orchestrate|a2a)(\/|$)/.test(path)
    if (
        !path.startsWith('/api/v1/') ||
        (!req.headers.authorization && !(adapter && req.headers['x-api-key'])) ||
        /^\/api\/v1\/(mcp|public-dashflows|scim)(\/|$)/.test(path)
    )
        return next()
    void (async () => {
        const token = bearerApiKey(req.headers.authorization)
        if (accessRollout() !== 'on') {
            if (/^ctu_(live|test)_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/.test(token)) requireAccessRollout()
            return // off/shadow retain established compatibility gates
        }
        if (adapter) externalAgentHeaders(req)
        const key = await authenticateRequest(req)
        if (!key) throw new AppError(401, 'Unauthorized')
        if (!key.accessPolicy || !callerPolicyAllows(key.accessPolicy, req.headers.origin, req.ip || ''))
            throw new AccessKeyPolicyError('Caller policy refused this request.')
        const match = /^\/api\/v1\/(prediction|attachments|vector\/upsert)\/([0-9a-f-]{36})(?:\/|$)/.exec(path)
        if (match) {
            const flow = await (await accessData()).getRepository(ChatFlow).findOneBy({ id: match[2] })
            if (!flow) throw new AppError(404, 'Resource not found.')
            // A multipart client cannot hide a streaming request in a later field after storage has begun.
            if (
                match[1] === 'prediction' &&
                req.headers['content-type']?.toLowerCase().startsWith('multipart/form-data') &&
                !key.accessPolicy.scopes.includes('stream')
            )
                throw new AppError(403, 'Multipart prediction requires stream scope as well as predict and upload.')
            await authorizeFlowKey(req, flow, false)
        }
        if (!['GET', 'HEAD'].includes(req.method)) await assertCapacity(await accessData(), key, flowOperation(req), req.res)
    })()
        .then(
            () => next(),
            async (error) => {
                const normalized =
                    accessRollout() === 'on' && !(error instanceof AppError && error.statusCode < 500)
                        ? new AccessKeyUnavailableError()
                        : error
                // Preflight runs before these routers, so their error middleware has not been entered.
                if (/^\/api\/v1\/orchestrate(\/|$)/.test(path)) {
                    const { orchestrateErrorHandler } = await import('../../routes/orchestrate')
                    return orchestrateErrorHandler(normalized, req, _res, next)
                }
                if (/^\/api\/v1\/a2a(\/|$)/.test(path)) {
                    const { a2aErrorHandler } = await import('../../routes/a2a')
                    return a2aErrorHandler(normalized, req, _res, next)
                }
                next(normalized)
            }
        )
        .catch(next)
}
