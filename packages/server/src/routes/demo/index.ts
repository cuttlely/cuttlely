import express from 'express'
import demoController from '../../controllers/demo'
import { requireAnyPermission } from '../../identity/rbac'
const router = express.Router()

// Try the demo: a ready-made agent team over made-up bakery data, run with the person's own model key.
router.get('/', requireAnyPermission('chatflows:view,chatflows:create'), demoController.status)
router.post('/', requireAnyPermission('chatflows:create'), demoController.create)

export default router
