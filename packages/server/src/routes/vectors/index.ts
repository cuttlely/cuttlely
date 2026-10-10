import express from 'express'
import vectorsController from '../../controllers/vectors'
import { getMulterStorage } from '../../utils'
import { authorizeVectorUpsert } from '../../utils/authorizeUpsert'

const router = express.Router()

// CREATE
// The flow key and workspace check run before multer, which writes each file as it streams in.
router.post(
    ['/upsert/', '/upsert/:id'],
    vectorsController.getRateLimiterMiddleware,
    authorizeVectorUpsert(false),
    getMulterStorage().array('files'),
    vectorsController.upsertVectorMiddleware
)
router.post(
    ['/internal-upsert/', '/internal-upsert/:id'],
    authorizeVectorUpsert(true),
    getMulterStorage().array('files'),
    vectorsController.createInternalUpsert
)

export default router
