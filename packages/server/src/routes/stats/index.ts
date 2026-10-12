import express from 'express'
import statsController from '../../controllers/stats'

const router = express.Router()

// READ
// Registered before /:id so "usage" is not treated as a chatflow id.
router.get('/usage', statsController.getTokenUsage)
router.get(['/', '/:id'], statsController.getChatflowStats)

export default router
