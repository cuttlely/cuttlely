import fs from 'fs'
import path from 'path'
import { StatusCodes } from 'http-status-codes'
import {
    DocumentTextError,
    IFileUpload,
    addSingleFileToStorage,
    chatFolderUploadName,
    MAX_DOCUMENT_UPLOAD_BYTES,
    extractDocumentText,
    getStoragePath,
    getStorageType,
    isDocumentMimeAllowedByConfig,
    isExtractableDocument,
    normalizeDocumentMime,
    pdfOptionsFromChatbotConfig,
    resolveFileInputField
} from '@cuttlely/components'
import { AppError } from '../errors/appError'
import { getErrorMessage } from '../errors/utils'
import logger from './logger'
import { validateFileMimeTypeAndExtensionMatch } from './fileValidation'
import { loadUploadPolicy } from './uploadPolicy'

export interface PreparedPredictionUpload {
    mime: string
    field: string
    document: boolean
    text: string
    truncated: boolean
    stub: boolean
    size: number
    rows: number | null
    sheets: string[]
}

const displayFileName = (filename: string): string => {
    const base = String(filename || 'upload')
        .split(/[/\\]/)
        .pop()
    return (base || 'upload').replace(/[\r\n\0]/g, '').slice(0, 180)
}

/** Reject a document before its bytes are read when the multipart file is already over the cap. */
export const assertDocumentUploadSize = (filename: string, size: number): void => {
    if (size > MAX_DOCUMENT_UPLOAD_BYTES && isExtractableDocument(filename)) {
        throw new AppError(
            StatusCodes.BAD_REQUEST,
            `File ${displayFileName(filename)} is too large to send with the question. The limit is 25 MB.`
        )
    }
}

/**
 * Normalize and check one uploaded file, and read it when it is a document.
 * Images and audio come back with `document: false` so the caller keeps the existing store path.
 * A document that yields no text, or a type the chatflow's allow list excludes, is a 400.
 */
export const preparePredictionUpload = async (
    filename: string,
    declaredMime: string,
    buffer: Buffer,
    chatbotConfig?: string | null
): Promise<PreparedPredictionUpload> => {
    const mime = normalizeDocumentMime(filename, declaredMime)
    validateFileMimeTypeAndExtensionMatch(filename, mime)
    const field = resolveFileInputField(filename, mime)
    if (!isExtractableDocument(filename, mime)) {
        return { mime, field, document: false, text: '', truncated: false, stub: false, size: buffer.length, rows: null, sheets: [] }
    }
    if (!isDocumentMimeAllowedByConfig(mime, chatbotConfig)) {
        throw new AppError(StatusCodes.BAD_REQUEST, `File type '${mime}' is not allowed for this chatflow`)
    }
    if (buffer.length > MAX_DOCUMENT_UPLOAD_BYTES) {
        throw new AppError(
            StatusCodes.BAD_REQUEST,
            `File ${displayFileName(filename)} is too large to send with the question. The limit is 25 MB.`
        )
    }
    const policy = await loadUploadPolicy()
    if (!policy.uploadHasText(buffer)) {
        throw new AppError(StatusCodes.BAD_REQUEST, `Could not read any text from ${displayFileName(filename)}`)
    }
    const shape = await policy.describeSpreadsheet(filename, buffer)
    const stub = policy.shouldStubUpload({ filename, size: buffer.length, rows: shape.rows })
    if (stub) {
        return {
            mime,
            field,
            document: true,
            text: '',
            truncated: false,
            stub: true,
            size: buffer.length,
            rows: shape.rows,
            sheets: shape.sheets
        }
    }
    const pdf = pdfOptionsFromChatbotConfig(chatbotConfig)
    try {
        const extracted = await extractDocumentText(buffer, filename, pdf)
        return {
            mime,
            field,
            document: true,
            text: extracted.text,
            truncated: extracted.truncated,
            stub: false,
            size: buffer.length,
            rows: shape.rows,
            sheets: shape.sheets
        }
    } catch (error) {
        if (error instanceof AppError) throw error
        const cause = error instanceof DocumentTextError ? (error as DocumentTextError & { cause?: unknown }).cause : error
        if (cause) {
            logger.error(`[server]: document upload could not be read (${displayFileName(filename)}): ${getErrorMessage(cause)}`)
        }
        const message = error instanceof DocumentTextError ? error.message : `Could not read text from ${displayFileName(filename)}`
        throw new AppError(StatusCodes.BAD_REQUEST, message)
    }
}

const storageSegment = (value: string): string | undefined => {
    const base = path.basename(String(value || ''))
    if (!base || base === '.' || base === '..' || base.includes('..')) return undefined
    return base
}

/** Absolute path of a file just stored under the chatflow upload directory, when storage is local. */
export const localStoredUploadPath = (...parts: string[]): string | undefined => {
    if (getStorageType() !== 'local') return undefined
    const segments = parts.map(storageSegment)
    if (segments.some((part) => !part) || segments.length < 3) return undefined
    const file = path.join(getStoragePath(), ...(segments as string[]))
    return fs.existsSync(file) ? file : undefined
}

/** Stub or bounded `<doc>` block for one stored prediction upload. */
export const renderPredictionUploadQuestion = async (
    filename: string,
    prepared: PreparedPredictionUpload,
    absolutePath?: string
): Promise<string> => {
    const policy = await loadUploadPolicy()
    try {
        if (absolutePath) policy.assertAllowlistedUploadPath(absolutePath)
    } catch (error) {
        logger.error(`[server]: prediction upload path refused (${displayFileName(filename)}): ${getErrorMessage(error)}`)
        absolutePath = undefined
    }
    try {
        const part = policy.buildUploadQuestionPart({
            name: filename,
            mime: prepared.mime,
            size: prepared.size,
            absolutePath,
            rows: prepared.rows,
            sheets: prepared.sheets,
            extractedText: prepared.text,
            extractedTruncated: prepared.truncated
        })
        return part.block
    } catch (error) {
        const message = error instanceof Error ? error.message : `Could not read any text from ${displayFileName(filename)}`
        throw new AppError(StatusCodes.BAD_REQUEST, message)
    }
}

/**
 * Stores an image, audio or other file sent as a data URI in this chat's folder. The stored name carries a nonce, so a later
 * upload of the same name in this chat (or another file in this request, through `used`) never replaces it, and
 * `upload.name` becomes that stored name for later turns. Sets `upload.type` to `stored-file`.
 */
export const storeChatFolderUpload = async (
    upload: IFileUpload,
    orgId: string,
    chatflowid: string,
    chatId: string,
    used: Set<string>
): Promise<{ totalSize: number }> => {
    const splitDataURI = String(upload.data ?? '').split(',')
    const bf = Buffer.from(splitDataURI.pop() || '', 'base64')
    const mime = (splitDataURI[0] ?? '').split(':')[1]?.split(';')[0] ?? ''

    // Validate file extension, MIME type, and content to prevent security vulnerabilities
    validateFileMimeTypeAndExtensionMatch(upload.name, mime)

    const storedName = chatFolderUploadName(upload.name, { used })
    const { totalSize } = await addSingleFileToStorage(mime, bf, storedName, orgId, chatflowid, chatId)
    upload.name = storedName
    upload.type = 'stored-file'
    return { totalSize }
}
