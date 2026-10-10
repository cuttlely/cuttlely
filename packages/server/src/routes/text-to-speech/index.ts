import express from 'express'
import textToSpeechController from '../../controllers/text-to-speech'
import { requireAnyPermission } from '../../identity/rbac'

const router = express.Router()

router.post('/generate', textToSpeechController.generateTextToSpeech)

router.post('/abort', textToSpeechController.abortTextToSpeech)

router.get('/voices', requireAnyPermission('chatflows:config,agentflows:config'), textToSpeechController.getVoices)

export default router
