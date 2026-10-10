import express from 'express'
import predictionsController from '../../controllers/predictions'
import { getMulterStorage } from '../../utils'
import { authorizePrediction } from '../../utils/authorizeFlowAccess'

const router = express.Router()

// NOTE: extractChatflowId function in XSS.ts extracts the chatflow ID from the prediction URL.
// It assumes the URL format is /prediction/{chatflowId}. Make sure to update the function if the URL format changes.
// CREATE
// Order matters (API-4b): the rate limiter reads only req.params.id and writes nothing; authorizePrediction checks
// the flow's API key before multer, because multer writes each file to storage as it streams in.
// authorizePrediction.test.ts (test 13) guards this order.
router.post(
    ['/', '/:id'],
    predictionsController.getRateLimiterMiddleware,
    authorizePrediction,
    getMulterStorage().array('files'),
    predictionsController.createPrediction
)

export default router
