import path from 'path'
import { randomBytes } from 'crypto'
import { CANONICAL_MIME_BY_EXTENSION } from './documentUploadCapabilities'
import { mapExtToInputField, mapMimeTypeToInputField } from './utils'

export { MAX_DOCUMENT_UPLOAD_BYTES } from './documentUploadCapabilities'

/**
 * Hard cut for extracted document text. The prediction question uses a tighter prepend
 * budget (8k tokens) and stubs a large file instead of pasting it. See packages/harness/uploads.mjs.
 */
export const DOCUMENT_TEXT_CHAR_CAP = 400_000

const GENERIC_MIMES = new Set([
    '',
    'application/octet-stream',
    'binary/octet-stream',
    'application/x-download',
    'application/download',
    'application/force-download',
    'application/binary'
])

/** Canonical MIME for a document extension the question path knows how to read. */
const CANONICAL_MIME_BY_EXT = CANONICAL_MIME_BY_EXTENSION

/** Browser and OS labels that mean the canonical type for that extension. `.js` is intentionally absent. */
const MIME_ALIASES_BY_EXT: Record<string, Record<string, string>> = {
    csv: {
        'application/csv': 'text/csv',
        'text/x-csv': 'text/csv',
        'text/comma-separated-values': 'text/csv',
        'text/plain': 'text/csv',
        'application/vnd.ms-excel': 'text/csv'
    },
    tsv: {
        'text/tab-separated-values': 'text/plain',
        'text/tsv': 'text/plain'
    },
    md: {
        'text/plain': 'text/markdown',
        'text/x-markdown': 'text/markdown'
    },
    markdown: {
        'text/plain': 'text/markdown',
        'text/x-markdown': 'text/markdown'
    },
    yaml: {
        'text/yaml': 'application/x-yaml',
        'application/yaml': 'application/x-yaml',
        'text/x-yaml': 'application/x-yaml',
        'text/vnd.yaml': 'application/x-yaml',
        'application/vnd.yaml': 'application/x-yaml'
    },
    yml: {
        'text/yaml': 'application/x-yaml',
        'application/yaml': 'application/x-yaml',
        'text/x-yaml': 'application/x-yaml',
        'text/vnd.yaml': 'application/x-yaml',
        'application/vnd.yaml': 'application/x-yaml'
    },
    pdf: {
        'application/x-pdf': 'application/pdf',
        'application/acrobat': 'application/pdf'
    },
    json: {
        'text/json': 'application/json',
        'text/plain': 'application/json'
    },
    jsonl: {
        'text/plain': 'application/jsonl',
        'application/x-ndjson': 'application/jsonl',
        'application/json-lines': 'application/jsonl'
    },
    html: { 'text/plain': 'text/html' },
    htm: { 'text/plain': 'text/html' },
    xml: {
        'text/xml': 'application/xml',
        'text/plain': 'application/xml'
    },
    sql: {
        'text/plain': 'application/sql',
        'text/x-sql': 'application/sql'
    },
    xlsx: {
        'application/zip': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    },
    xlsm: {
        'application/zip': 'application/vnd.ms-excel.sheet.macroenabled.12'
    },
    docx: {
        'application/zip': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    },
    pptx: {
        'application/zip': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    }
}

export class DocumentTextError extends Error {
    cause?: unknown

    constructor(message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'DocumentTextError'
        this.cause = options?.cause
    }
}

export const fileExtensionOf = (filename: string): string => {
    const base = path.basename(String(filename || ''))
    const dot = base.lastIndexOf('.')
    if (dot <= 0) return ''
    return base.slice(dot + 1).toLowerCase()
}

const declaredMime = (mime: string): string =>
    String(mime || '')
        .split(';')[0]
        .trim()
        .toLowerCase()

/**
 * Map a browser MIME to the canonical document MIME when the extension is one we read.
 * Unknown extensions, including `.js`, are left unchanged so the MIME/extension check still rejects spoofed scripts.
 */
