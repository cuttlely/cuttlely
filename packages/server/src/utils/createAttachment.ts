import { Request } from 'express'
import {
    addArrayFilesToStorage,
    getFileFromUpload,
    IDocument,
    normalizeDocumentMime,
    resolveFileInputField,
    removeSpecificFileFromUpload,
    removeSpecificFileFromStorage,
    isValidUUID,
    isPathTraversal
} from 'flowise-components'
import { getRunningExpressApp } from './getRunningExpressApp'
import { validateFileMimeTypeAndExtensionMatch } from './fileValidation'
import { assertDocumentUploadSize } from './predictionUploads'
import logger from './logger'
import { getErrorMessage } from '../errors/utils'
import { checkStorage, updateStorageUsage } from './quotaUsage'
import { ChatFlow } from '../database/entities/ChatFlow'
import { Workspace } from '../database/entities/identity'
import { Organization } from '../database/entities/identity'
import { InternalFlowiseError } from '../errors/internalFlowiseError'
import { StatusCodes } from 'http-status-codes'
import { getAuthorizedChatflow, hasFlowAccess } from './authorizeFlowAccess'

/**
 * Create attachment
 * @param {Request} req
 */
export const createFileAttachment = async (req: Request) => {
    const appServer = getRunningExpressApp()

    const chatflowid = req.params.chatflowId
    const chatId = req.params.chatId

    if (!chatflowid || !isValidUUID(chatflowid)) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid chatflowId format - must be a valid UUID')
    }
    if (isPathTraversal(chatflowid) || (chatId && isPathTraversal(chatId))) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid path characters detected')
    }

    // Access is checked in authorizeAttachmentUpload (routes/attachments) before multer runs.
    let chatflow = getAuthorizedChatflow(req, chatflowid)
    if (!chatflow) {
        // Defensive: a caller that doesn't come through that route still needs a session in the flow's workspace or the flow's key
        chatflow =
            (await appServer.AppDataSource.getRepository(ChatFlow).findOneBy({
                id: chatflowid
            })) ?? undefined
        if (!chatflow) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${chatflowid} not found`)
        }
        if (!(await hasFlowAccess(req, chatflow))) {
            throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, 'Unauthorized')
        }
    }

    let orgId = req.user?.activeOrganizationId || ''
    let workspaceId = req.user?.activeWorkspaceId || ''
    let subscriptionId = req.user?.activeOrganizationSubscriptionId || ''

    // This is one of the WHITELIST_URLS, API can be public and there might be no req.user
    if (!orgId || !workspaceId) {
        const chatflowWorkspaceId = chatflow.workspaceId
        const workspace = await appServer.AppDataSource.getRepository(Workspace).findOneBy({
            id: chatflowWorkspaceId
        })
        if (!workspace) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Workspace ${chatflowWorkspaceId} not found`)
        }
        workspaceId = workspace.id

        const org = await appServer.AppDataSource.getRepository(Organization).findOneBy({
            id: workspace.organizationId
        })
        if (!org) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Organization ${workspace.organizationId} not found`)
        }

        orgId = org.id
        subscriptionId = org.subscriptionId as string
    }

    // Parse chatbot configuration to get file upload settings
    let pdfConfig = {
        usage: 'perPage',
        legacyBuild: false
    }
    let allowedFileTypes: string[] = []
    let fileUploadEnabled = false

    if (chatflow.chatbotConfig) {
        try {
            const chatbotConfig = JSON.parse(chatflow.chatbotConfig)
            if (chatbotConfig?.fullFileUpload) {
                fileUploadEnabled = chatbotConfig.fullFileUpload.status

                // Get allowed file types from configuration
                if (chatbotConfig.fullFileUpload.allowedUploadFileTypes) {
                    allowedFileTypes = chatbotConfig.fullFileUpload.allowedUploadFileTypes.split(',')
                }

                // PDF specific configuration
                if (chatbotConfig.fullFileUpload.pdfFile) {
                    if (chatbotConfig.fullFileUpload.pdfFile.usage) {
                        pdfConfig.usage = chatbotConfig.fullFileUpload.pdfFile.usage
                    }
                    if (chatbotConfig.fullFileUpload.pdfFile.legacyBuild !== undefined) {
                        pdfConfig.legacyBuild = chatbotConfig.fullFileUpload.pdfFile.legacyBuild
                    }
                }
            }
        } catch (e) {
            // Use default config if parsing fails
        }
    }

    // Check if file upload is enabled
    if (!fileUploadEnabled) {
        throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'File upload is not enabled for this chatflow')
    }

    // Find FileLoader node
    const fileLoaderComponent = appServer.nodesPool.componentNodes['fileLoader']
    const fileLoaderNodeInstanceFilePath = fileLoaderComponent.filePath as string
    const fileLoaderNodeModule = await import(fileLoaderNodeInstanceFilePath)
    const fileLoaderNodeInstance = new fileLoaderNodeModule.nodeClass()
    const options = {
        retrieveAttachmentChatId: true,
        orgId,
        workspaceId,
        chatflowid,
        chatId
    }
    const files = (req.files as Express.Multer.File[]) || []
    const fileAttachments = []
    if (files.length) {
        const isBase64 = req.body.base64
        for (const file of files) {
            // Address file name with special characters: https://github.com/expressjs/multer/issues/1104
            file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8')
            file.mimetype = normalizeDocumentMime(file.originalname, file.mimetype)

            if (!allowedFileTypes.length || !allowedFileTypes.includes(file.mimetype)) {
                throw new InternalFlowiseError(
                    StatusCodes.BAD_REQUEST,
                    `File type '${file.mimetype}' is not allowed. Allowed types: ${allowedFileTypes.join(', ')}`
                )
            }

            // Security fix: Verify file extension matches the declared MIME type
            // This prevents MIME type spoofing attacks (e.g., uploading .js file with text/plain MIME type)
            // This addresses the vulnerability (CVE-2025-61687)
            validateFileMimeTypeAndExtensionMatch(file.originalname, file.mimetype)

            const tempPath = file.path ?? file.key
            try {
                assertDocumentUploadSize(file.originalname, file.size ?? 0)
            } catch (error) {
                if (tempPath) {
                    try {
                        await removeSpecificFileFromUpload(tempPath)
                    } catch {
                        // The temp file is already gone when an earlier step removed it.
                    }
                }
                throw error
            }

            await checkStorage(orgId, subscriptionId, appServer.usageCacheManager)

            const fileBuffer = await getFileFromUpload(tempPath)
            try {
                assertDocumentUploadSize(file.originalname, fileBuffer.length)
            } catch (error) {
                if (tempPath) {
                    try {
                        await removeSpecificFileFromUpload(tempPath)
                    } catch {
                        // The temp file is already gone when an earlier step removed it.
                    }
                }
                throw error
            }
            const fileNames: string[] = []
            const { path: storagePath, totalSize } = await addArrayFilesToStorage(
                file.mimetype,
                fileBuffer,
                file.originalname,
                fileNames,
                orgId,
                chatflowid,
                chatId
            )
            await updateStorageUsage(orgId, workspaceId, totalSize, appServer.usageCacheManager)

            const fileInputField = resolveFileInputField(file.originalname, file.mimetype)

            await removeSpecificFileFromUpload(file.path ?? file.key)

            // Track sanitized filename for cleanup if processing fails
            const sanitizedFilename = fileNames.length > 0 ? fileNames[0] : undefined

            try {
                const nodeData = {
                    inputs: {
                        [fileInputField]: storagePath
                    },
                    outputs: { output: 'document' }
                }

                // Apply PDF specific configuration if this is a PDF file
                if (fileInputField === 'pdfFile') {
                    nodeData.inputs.usage = pdfConfig.usage
                    nodeData.inputs.legacyBuild = pdfConfig.legacyBuild as unknown as string
                }

                let content = ''

                if (isBase64) {
                    content = fileBuffer.toString('base64')
                } else {
                    const documents: IDocument[] = await fileLoaderNodeInstance.init(nodeData, '', options)
                    content = documents.map((doc) => doc.pageContent).join('\n')
                }

                fileAttachments.push({
                    name: file.originalname,
                    mimeType: file.mimetype,
                    size: file.size,
                    content
                })
            } catch (error) {
                // Security: Clean up storage if processing failed, which includes invalid file type or content detacted from loader
                if (sanitizedFilename) {
                    logger.info(`Clean up storage for ${file.originalname} (${sanitizedFilename}). Reason: ${getErrorMessage(error)}`)
                    try {
                        const { totalSize: newTotalSize } = await removeSpecificFileFromStorage(
                            orgId,
                            chatflowid,
                            chatId,
                            sanitizedFilename
                        )
                        await updateStorageUsage(orgId, workspaceId, newTotalSize, appServer.usageCacheManager)
                    } catch (cleanupError) {
                        logger.error(
                            `Failed to cleanup storage for ${file.originalname} (${sanitizedFilename}) - ${getErrorMessage(cleanupError)}`
                        )
                    }
                }
                throw new Error(`Failed createFileAttachment: ${file.originalname} (${file.mimetype} - ${getErrorMessage(error)}`)
            }
        }
    }

    return fileAttachments
}
