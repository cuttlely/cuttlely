import express from 'express'
import getUploadFileController from '../../controllers/get-upload-file'
import { authorizeUploadFileRead, bindUploadFileChatId } from '../../utils/authorizeFlowAccess'
const router = express.Router()

// READ (API-11: the flow's API key or a session in the flow's workspace).
// The chat id must belong to this caller. Someone else's prefix is 403 and the file is not opened.
router.get('/', authorizeUploadFileRead, bindUploadFileChatId, getUploadFileController.streamUploadedFile)

export default router
