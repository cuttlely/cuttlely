import express, { RequestHandler } from 'express'
import { requirePermission } from '../../identity/rbac'
import logController from '../../controllers/log'

const router = express.Router()

/** logs:view, or the organization owner. An API key has no user id and never passes. */
function requireLogsViewer(): RequestHandler {
    const gate = requirePermission('logs:view')
    return (req, res, next) => {
        const user = req.user as { id?: unknown } | undefined
        if (user && typeof user.id !== 'string') {
            res.status(403).json({ message: 'Forbidden' })
            return
        }
        gate(req, res, next)
    }
}

router.get('/', requireLogsViewer(), logController.getLogs)

export default router
