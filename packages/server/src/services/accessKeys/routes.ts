import { accessRollout } from './rollout'
import { RequestHandler } from 'express'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { AppError } from '../../errors/appError'
import { normalizeApiPath } from '../../identity/apiGate'
import { accessData } from './data'
import { accessContext, authenticateRequest, authorizeKey, flowResource } from './authorization'
import { Operation } from './policy'

/**
 * Defense in depth for workspace APIs. Public flow transports do their resource resolution in their own middleware.
 * New keys cannot fall through to unclassified or workspace-wide resource APIs. Legacy keys retain marked compatibility.
 */
export const accessKeyRouteGuard: RequestHandler = (req, _res, next) => {
    void (async () => {
        if (req.user?.id) return
        const path = normalizeApiPath(req.path)
        const parts = path.split('/').filter(Boolean)
        const root = parts[0] || ''
        if (['mcp', 'public-dashflows', 'scim'].includes(root)) return // separate credentials, unchanged
        if (!req.headers.authorization && !req.user?.apiKeyId) return
        if (['prediction', 'attachments', 'feedback', 'get-upload-file', 'vector', 'orchestrate', 'a2a', 'verify'].includes(root)) return
        const key = accessContext(req)?.key || (await authenticateRequest(req))
        if (!key) throw new AppError(401, 'Unauthorized')
        if (accessRollout() !== 'on') {
            if (!key.accessPolicy?.legacy) throw new AppError(503, 'Scoped access keys require INBOUND_ACCESS_V2=on.')
            return
        }
        const read = ['GET', 'HEAD'].includes(req.method)
        const route = '/' + parts.join('/')
        const method = req.method === 'HEAD' ? 'GET' : req.method
        const registered = [
            /^(GET|PUT|DELETE) \/chatflows\/[0-9a-f-]{36}$/,
            /^GET \/chatflows\/has-changed\/[0-9a-f-]{36}\/[^/]+$/,
            /^(GET|PUT|DELETE) \/flow-drafts\/[0-9a-f-]{36}$/,
            /^POST \/flow-drafts\/[0-9a-f-]{36}\/(publish|rollback)$/,
            /^GET \/flow-versions\/[0-9a-f-]{36}(\/[^/]+(\/diff)?)?$/,
            /^POST \/flow-versions\/[0-9a-f-]{36}\/[^/]+\/restore$/,
            /^(GET|DELETE) \/chatmessage\/[0-9a-f-]{36}$/,
            /^PUT \/chatmessage\/abort\/[0-9a-f-]{36}\/[^/]+$/,
            /^GET \/leads\/[0-9a-f-]{36}$/,
            /^POST \/leads$/,
            /^GET \/chatflows-(streaming|uploads)\/[0-9a-f-]{36}$/,
            /^GET \/harnesses\/[^/]+\/runs(\/[^/]+(\/(result|diagnostics))?)?$/,
            /^POST \/harnesses\/[^/]+\/runs(\/async)?$/,
            /^GET \/dashflows\/[^/]+\/(published|refresh-status)$/,
            /^GET \/dashflows\/[^/]+\/reports\/[^/]+$/,
            /^POST \/dashflows\/[^/]+\/refresh$/,
            /^POST \/dashflows\/[^/]+\/accounts\/[^/]+\/report$/
        ].some((pattern) => pattern.test(method + ' ' + route))
        if (!key.accessPolicy?.legacy && !registered) throw new AppError(403, 'This endpoint is not available to scoped access keys.')

        let operation: Operation = read ? 'api:read' : 'api:write'
        let resource
        const data = await accessData()
        if (
            ['chatflows', 'flow-versions', 'flow-drafts', 'chatmessage', 'leads', 'chatflows-streaming', 'chatflows-uploads'].includes(root)
        ) {
            const raw =
                root === 'chatflows' && parts[1] === 'has-changed'
                    ? parts[2]
                    : root === 'chatmessage' && parts[1] === 'abort'
                    ? parts[2]
                    : parts[1]
            const id = raw || (root === 'leads' ? req.body?.chatflowid : undefined)
            if (id && /^[0-9a-f-]{36}$/.test(id)) {
                const flow = await data.getRepository(ChatFlow).findOneBy({ id, workspaceId: key.workspaceId })
                if (!flow) throw new AppError(404, 'Resource not found.')
                resource = flowResource(flow)
            }
            if (['chatmessage', 'leads'].includes(root)) operation = read ? 'feedback:read' : 'feedback:write'
        } else if (root === 'harnesses' && parts[1]) {
            const name = decodeURIComponent(req.path.split('/').filter(Boolean)[1])
            const flow = await data.getRepository(ChatFlow).findOneBy({ name, type: 'HARNESS', workspaceId: key.workspaceId })
            if (!flow || flow.name !== name) throw new AppError(403, 'Resource is not available to this access key.')
            resource = flowResource(flow)
            if (parts[2] === 'runs') operation = read ? 'harness:read' : 'harness:run'
        } else if (root === 'dashflows' && parts[1]) {
            resource = { resourceType: 'DASHFLOW' as const, resourceId: parts[1] }
            operation = read ? 'dashflow:read' : 'dashflow:report'
            const { runtime } = await import('../dashflows')
            const dashboard = (await runtime()).dashStore().get(parts[1], key.workspaceId)
            if (!read) {
                const harness = await data
                    .getRepository(ChatFlow)
                    .findOneBy({ name: dashboard.definition.harness, type: 'HARNESS', workspaceId: key.workspaceId })
                if (!harness) throw new AppError(403, 'Referenced harness is unavailable.')
                await authorizeKey(req, 'harness:run', key.workspaceId, flowResource(harness), false)
            }
        }
        if (!key.accessPolicy?.legacy) {
            if (!resource) throw new AppError(403, 'This route is not available to scoped access keys.')
            // Dashboard editing/publishing and scheduler changes remain interactive-session operations.
            if (
                root === 'dashflows' &&
                !(
                    (read && ['published', 'refresh-status', 'reports'].includes(parts[2])) ||
                    (!read && req.method === 'POST' && (parts[2] === 'refresh' || (parts[2] === 'accounts' && parts[4] === 'report')))
                )
            )
                throw new AppError(403, 'Sign in to edit Dashflows.')
            if (['chatflows', 'flow-drafts'].includes(root) && req.body && ('apikeyid' in req.body || 'apiAccessMode' in req.body))
                throw new AppError(403, 'Sign in to change a flow’s public access or legacy binding.')
            if (root === 'harnesses' && parts[2] !== 'runs') throw new AppError(403, 'Scoped access keys use the Harness runs API.')
        }
        // Legacy management retains its existing RBAC and resource behavior, explicitly flagged by migration.
        await authorizeKey(
            req,
            operation,
            key.workspaceId,
            key.accessPolicy?.legacy && !['harness:run', 'harness:read', 'dashflow:read', 'dashflow:report'].includes(operation)
                ? undefined
                : resource
        )
    })().then(() => next(), next)
}
