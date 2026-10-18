import express from 'express'
import apikeyController from '../../controllers/apikey'
const router = express.Router()

// READ
router.get('/apikey/', apikeyController.verifyApiKey)
router.get('/apikey/:apikey', apikeyController.refuseApiKeyInUrl)

export default router
