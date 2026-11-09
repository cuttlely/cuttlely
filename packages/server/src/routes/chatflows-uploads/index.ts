import { admitAccessKey } from '../../services/accessKeys/authorization'
import express from 'express'
import chatflowsController from '../../controllers/chatflows'

const router = express.Router()

// READ
router.get(['/', '/:id'], admitAccessKey, chatflowsController.checkIfChatflowIsValidForUploads)

export default router
