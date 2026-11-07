import express from 'express'
import leadsController from '../../controllers/leads'
import { authorizeLeadCreate } from '../../services/accessKeys/routes'

const router = express.Router()

// CREATE
router.post('/', authorizeLeadCreate, leadsController.createLeadInChatflow)

// READ
router.get(['/', '/:id'], leadsController.getAllLeadsForChatflow)

export default router