export const normalizeDocumentMime = (filename: string, mime: string): string => {
    const declared = declaredMime(mime)
    const ext = fileExtensionOf(filename)
    const canonical = CANONICAL_MIME_BY_EXT[ext]
    if (!canonical) return declared
    if (GENERIC_MIMES.has(declared)) return canonical
    const alias = MIME_ALIASES_BY_EXT[ext]?.[declared]
    if (alias) return alias
    return declared
}

/** True when this filename is a document the question path can turn into text. */
export const isExtractableDocument = (filename: string, mime?: string): boolean => {
    const ext = fileExtensionOf(filename)
    if (!CANONICAL_MIME_BY_EXT[ext]) return false
    if (mime === undefined) return true
    const normalized = normalizeDocumentMime(filename, mime)
    return normalized === CANONICAL_MIME_BY_EXT[ext] || GENERIC_MIMES.has(declaredMime(mime))
}

/**
 * Picks the file input a stored upload is written to.
 * Spreadsheet and PowerPoint MIME types win over the extension default (`csvFile` / `txtFile`).
 */
export const resolveFileInputField = (filename: string, mimeType: string): string => {
    const fromMime = mapMimeTypeToInputField(mimeType || '')
    const fromExt = mapExtToInputField(`.${fileExtensionOf(filename)}`)
    if (fromMime === 'excelFile' || fromMime === 'powerpointFile') return fromMime
    if (fromExt !== 'txtFile') return fromExt
    if (fromMime !== 'txtFile') return fromMime
    return 'txtFile'
}

const sanitizeChatId = (chatId: string): string => String(chatId || '').replace(/[^A-Za-z0-9-]/g, '')

const safeBaseName = (fileName: string): string => {
    const base = path.basename(String(fileName || 'upload').replace(/\\/g, '/')).replace(/^\.+/, '')
    const cleaned = base.replace(/[\r\n\0]/g, '') || 'upload'
    return cleaned.slice(0, 120)
}

/**
 * Name stored for one prediction upload. The chat id is a prefix so two chats cannot overwrite
 * the same filename, and a nonce keeps a later upload in the same chat from replacing this file.
 * `used` suffixes a name that this request already stored.
 */
export const chatScopedUploadName = (chatId: string, fileName: string, options?: { used?: Set<string>; nonce?: string }): string => {
    const id = sanitizeChatId(chatId)
    if (!id) throw new DocumentTextError('A chat id is required to store an upload')
    const base = safeBaseName(fileName)
    const ext = path.extname(base)
    const stem = (ext ? base.slice(0, -ext.length) : base) || 'upload'
    const nonce = options?.nonce || randomBytes(4).toString('hex')
    let candidate = `${id}--${nonce}--${stem}${ext}`
    const used = options?.used
    if (!used) return candidate
    let n = 2
    while (used.has(candidate)) {
        candidate = `${id}--${nonce}--${stem}-${n}${ext}`
        n += 1
    }
    used.add(candidate)
    return candidate
}

/**
 * Name stored for an image, audio or other file kept in the chat's own folder. A nonce keeps a later upload of the same name
 * in this chat from replacing this file, and `used` suffixes a name that this request already stored. Path parts and leading
 * dots are dropped from the name.
 */
export const chatFolderUploadName = (fileName: string, options?: { used?: Set<string>; nonce?: string }): string => {
    const base = safeBaseName(fileName)
    const ext = path.extname(base)
    const stem = (ext ? base.slice(0, -ext.length) : base) || 'upload'
    const nonce = options?.nonce || randomBytes(4).toString('hex')
    let candidate = `${stem}--${nonce}${ext}`
    const used = options?.used
    if (!used) return candidate
    let n = 2
    while (used.has(candidate)) {
        candidate = `${stem}--${nonce}-${n}${ext}`
        n += 1
    }
    used.add(candidate)
    return candidate
}

