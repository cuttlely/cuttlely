import express from 'express'
import getUploadFileController from '../../controllers/get-upload-file'
import { authorizeUploadFileRead, bindUploadFileChatId } from '../../utils/authorizeFlowAccess'
const router = express.Router()

// Read access: the flow's API key, a session in the flow's workspace, or a signed file link from an Agent answer.
// The chat id must belong to this caller. Someone else's prefix is 403 and the file is not opened.
router.get('/', authorizeUploadFileRead, bindUploadFileChatId, getUploadFileController.streamUploadedFile)

export default router
