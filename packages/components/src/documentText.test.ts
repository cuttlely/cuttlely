import fs from 'fs'
import path from 'path'
import * as XLSX from 'xlsx'
import {
    chatScopedUploadName,
    chatFolderUploadName,
    extractDocumentText,
    formatDocumentForQuestion,
    isChatScopedUploadName,
    isDocumentMimeAllowedByConfig,
    isExtractableDocument,
    normalizeDocumentMime,
    parseDataUri,
    pdfOptionsFromChatbotConfig,
    resolveFileInputField
} from './documentText'
import { mapExtToInputField } from './utils'

const CHAT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CHAT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('normalizeDocumentMime', () => {
    it('maps generic and alias types for documents and leaves scripts alone', () => {
        expect(normalizeDocumentMime('notes.pdf', 'application/octet-stream')).toBe('application/pdf')
        expect(normalizeDocumentMime('notes.pdf', '')).toBe('application/pdf')
        expect(normalizeDocumentMime('notes.pdf', 'application/x-pdf')).toBe('application/pdf')
        expect(normalizeDocumentMime('rows.csv', 'application/vnd.ms-excel')).toBe('text/csv')
        expect(normalizeDocumentMime('rows.csv', 'application/csv')).toBe('text/csv')
        expect(normalizeDocumentMime('rows.csv', 'text/plain')).toBe('text/csv')
        expect(normalizeDocumentMime('book.xlsx', 'application/octet-stream')).toBe(
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
        expect(normalizeDocumentMime('book.xlsx', 'application/zip')).toBe(
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
        expect(normalizeDocumentMime('notes.md', 'text/plain')).toBe('text/markdown')
        expect(normalizeDocumentMime('config.yml', 'text/yaml')).toBe('application/x-yaml')
        expect(normalizeDocumentMime('app.js', 'application/octet-stream')).toBe('application/octet-stream')
        expect(normalizeDocumentMime('app.js', 'text/plain')).toBe('text/plain')
        expect(isExtractableDocument('app.js', 'text/plain')).toBe(false)
        expect(isExtractableDocument('notes.pdf', 'application/octet-stream')).toBe(true)
        expect(isExtractableDocument('rows.csv', 'application/pdf')).toBe(false)
    })
})

describe('resolveFileInputField', () => {
    it('sends spreadsheets and decks to their own inputs', () => {
        expect(mapExtToInputField('.xlsx')).toBe('excelFile')
        expect(mapExtToInputField('.XLS')).toBe('excelFile')
        expect(mapExtToInputField('.pptx')).toBe('powerpointFile')
        expect(mapExtToInputField('.yml')).toBe('yamlFile')
        expect(mapExtToInputField('.csv')).toBe('csvFile')
        expect(resolveFileInputField('book.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('excelFile')
        expect(resolveFileInputField('deck.pptx', 'application/vnd.ms-powerpoint')).toBe('powerpointFile')
        expect(resolveFileInputField('rows.csv', 'text/csv')).toBe('csvFile')
        expect(resolveFileInputField('notes.txt', 'text/plain')).toBe('txtFile')
    })
})

describe('chatScopedUploadName', () => {
    it('keeps chats apart and suffixes a repeated name in one request', () => {
        const used = new Set<string>()
        const first = chatScopedUploadName(CHAT_A, 'rows.csv', { used, nonce: 'abcd1234' })
        const second = chatScopedUploadName(CHAT_A, 'rows.csv', { used, nonce: 'abcd1234' })
        const other = chatScopedUploadName(CHAT_B, 'rows.csv', { nonce: 'abcd1234' })
        expect(first).toBe(`${CHAT_A}--abcd1234--rows.csv`)
        expect(second).toBe(`${CHAT_A}--abcd1234--rows-2.csv`)
        expect(other.startsWith(`${CHAT_B}--`)).toBe(true)
        expect(first).not.toBe(other)
        expect(isChatScopedUploadName(CHAT_A, first)).toBe(true)
        expect(isChatScopedUploadName(CHAT_A, other)).toBe(false)
        expect(isChatScopedUploadName(CHAT_A, 'rows.csv')).toBe(false)
    })
})

describe('chatFolderUploadName', () => {
    it('gives a repeated name a new stored name and keeps path parts out', () => {
        const used = new Set<string>()
        expect(chatFolderUploadName('cake.png', { used, nonce: 'abcd1234' })).toBe('cake--abcd1234.png')
        expect(chatFolderUploadName('cake.png', { used, nonce: 'abcd1234' })).toBe('cake--abcd1234-2.png')
        expect(chatFolderUploadName('cake.png')).not.toBe(chatFolderUploadName('cake.png'))
        expect(chatFolderUploadName('../../cake.png', { nonce: 'abcd1234' })).toBe('cake--abcd1234.png')
        expect(chatFolderUploadName('..\\..\\cake.png', { nonce: 'abcd1234' })).toBe('cake--abcd1234.png')
        expect(chatFolderUploadName('.hidden', { nonce: 'abcd1234' })).toBe('hidden--abcd1234')
        expect(chatFolderUploadName('', { nonce: 'abcd1234' })).toBe('upload--abcd1234')
    })
})

describe('chatbot config', () => {
    it('honors a non-empty allow list only when full file upload is on', () => {
        const restricted = JSON.stringify({
            fullFileUpload: { status: true, allowedUploadFileTypes: 'text/csv,application/pdf' }
        })
        expect(isDocumentMimeAllowedByConfig('text/csv', restricted)).toBe(true)
        expect(isDocumentMimeAllowedByConfig('application/pdf', restricted)).toBe(true)
        expect(isDocumentMimeAllowedByConfig('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', restricted)).toBe(false)
        const off = JSON.stringify({ fullFileUpload: { status: false, allowedUploadFileTypes: 'text/csv' } })
        expect(isDocumentMimeAllowedByConfig('application/pdf', off)).toBe(true)
        expect(pdfOptionsFromChatbotConfig(undefined).usage).toBe('perFile')
        const perPage = JSON.stringify({ fullFileUpload: { pdfFile: { usage: 'perPage', legacyBuild: true } } })
        expect(pdfOptionsFromChatbotConfig(perPage)).toEqual({ usage: 'perPage', legacyBuild: true })
    })
})

describe('parseDataUri', () => {
    it('reads a standard data URI and ignores plain extracted text', () => {
        const csv = Buffer.from('code,name\nDUR-77,amber\n', 'utf8').toString('base64')
        const parsed = parseDataUri(`data:text/csv;base64,${csv}`)
        expect(parsed?.mime).toBe('text/csv')
        expect(parsed?.buffer.toString('utf8')).toContain('DUR-77')
        const spreadsheet = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${csv}`
        expect(parseDataUri(spreadsheet)?.mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        expect(parseDataUri('code,name\nDUR-77,amber')).toBeUndefined()
    })
})

describe('extractDocumentText', () => {
    it('reads a csv into the question', async () => {
        const text = await extractDocumentText(Buffer.from('code,name\nDUR-77,amber\n', 'utf8'), 'rows.csv')
        expect(text.truncated).toBe(false)
        expect(text.text).toContain('DUR-77')
        expect(formatDocumentForQuestion('rows.csv', text.text, false)).toContain("<doc name='rows.csv'>")
    })

    it('reads an xlsx workbook', async () => {
        const workbook = XLSX.utils.book_new()
        const sheet = XLSX.utils.aoa_to_sheet([
            ['code', 'name'],
            ['DUR-77', 'amber']
        ])
        XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1')
        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
        const text = await extractDocumentText(buffer, 'book.xlsx')
        expect(text.text).toContain('DUR-77')
    })

    it('reads a pdf', async () => {
        const sample = path.join(path.dirname(require.resolve('pdf-parse/package.json')), 'test/data/01-valid.pdf')
        const text = await extractDocumentText(fs.readFileSync(sample), 'paper.pdf')
        expect(text.text).toContain('Andreas Gal')
    })

    it('marks text past the cap and rejects an empty file', async () => {
        const text = await extractDocumentText(Buffer.from('a'.repeat(50), 'utf8'), 'note.txt', { maxChars: 20 })
        expect(text.truncated).toBe(true)
        expect(text.text.length).toBeLessThanOrEqual(20)
        expect(formatDocumentForQuestion('note.txt', text.text, true)).toContain('[document truncated]')
        await expect(extractDocumentText(Buffer.alloc(0), 'empty.txt')).rejects.toThrow(/could not read any text/i)
    })
})
