import fs from 'fs'
import path from 'path'
import { isAllowedUploadMimeType } from './utils'
import {
    CANONICAL_MIME_BY_EXTENSION,
    DOCUMENT_UPLOAD_TYPES,
    MAX_DOCUMENT_UPLOAD_BYTES,
    MULTER_FILE_SIZE_LIMIT,
    UPLOAD_STUB_BYTES,
    isDocumentAllowedForFullUpload,
    isLargeSpreadsheet
} from './documentUploadCapabilities'

const REQUIRED_EXTENSIONS = [
    'pdf',
    'csv',
    'tsv',
    'txt',
    'text',
    'md',
    'markdown',
    'html',
    'htm',
    'css',
    'json',
    'jsonl',
    'yaml',
    'yml',
    'sql',
    'xml',
    'doc',
    'docx',
    'xls',
    'xlsx',
    'xlsm',
    'xlsb',
    'ppt',
    'pptx'
]

describe('document upload capabilities', () => {
    it('maps every question-path extension and allows those MIME types in config', () => {
        for (const ext of REQUIRED_EXTENSIONS) {
            expect(CANONICAL_MIME_BY_EXTENSION[ext]).toBeTruthy()
            expect(isAllowedUploadMimeType(CANONICAL_MIME_BY_EXTENSION[ext])).toBe(true)
        }
        expect(isAllowedUploadMimeType('application/javascript')).toBe(false)
        expect(isAllowedUploadMimeType('text/javascript')).toBe(false)
        const mimes = new Set(DOCUMENT_UPLOAD_TYPES.map((type) => type.mime))
        expect(mimes.has('application/jsonl')).toBe(true)
        expect(mimes.has('application/vnd.ms-excel')).toBe(true)
        expect(mimes.has('application/vnd.ms-excel.sheet.macroenabled.12')).toBe(true)
        expect(mimes.has('application/vnd.ms-excel.sheet.binary.macroenabled.12')).toBe(true)
        expect(mimes.has('application/vnd.ms-powerpoint')).toBe(true)
    })

    it('keeps the client allow check on the same size and MIME list', () => {
        expect(isDocumentAllowedForFullUpload({ name: 'notes.pdf', size: 12 }, '*')).toBe(true)
        expect(isDocumentAllowedForFullUpload({ name: 'notes.pdf', size: 12 }, '')).toBe(true)
        expect(isDocumentAllowedForFullUpload({ name: 'notes.pdf', size: 12 }, 'application/pdf,text/csv')).toBe(true)
        expect(isDocumentAllowedForFullUpload({ name: 'book.xlsx', size: 12 }, 'application/pdf,text/csv')).toBe(false)
        expect(isDocumentAllowedForFullUpload({ name: 'rows.tsv', size: 12 }, 'text/plain')).toBe(true)
        expect(isDocumentAllowedForFullUpload({ name: 'app.js', size: 12 }, '*')).toBe(false)
        expect(isDocumentAllowedForFullUpload({ name: 'notes.pdf', size: MAX_DOCUMENT_UPLOAD_BYTES + 1 }, '*')).toBe(false)
        expect(isDocumentAllowedForFullUpload({ name: 'notes.pdf', size: 0 }, '*')).toBe(false)
    })

    it('hints a spreadsheet over the stub threshold and matches the harness constant', () => {
        expect(isLargeSpreadsheet('book.xlsx', UPLOAD_STUB_BYTES + 1)).toBe(true)
        expect(isLargeSpreadsheet('rows.csv', UPLOAD_STUB_BYTES)).toBe(false)
        expect(isLargeSpreadsheet('notes.pdf', UPLOAD_STUB_BYTES + 1)).toBe(false)
        const harness = fs.readFileSync(path.join(__dirname, '../../../harness/uploads.mjs'), 'utf8')
        expect(harness).toContain('export const UPLOAD_STUB_BYTES = 1024 * 1024')
        expect(UPLOAD_STUB_BYTES).toBe(1024 * 1024)
        expect(MULTER_FILE_SIZE_LIMIT).toBeGreaterThan(MAX_DOCUMENT_UPLOAD_BYTES)
        expect(MULTER_FILE_SIZE_LIMIT - MAX_DOCUMENT_UPLOAD_BYTES).toBeLessThanOrEqual(1024 * 1024)
    })

    it('chat config and the in-app chat use this list and do not link Flowise upload docs', () => {
        const config = fs.readFileSync(path.join(__dirname, '../../ui/src/ui-component/extended/FileUpload.jsx'), 'utf8')
        const chat = fs.readFileSync(path.join(__dirname, '../../ui/src/views/chatmessage/ChatMessage.jsx'), 'utf8')
        expect(config).toContain('DOCUMENT_UPLOAD_TYPES')
        expect(config).not.toContain('docs.flowiseai.com')
        expect(config).not.toContain('full contents of uploaded files')
        expect(chat).not.toContain('attachmentsApi')
        expect(chat).toContain('isDocumentAllowedForFullUpload')
        expect(chat).toContain('sendMessageWithFiles')
        expect(chat).toContain('uploadKind')
    })
})
