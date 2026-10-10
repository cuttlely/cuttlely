import express from 'express'
import feedbackController from '../../controllers/feedback'
import { authorizeFeedbackCreate, authorizeFeedbackRead, authorizeFeedbackUpdate } from '../../utils/authorizeFlowAccess'
const router = express.Router()

// API-11: the flow's API key or a session in the flow's workspace, checked on the flow that owns the feedback or message.

// CREATE
router.post(['/', '/:id'], authorizeFeedbackCreate, feedbackController.createChatMessageFeedbackForChatflow)

// READ
router.get(['/', '/:id'], authorizeFeedbackRead, feedbackController.getAllChatMessageFeedback)

// UPDATE
router.put(['/', '/:id'], authorizeFeedbackUpdate, feedbackController.updateChatMessageFeedbackForChatflow)

export default router
