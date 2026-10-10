import express from 'express'
import webhookListenerController from '../../controllers/webhook-listener'
import { requireAnyPermission } from '../../identity/rbac'

const router = express.Router()

const requireFlowEdit = requireAnyPermission('chatflows:create,chatflows:update,agentflows:create,agentflows:update')

router.post('/:id/register', requireFlowEdit, webhookListenerController.registerListener)
router.get('/:id/stream/:listenerId', requireFlowEdit, webhookListenerController.streamListener)
router.delete('/:id/listener/:listenerId', requireFlowEdit, webhookListenerController.unregisterListener)

export default router
