import express from 'express'
import statsController from '../../controllers/stats'
import { requireAnyPermission } from '../../identity/rbac'

const router = express.Router()

// A key with only an unrelated permission, such as tools:view, cannot read another flow's totals.
const viewStats = requireAnyPermission('chatflows:view,agentflows:view')

// READ
// Registered before /:id so "usage" is not treated as a chatflow id.
router.get('/usage', viewStats, statsController.getTokenUsage)
router.get(['/', '/:id'], viewStats, statsController.getChatflowStats)

export default router
