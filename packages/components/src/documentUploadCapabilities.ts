/**
 * Document types the prediction upload path can read.
 * The chat config UI, the client allow check, and the server MIME allow list all use this list.
 * Extension aliases (`text`, `markdown`) stay so a saved file with that suffix still maps to the canonical MIME.
 */

/** Bytes of one document accepted on the question path. */
export const MAX_DOCUMENT_UPLOAD_BYTES = 25 * 1024 * 1024

/**
 * Room above the document cap. Busboy stops the part here so a file at the cap still
 * reaches the 25 MB check, and a larger part is refused before storage keeps it.
 */
export const MULTER_FILE_SIZE_ENVELOPE_BYTES = 64 * 1024

export const MULTER_FILE_SIZE_LIMIT = MAX_DOCUMENT_UPLOAD_BYTES + MULTER_FILE_SIZE_ENVELOPE_BYTES

/** Same threshold as `UPLOAD_STUB_BYTES` in `harness/uploads.mjs`. */
export const UPLOAD_STUB_BYTES = 1024 * 1024

export interface DocumentUploadType {
    /** Label in the upload configuration UI. */
    name: string
    /** Canonical MIME stored in chatbotConfig and checked after normalizeDocumentMime. */
    mime: string
    /** Lowercase extensions, without the dot. The first is the one shown first. */
    extensions: string[]
}

export const DOCUMENT_UPLOAD_TYPES: DocumentUploadType[] = [
    { name: 'PDF', mime: 'application/pdf', extensions: ['pdf'] },
    { name: 'CSV', mime: 'text/csv', extensions: ['csv'] },
    { name: 'Text / TSV', mime: 'text/plain', extensions: ['txt', 'tsv', 'text'] },
    { name: 'Markdown', mime: 'text/markdown', extensions: ['md', 'markdown'] },
    { name: 'HTML', mime: 'text/html', extensions: ['html', 'htm'] },
    { name: 'CSS', mime: 'text/css', extensions: ['css'] },
    { name: 'JSON', mime: 'application/json', extensions: ['json'] },
    { name: 'JSONL', mime: 'application/jsonl', extensions: ['jsonl'] },
    { name: 'YAML', mime: 'application/x-yaml', extensions: ['yaml', 'yml'] },
    { name: 'SQL', mime: 'application/sql', extensions: ['sql'] },
    { name: 'XML', mime: 'application/xml', extensions: ['xml'] },
    { name: 'DOC', mime: 'application/msword', extensions: ['doc'] },
    {
        name: 'DOCX',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extensions: ['docx']
    },
    { name: 'XLS', mime: 'application/vnd.ms-excel', extensions: ['xls'] },
    {
        name: 'XLSX',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extensions: ['xlsx']
    },
    { name: 'XLSM', mime: 'application/vnd.ms-excel.sheet.macroenabled.12', extensions: ['xlsm'] },
    { name: 'XLSB', mime: 'application/vnd.ms-excel.sheet.binary.macroenabled.12', extensions: ['xlsb'] },
    { name: 'PPT', mime: 'application/vnd.ms-powerpoint', extensions: ['ppt'] },
    {
        name: 'PPTX',
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        extensions: ['pptx']
    }
]

export const CANONICAL_MIME_BY_EXTENSION: Record<string, string> = {}
for (const type of DOCUMENT_UPLOAD_TYPES) {
    for (const ext of type.extensions) CANONICAL_MIME_BY_EXTENSION[ext] = type.mime
}

const SPREADSHEET_EXTENSIONS = new Set(['csv', 'tsv', 'xls', 'xlsx', 'xlsm', 'xlsb'])

export const extensionOfFilename = (filename: string): string => {
    const base = String(filename || '')
        .split(/[/\\]/)
        .pop()
    if (!base) return ''
    const dot = base.lastIndexOf('.')
    if (dot <= 0) return ''
    return base.slice(dot + 1).toLowerCase()
}

export const canonicalMimeForFilename = (filename: string): string => CANONICAL_MIME_BY_EXTENSION[extensionOfFilename(filename)] || ''

export const isSpreadsheetFilename = (filename: string): boolean => SPREADSHEET_EXTENSIONS.has(extensionOfFilename(filename))

/** A spreadsheet over the stub threshold stays on disk for a specialist to sample. */
export const isLargeSpreadsheet = (filename: string, size: number): boolean =>
    isSpreadsheetFilename(filename) && (Number(size) || 0) > UPLOAD_STUB_BYTES

/**
 * Client gate for Full File Upload. An empty list or `*` accepts every canonical document type.
 * A configured list is canonical MIME types. The size cap matches the server.
 */
export const isDocumentAllowedForFullUpload = (file: { name?: string; size?: number }, allowedMimeList?: string | null): boolean => {
    const size = Number(file?.size) || 0
    if (size <= 0 || size > MAX_DOCUMENT_UPLOAD_BYTES) return false
    const canonical = canonicalMimeForFilename(file?.name || '')
    if (!canonical) return false
    const allowed = String(allowedMimeList ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    if (!allowed.length || allowed.includes('*')) return true
    return allowed.includes(canonical)
}

/** Extensions shown next to the type name. Alias suffixes stay in the map and off the label. */
export const labelExtensions = (type: DocumentUploadType): string[] => type.extensions.filter((ext) => ext !== 'text' && ext !== 'markdown')
