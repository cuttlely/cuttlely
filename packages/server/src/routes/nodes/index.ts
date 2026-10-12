import express from 'express'
import nodesController from '../../controllers/nodes'
const router = express.Router()

// READ
// Same sign-in gate as GET /nodes. This path is not on the public list in constants.ts.
router.get('/pack-index', nodesController.getNodePackIndex)
router.get('/', nodesController.getAllNodes)
router.get(['/', '/:name'], nodesController.getNodeByName)
router.get('/category/:name', nodesController.getNodesByCategory)

export default router
