import express from 'express'
import modelPricesController from '../../controllers/model-prices'
import { requireOwner } from '../../identity/rbac'

const router = express.Router()

// Prices are server settings for the organization. A role grant is not enough, and an API key never passes.
router.use(requireOwner())
router.get('/', modelPricesController.list)
router.put('/', modelPricesController.set)
router.delete('/', modelPricesController.clear)

export default router
