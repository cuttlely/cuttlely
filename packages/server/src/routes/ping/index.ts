import express from 'express'
import pingController from '../../controllers/ping'
const router = express.Router()

// GET
router.get('/', pingController.getPing)
// Application liveness for gateways and container probes; ping itself remains strict readiness.
router.get('/live', pingController.getLive)

export default router
