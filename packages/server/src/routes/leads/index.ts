import express from 'express'
import leadsController from '../../controllers/leads'
import { authorizeFlowAccess } from '../../utils/authorizeFlowAccess'
import { accessRollout } from '../../services/accessKeys/rollout'

const authorizeLead = authorizeFlowAccess({
    getChatflowId: (req) => (typeof req.body?.chatflowid === 'string' ? req.body.chatflowid : undefined),
    sessionNeedsHeader: true
})
const router = express.Router()

// CREATE
// Off/shadow retain the legacy anonymous collection contract. Enforcement requires parent-flow access.
router.post(
    '/',
    (req, res, next) => (accessRollout() === 'on' ? authorizeLead(req, res, next) : next()),
    leadsController.createLeadInChatflow
)

// READ
router.get(['/', '/:id'], leadsController.getAllLeadsForChatflow)

export default router
