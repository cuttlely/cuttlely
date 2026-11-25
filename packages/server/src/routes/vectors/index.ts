import express from 'express'
import vectorsController from '../../controllers/vectors'
import { receiveUploadedFiles } from '../../middlewares/receiveUploadedFiles'
import { authorizeVectorUpsert } from '../../utils/authorizeUpsert'

const router = express.Router()

// CREATE
// The flow key and workspace check run before multer, which writes each file as it streams in.
router.post(
    ['/upsert/', '/upsert/:id'],
    vectorsController.getRateLimiterMiddleware,
    authorizeVectorUpsert(false),
    receiveUploadedFiles,
    vectorsController.upsertVectorMiddleware
)
router.post(
    ['/internal-upsert/', '/internal-upsert/:id'],
    authorizeVectorUpsert(true),
    receiveUploadedFiles,
    vectorsController.createInternalUpsert
)

export default router
