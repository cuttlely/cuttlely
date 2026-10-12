import path from 'path'
import { StatusCodes } from 'http-status-codes'
import {
    IFileUpload,
    isDocumentMimeAllowedByConfig,
    isExtractableDocument,
    normalizeDocumentMime,
    parseDataUri,
    removeSpecificFileFromUpload,
    resolveFileInputField
} from '@cuttlely/components'
import { ChatFlow } from '../database/entities/ChatFlow'
import { AppError } from '../errors/appError'
import { INodeOverrides } from '../Interface'
import { computeUploadsConfig } from './getUploadsConfig'

/** What a chatflow lets a prediction upload. Computed from the same settings the chat UI and the embed widget read. */
export interface UploadPermissions {
    /** Image MIME types the flow accepts; empty when image uploads are off. */
    imageTypes: string[]
    speechToText: boolean
    /** File extensions (lower case, with the dot) a vector store on the flow takes from chat; null when chat file uploads are off. */
    ragExtensions: string[] | null
    /** Full file uploads (Chatbot settings, File upload) are on. */
    fullFile: boolean
    chatbotConfig?: string | null
}

const fullFileUploadOn = (chatbotConfig?: string | null): boolean => {
    if (!chatbotConfig) return false
    try {
        return JSON.parse(chatbotConfig)?.fullFileUpload?.status === true
    } catch {
        return false
    }
}

export const getUploadPermissions = (chatflow: Pick<ChatFlow, 'flowData' | 'speechToText' | 'chatbotConfig'>): UploadPermissions => {
    const config = computeUploadsConfig(chatflow)
    const imageTypes = config.isImageUploadAllowed
        ? [...new Set(config.imgUploadSizeAndTypes.flatMap((entry) => entry.fileTypes).filter(Boolean))]
        : []
    const ragExtensions = config.isRAGFileUploadAllowed
        ? [...new Set(config.fileUploadSizeAndTypes.flatMap((entry) => entry.fileTypes).map((type) => String(type).trim().toLowerCase()))]
        : null
    return {
        imageTypes,
        speechToText: config.isSpeechToTextEnabled,
        ragExtensions,
        fullFile: fullFileUploadOn(chatflow.chatbotConfig),
        chatbotConfig: chatflow.chatbotConfig
    }
}

const turnedOff = (kind: string): AppError => new AppError(StatusCodes.FORBIDDEN, `${kind} uploads are not turned on for this flow`)

const typeNotAllowed = (mime: string, name?: string): AppError =>
    new AppError(
        StatusCodes.BAD_REQUEST,
        `File type '${mime || path.extname(String(name || '')) || 'unknown'}' is not allowed for this flow`
    )

const extensionOf = (name?: string): string => path.extname(String(name || '')).toLowerCase()

/**
 * Throws (403 when that kind of upload is off for the flow, 400 for a type the flow does not take) unless the flow accepts
 * this upload from the prediction body. Only uploads that carry content are checked; a stored-file reference stores nothing.
 */
export const assertBodyUploadAllowed = (upload: IFileUpload, permissions: UploadPermissions): void => {
    const type = upload?.type
    if (type === 'stored-file' || type === 'stored-file:full') return
    const name = String(upload?.name || '')
    const declared = (upload?.data && parseDataUri(upload.data)?.mime) || String(upload?.mime || '')
    const lowered = declared.toLowerCase()
    const mime = lowered === 'image/jpg' ? 'image/jpeg' : lowered
    // Speech to text runs on any upload with an audio type, so that rule comes first.
    if (type === 'audio' || mime.startsWith('audio/')) {
        if (!permissions.speechToText) throw turnedOff('Audio')
        return
    }
    if (type === 'url') {
        if (!permissions.imageTypes.length) throw turnedOff('Image')
        return
    }
    if (!upload?.data) return
    if (type === 'file:full') {
        if (!permissions.fullFile) throw turnedOff('File')
        const docMime = normalizeDocumentMime(name, declared)
        if (!isDocumentMimeAllowedByConfig(docMime, permissions.chatbotConfig)) throw typeNotAllowed(docMime, name)
        return
    }
    if (type === 'file:rag') {
        if (!permissions.ragExtensions) throw turnedOff('File')
        if (mime.startsWith('image/') && permissions.imageTypes.includes(mime)) return
        const ext = extensionOf(name)
        const anyType = permissions.ragExtensions.some((entry) => entry === '*' || entry === '.*' || entry === '*.*')
        if (permissions.ragExtensions.length && !anyType && !permissions.ragExtensions.includes(ext)) throw typeNotAllowed(mime, name)
        return
    }
    if (type === 'file') {
        // The store step reads a file that looks like a document as one, so the document rule comes before the image rule.
        const docMime = normalizeDocumentMime(name, declared)
        if (isExtractableDocument(name, docMime)) {
            if (!permissions.fullFile) throw turnedOff('File')
            if (!isDocumentMimeAllowedByConfig(docMime, permissions.chatbotConfig)) throw typeNotAllowed(docMime, name)
            return
        }
        if (mime.startsWith('image/')) {
            if (!permissions.imageTypes.length) throw turnedOff('Image')
            if (!permissions.imageTypes.includes(mime)) throw typeNotAllowed(mime, name)
            return
        }
        if (!permissions.fullFile && !permissions.ragExtensions) throw turnedOff('File')
        throw typeNotAllowed(mime, name)
    }
    throw new AppError(StatusCodes.BAD_REQUEST, `Upload type '${String(type)}' is not supported`)
}

