import { IsNull } from 'typeorm'
import { AppError } from '../../errors/appError'

/** Transport credentials can execute outside this principal. Never return them to scoped management clients. */
export function redactTransportSecrets(value: unknown, depth = 0): unknown {
    if (depth > 64) throw new AppError(403, 'Management response exceeds the safe inspection depth.')
    if (Array.isArray(value)) return value.map((item) => redactTransportSecrets(item, depth + 1))
    if (!value || typeof value !== 'object' || value instanceof Date) return value
    const clean: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
        if (['mcpServerConfig', 'webhookSecret', 'apiKey', 'apiSecret'].includes(key)) continue
        clean[key] = redactTransportSecrets(item, depth + 1)
    }
    return clean
}

/** Canvas and publication mutations can create schedules or independent transport credentials. Keep them session-only. */
export function assertSafeManagementWrite(root: string, method: string, parts: string[], body: unknown): void {
    if (['GET', 'HEAD'].includes(method)) return
    if (root !== 'chatflows' || method !== 'PUT' || parts.length !== 2)
        throw new AppError(403, 'Sign in to change canvases, publication, schedules or execution transports.')
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['name', 'category'].includes(key)))
        throw new AppError(403, 'Scoped flow management may change name and category only. Sign in to change execution configuration.')
}

/** Metadata edits must not enter the canvas save path, which may register schedules or independent transports. */
export const scopedFlowMetadataUpdate: import('express').RequestHandler = (req, res, next) => {
    void (async () => {
        const { accessContext } = await import('./authorization')
        const context = accessContext(req)
        if (!context || context.key.accessPolicy?.legacy || req.user?.id) return next()
        assertSafeManagementWrite('chatflows', req.method, ['chatflows', req.params.id], req.body)
        const { accessData } = await import('./data')
        const { ChatFlow } = await import('../../database/entities/ChatFlow')
        const repo = (await accessData()).getRepository(ChatFlow)
        const where = { id: req.params.id, workspaceId: context.key.workspaceId }
        const current = await repo.findOneBy(where)
        if (!current) throw new AppError(404, 'Resource not found.')
        if (current.type === 'HARNESS' && 'name' in req.body) throw new AppError(403, 'Sign in to rename a Harness.')
        const patch: { name?: string; category?: string } = {}
        if ('name' in req.body) {
            if (typeof req.body.name !== 'string' || !req.body.name.trim() || req.body.name.length > 255)
                throw new AppError(400, 'Invalid flow name.')
            patch.name = req.body.name.trim()
        }
        if ('category' in req.body) {
            if (req.body.category !== null && (typeof req.body.category !== 'string' || req.body.category.length > 1000))
                throw new AppError(400, 'Invalid category.')
            patch.category = req.body.category ?? ''
        }
        if (Object.keys(patch).length) {
            // A concurrent type conversion cannot turn a scoped metadata edit into a Harness rename.
            const result = await repo.update({ ...where, type: (current.type ?? IsNull()) as any }, patch)
            if (!result.affected) throw new AppError(409, 'Flow type changed. Reload before saving.')
        }
        res.json(redactTransportSecrets(await repo.findOneBy(where)))
    })().catch(next)
}