/** True when a later turn may read this stored name from the chatflow directory. */
export const isChatScopedUploadName = (chatId: string, storedName: string): boolean => {
    const id = sanitizeChatId(chatId)
    return Boolean(id) && String(storedName || '').startsWith(`${id}--`)
}

export interface PdfReadOptions {
    usage: 'perPage' | 'perFile'
    legacyBuild: boolean
}

/** Question-path default is one block per file. A saved chatbot PDF setting overrides that. */
export const pdfOptionsFromChatbotConfig = (chatbotConfig?: string | null): PdfReadOptions => {
    const defaults: PdfReadOptions = { usage: 'perFile', legacyBuild: false }
    if (!chatbotConfig) return defaults
    try {
        const parsed = JSON.parse(chatbotConfig)
        const pdf = parsed?.fullFileUpload?.pdfFile
        const usage = pdf?.usage === 'perPage' || pdf?.usage === 'perFile' ? pdf.usage : 'perFile'
        const legacyBuild = pdf?.legacyBuild !== undefined ? Boolean(pdf.legacyBuild) : false
        return { usage, legacyBuild }
    } catch {
        return defaults
    }
}

/**
 * When Full File Upload is on and its allow list is non-empty, only those MIME types are accepted.
 * The prediction API still accepts documents when the toggle is off.
 */
export const isDocumentMimeAllowedByConfig = (mime: string, chatbotConfig?: string | null): boolean => {
    if (!chatbotConfig) return true
    try {
        const parsed = JSON.parse(chatbotConfig)
        const full = parsed?.fullFileUpload
        if (!full || full.status !== true) return true
        if (typeof full.allowedUploadFileTypes !== 'string') return true
        const allowed = full.allowedUploadFileTypes
            .split(',')
            .map((item: string) => item.trim())
            .filter(Boolean)
        if (!allowed.length) return true
        return allowed.includes(mime)
    } catch {
        return true
    }
}

const displayFileName = (filename: string): string => safeBaseName(filename)

const cutToCap = (text: string, maxChars: number): { text: string; truncated: boolean } => {
    if (text.length <= maxChars) return { text, truncated: false }
    let end = maxChars
    const code = text.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) end -= 1
    return { text: text.slice(0, Math.max(0, end)), truncated: true }
}

const joinPages = (docs: Array<{ pageContent?: string }>): string =>
    docs
        .map((doc) => doc?.pageContent || '')
        .join('\n')
        .replace(/\u0000/g, '')

async function loadDocumentPages(buffer: Buffer, ext: string, options: PdfReadOptions): Promise<Array<{ pageContent?: string }>> {
    const blob = new Blob([new Uint8Array(buffer)])
    switch (ext) {
        case 'pdf': {
            const { PDFLoader } = await import('@langchain/community/document_loaders/fs/pdf')
            const pdfjs = () => {
                if (options.legacyBuild) return import('pdfjs-dist/legacy/build/pdf.mjs')
                // pdf-parse ships this build without types. The File Loader uses the same path.
                // @ts-ignore
                return import('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')
            }
            const loader = new PDFLoader(blob, {
                splitPages: options.usage !== 'perFile',
                // The community loader's pdfjs option is not in its published types.
                // @ts-ignore
                pdfjs
            })
            return loader.load()
        }
        case 'csv': {
            // The community CSV loader imports d3-dsv at runtime, which fails under Jest and is optional.
            // The canvas CSV loader uses papaparse and returns one block of "column: value" lines per row.
            const { CSVLoader } = await import('../nodes/documentloaders/Csv/CsvLoader')
            return new CSVLoader(blob).load()
        }
        case 'xls':
        case 'xlsx':
        case 'xlsm':
        case 'xlsb': {
            const { LoadOfSheet } = await import('../nodes/documentloaders/MicrosoftExcel/ExcelLoader')
            return new LoadOfSheet(blob).load()
        }
        case 'doc':
        case 'docx': {
            const { DocxLoader } = await import('@langchain/community/document_loaders/fs/docx')
            return new DocxLoader(blob).load()
        }
        case 'ppt':
        case 'pptx': {
            const { PowerpointLoader } = await import('../nodes/documentloaders/MicrosoftPowerpoint/PowerpointLoader')
            return new PowerpointLoader(blob).load()
        }
        case 'json': {
            const { JSONLoader } = await import('@langchain/classic/document_loaders/fs/json')
            return new JSONLoader(blob).load()
        }
        case 'jsonl': {
            const { JSONLinesLoader } = await import('@langchain/classic/document_loaders/fs/json')
            return new JSONLinesLoader(blob, '/').load()
        }
        case 'txt':
        case 'text':
        case 'md':
        case 'markdown':
        case 'html':
        case 'htm':
        case 'css':
        case 'xml':
        case 'sql':
        case 'yaml':
        case 'yml':
        case 'tsv': {
            const { TextLoader } = await import('@langchain/classic/document_loaders/fs/text')
            return new TextLoader(blob).load()
        }
        default:
            throw new DocumentTextError(`File ${displayFileName(ext ? `file.${ext}` : 'file')} is not a supported document`)
    }
}