/** True when the flow's API override list allows a file on input `field` for some card (a document loader on the canvas). */
const overrideTakesFile = (field: string, apiOverrideStatus: boolean, nodeOverrides?: INodeOverrides | null): boolean => {
    if (apiOverrideStatus !== true || !nodeOverrides || typeof nodeOverrides !== 'object') return false
    return Object.values(nodeOverrides).some(
        (params) => Array.isArray(params) && params.some((param) => param?.name === field && param?.enabled === true)
    )
}

/**
 * Throws unless the flow accepts this multipart file: full file uploads are on and the flow takes this document type, or the
 * flow's API override list allows a file on the input this file would fill (a document loader that reads request files).
 */
export const assertMultipartFileAllowed = (
    file: { originalname: string; mimetype: string },
    field: string,
    permissions: UploadPermissions,
    apiOverrideStatus: boolean,
    nodeOverrides?: INodeOverrides | null
): void => {
    const mime = normalizeDocumentMime(file.originalname, file.mimetype)
    if (permissions.fullFile) {
        if (isExtractableDocument(file.originalname, mime)) {
            if (!isDocumentMimeAllowedByConfig(mime, permissions.chatbotConfig)) throw typeNotAllowed(mime, file.originalname)
            return
        }
        if (overrideTakesFile(field, apiOverrideStatus, nodeOverrides)) return
        throw typeNotAllowed(mime, file.originalname)
    }
    if (overrideTakesFile(field, apiOverrideStatus, nodeOverrides)) return
    throw turnedOff('File')
}

/** The flow's API override switch and node allowlist (only the boolean true turns overrides on). */
const readOverrideList = (apiConfig?: string | null): { apiOverrideStatus: boolean; nodeOverrides: INodeOverrides } => {
    try {
        const parsed = apiConfig ? JSON.parse(apiConfig) : {}
        return { apiOverrideStatus: parsed?.overrideConfig?.status === true, nodeOverrides: parsed?.overrideConfig?.nodes ?? {} }
    } catch {
        return { apiOverrideStatus: false, nodeOverrides: {} }
    }
}

type MultipartFile = { originalname: string; mimetype: string; path?: string; key?: string }

/**
 * Checks every upload in a prediction before anything is stored: the body uploads and the multipart files. A refused request
 * stores nothing, and its multipart temp files are removed. Throws 403 when that kind of upload is off for the flow, 400 for a
 * type the flow does not take.
 */
export const assertPredictionUploadsAllowed = async (
    chatflow: Pick<ChatFlow, 'flowData' | 'speechToText' | 'chatbotConfig' | 'apiConfig'>,
    uploads: unknown,
    files?: MultipartFile[]
): Promise<void> => {
    const bodyUploads = Array.isArray(uploads) ? (uploads as IFileUpload[]) : []
    if (!bodyUploads.length && !files?.length && !uploads) return
    try {
        // The store step walks anything with a length, so a list is the only accepted shape.
        if (uploads && !Array.isArray(uploads)) throw new AppError(StatusCodes.BAD_REQUEST, 'The uploads field must be a list')
        const permissions = getUploadPermissions(chatflow)
        for (const upload of bodyUploads) assertBodyUploadAllowed(upload, permissions)
        if (files?.length) {
            const { apiOverrideStatus, nodeOverrides } = readOverrideList(chatflow.apiConfig)
            for (const file of files) {
                // The same name repair the store step applies (multer reads names as latin1).
                const originalname = Buffer.from(String(file.originalname || ''), 'latin1').toString('utf8')
                const field = resolveFileInputField(originalname, normalizeDocumentMime(originalname, file.mimetype))
                assertMultipartFileAllowed({ originalname, mimetype: file.mimetype }, field, permissions, apiOverrideStatus, nodeOverrides)
            }
        }
    } catch (error) {
        for (const file of files ?? []) {
            const tempPath = file.path ?? file.key
            if (!tempPath) continue
            try {
                await removeSpecificFileFromUpload(tempPath)
            } catch {
                // Already gone.
            }
        }
        throw error
    }
}
