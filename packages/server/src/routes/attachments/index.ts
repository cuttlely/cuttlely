import express from 'express'
import attachmentsController from '../../controllers/attachments'
import { receiveUploadedFiles } from '../../middlewares/receiveUploadedFiles'
import { authorizeAttachmentUpload, bindAttachmentChatId } from '../../utils/authorizeFlowAccess'

const router = express.Router()

// CREATE
// Flow access, then session binding, then multer. A chat id this caller does not own is replaced before any storage prefix is chosen.
router.post(
    '/:chatflowId/:chatId',
    authorizeAttachmentUpload,
    bindAttachmentChatId,
    receiveUploadedFiles,
    attachmentsController.createAttachment
)

export default router