export interface ExtractedDocumentText {
    text: string
    truncated: boolean
}

/**
 * Read a document buffer into plain text. Does not use the File Loader's data-URI parser.
 * An empty result throws. Text past the cap is cut and `truncated` is set.
 */
export const extractDocumentText = async (
    buffer: Buffer,
    filename: string,
    options?: Partial<PdfReadOptions> & { maxChars?: number }
): Promise<ExtractedDocumentText> => {
    const ext = fileExtensionOf(filename)
    if (!CANONICAL_MIME_BY_EXT[ext]) {
        throw new DocumentTextError(`File ${displayFileName(filename)} is not a supported document`)
    }
    if (!buffer || !buffer.length) {
        throw new DocumentTextError(`Could not read any text from ${displayFileName(filename)}`)
    }
    const pdfOptions: PdfReadOptions = {
        usage: options?.usage === 'perPage' ? 'perPage' : 'perFile',
        legacyBuild: Boolean(options?.legacyBuild)
    }
    let pages: Array<{ pageContent?: string }>
    try {
        pages = await loadDocumentPages(buffer, ext, pdfOptions)
    } catch (error) {
        if (error instanceof DocumentTextError) throw error
        throw new DocumentTextError(`Could not read text from ${displayFileName(filename)}`, { cause: error })
    }
    const text = joinPages(pages).trim()
    if (!text) throw new DocumentTextError(`Could not read any text from ${displayFileName(filename)}`)
    return cutToCap(text, options?.maxChars ?? DOCUMENT_TEXT_CHAR_CAP)
}

/** Wrap extracted text the same way a full-file upload is prepended to the question. */
export const formatDocumentForQuestion = (name: string, text: string, truncated: boolean): string => {
    const safeName = displayFileName(name).replace(/['<>]/g, '')
    const body = text.replace(/<\/doc>/gi, '< /doc>')
    const marked = truncated ? `${body}\n\n[document truncated]` : body
    return `<doc name='${safeName}'>${marked}</doc>\n\n`
}

/**
 * Standard data URI (`data:<mime>;base64,<payload>`), including MIME types that contain dots.
 * Returns undefined for plain text, so an already-extracted `file:full` upload is left as text.
 */
export const parseDataUri = (value: string): { mime: string; buffer: Buffer } | undefined => {
    if (typeof value !== 'string' || !value.startsWith('data:')) return undefined
    const comma = value.indexOf(',')
    if (comma < 0) return undefined
    const header = value.slice(0, comma)
    if (!/;base64$/i.test(header)) return undefined
    const mimeMatch = /^data:([^;,]+)/i.exec(header)
    if (!mimeMatch) return undefined
    const payload = value.slice(comma + 1).trim()
    if (!payload) return undefined
    const buffer = Buffer.from(payload, 'base64')
    if (!buffer.length) return undefined
    return { mime: mimeMatch[1], buffer }
}
