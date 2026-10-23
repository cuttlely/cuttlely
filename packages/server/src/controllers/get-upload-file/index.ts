import { Request, Response, NextFunction } from 'express'
import fs from 'fs'
import contentDisposition from 'content-disposition'
import { isUnsafeFilePath, isValidUUID, streamStorageFile } from '@cuttlely/components'
import { StatusCodes } from 'http-status-codes'
import { AppError } from '../../errors/appError'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { Workspace } from '../../database/entities/identity'

const INLINE_IMAGE_TYPES = new Map<string, string>([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp']
])

/** The image type a file name is served inline as, or undefined for anything that is not a raster image. */
export function inlineImageType(fileName: string): string | undefined {
    const dot = fileName.lastIndexOf('.')
    if (dot < 0) return undefined
    return INLINE_IMAGE_TYPES.get(fileName.slice(dot + 1).toLowerCase())
}

const streamUploadedFile = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.query.chatflowId || !req.query.chatId || !req.query.fileName) {
            return res.status(500).send(`Invalid file path`)
        }
        // A repeated parameter arrives as an array, which would pass the checks below as its joined text.
        const { chatflowId, chatId, fileName } = req.query
        if (typeof chatflowId !== 'string' || typeof chatId !== 'string' || typeof fileName !== 'string') {
            return res.status(400).send(`Invalid file path`)
        }
        const download = req.query.download === 'true' // Check if download parameter is set

        // Validate input formats to prevent path traversal attacks
        if (!chatflowId || !isValidUUID(chatflowId)) {
            return res.status(400).send(`Invalid chatflowId format`)
        }

        if (!chatId) {
            return res.status(400).send(`chatId is missing`)
        }

        // Check for path traversal and unsafe characters in fileName
        if (isUnsafeFilePath(fileName)) {
            return res.status(400).send(`Invalid path characters detected in filename`)
        }

        const appServer = getRunningExpressApp()

        // This can be public API, so we can only get orgId from the chatflow
        const chatflow = await appServer.AppDataSource.getRepository(ChatFlow).findOneBy({
            id: chatflowId
        })
        if (!chatflow) {
            throw new AppError(StatusCodes.NOT_FOUND, `Chatflow ${chatflowId} not found`)
        }
        const chatflowWorkspaceId = chatflow.workspaceId
        const workspace = await appServer.AppDataSource.getRepository(Workspace).findOneBy({
            id: chatflowWorkspaceId
        })
        if (!workspace) {
            throw new AppError(StatusCodes.NOT_FOUND, `Workspace ${chatflowWorkspaceId} not found`)
        }
        const orgId = workspace.organizationId as string

        // Set Content-Disposition header - force attachment for download
        const inlineImage = download ? undefined : inlineImageType(fileName)
        if (download) {
            res.setHeader('Content-Disposition', contentDisposition(fileName, { type: 'attachment' }))
        } else if (inlineImage) {
            // A raster image without download=true is shown in place (an image link in an Orchestrate or A2A answer),
            // with its own type and no sniffing. Other files, SVG included, stay attachments.
            res.setHeader('Content-Disposition', contentDisposition(fileName, { type: 'inline' }))
            res.setHeader('Content-Type', inlineImage)
            res.setHeader('X-Content-Type-Options', 'nosniff')
        } else {
            res.setHeader('Content-Disposition', contentDisposition(fileName))
        }
        const fileStream = await streamStorageFile(chatflowId, chatId, fileName, orgId)

        if (!fileStream) throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: streamStorageFile`)

        if (fileStream instanceof fs.ReadStream && fileStream?.pipe) {
            fileStream.pipe(res)
        } else {
            res.send(fileStream)
        }
    } catch (error) {
        next(error)
    }
}

export default {
    streamUploadedFile
}
