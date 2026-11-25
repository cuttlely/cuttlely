import express from 'express'
import internalPredictionsController from '../../controllers/internal-predictions'
import { receiveUploadedFiles } from '../../middlewares/receiveUploadedFiles'

const router = express.Router()

// Chat sends full documents as multipart `files` on this route. Multer's fileSize limit refuses an oversized
// part before the controller. JSON requests skip multer. preparePredictionUpload then chooses a bounded
// excerpt or a path stub.
router.post(['/', '/:id'], receiveUploadedFiles, internalPredictionsController.createInternalPrediction)

export default router
