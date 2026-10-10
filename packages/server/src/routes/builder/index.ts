import express from 'express'
import builderController from '../../controllers/builder'
const router = express.Router()

router.post('/:kind/build', builderController.build)

export default router
