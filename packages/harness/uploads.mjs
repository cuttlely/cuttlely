// Large prediction uploads stay on disk. The question gets a short stub, and a
// specialist samples the file. Token counts are ceil(chars / 4), same as context.mjs.
import fs from 'node:fs'
import path from 'node:path'
import { estimateTokens } from './context.mjs'
import { repoRoot } from './paths.mjs'

export const UPLOAD_PREPEND_TOKENS = 8000
export const UPLOAD_STUB_BYTES = 1024 * 1024
export const UPLOAD_STUB_ROWS = 1000
export const UPLOAD_CHAR_CAP = 400_000
export const SAMPLER_STDOUT_CAP = 4000

const SPREADSHEET_EXTENSIONS = new Set(['csv', 'tsv', 'xlsx', 'xls', 'xlsm', 'xlsb'])

export class UploadPathError extends Error {
    constructor(message = 'Upload path is not allowed') {
        super(message)
        this.name = 'UploadPathError'
        this.code = 'upload_path_refused'
    }
}

export function prependTokenBudget() {
    const raw = process.env.CUTTLELY_UPLOAD_PREPEND_TOKENS
    if (raw == null || String(raw).trim() === '') return UPLOAD_PREPEND_TOKENS
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) return UPLOAD_PREPEND_TOKENS
    return Math.floor(n)
}

export function extensionOf(filename) {
    const base = path.basename(String(filename || ''))
    const dot = base.lastIndexOf('.')
    if (dot <= 0) return ''
    return base.slice(dot + 1).toLowerCase()
}

export function isSpreadsheetName(filename) {
    return SPREADSHEET_EXTENSIONS.has(extensionOf(filename))
}

export function estimateUploadTokens(text) {
    return estimateTokens(text)
}

function cutChars(text, maxChars) {
    let end = Math.max(0, maxChars)
    if (end > 0 && end < text.length) {
        const code = text.charCodeAt(end - 1)
        if (code >= 0xd800 && code <= 0xdbff) end -= 1
    }
    return text.slice(0, end)
}

// 400_000 characters still cap an extraction. The question prepend then prefers the token budget.
export function boundPrependText(text, options = {}) {
    const charCap = options.charCap ?? UPLOAD_CHAR_CAP
    const tokens = options.tokenBudget ?? prependTokenBudget()
    let value = String(text ?? '')
    let truncated = Boolean(options.truncated)
    if (value.length > charCap) {
        value = cutChars(value, charCap)
        truncated = true
    }
    if (tokens > 0) {
        const tokenChars = tokens * 4
        if (value.length > tokenChars) {
            value = cutChars(value, tokenChars)
            truncated = true
        }
    }
    return { text: value, truncated }
}

export function shouldStubUpload({ filename, size, rows } = {}) {
    const bytes = Number(size) || 0
    if (bytes > UPLOAD_STUB_BYTES) return true
    if (isSpreadsheetName(filename) && rows != null && Number.isFinite(Number(rows)) && Number(rows) > UPLOAD_STUB_ROWS) return true
    return false
}

export function uploadHasText(buffer) {
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '')
    for (let i = 0; i < data.length; i += 1) {
        const c = data[i]
        if (c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 0) return true
    }
    return false
}

// Best-effort data-row count. A header line is not a data row. Quoted newlines count as one record.
export function countDelimitedRows(buffer) {
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '')
    if (!data.length) return 0
    let records = 0
    let inQuote = false
    let sawCell = false
    const finish = () => {
        if (sawCell) records += 1
        sawCell = false
    }
    for (let i = 0; i < data.length; i += 1) {
        const c = data[i]
        if (c === 34) {
            if (inQuote && data[i + 1] === 34) {
                i += 1
                sawCell = true
                continue
            }
            inQuote = !inQuote
            sawCell = true
            continue
        }
        if (!inQuote && (c === 10 || c === 13)) {
            finish()
            if (c === 13 && data[i + 1] === 10) i += 1
            continue
        }
        if (c !== 32 && c !== 9) sawCell = true
    }
    finish()
    if (!records) return 0
    return records - 1
}

function rowsFromRef(ref) {
    if (!ref || typeof ref !== 'string') return 0
    const end = ref.split(':').pop() || ''
    const match = /([0-9]+)$/.exec(end.replace(/\$/g, ''))
    if (!match) return 0
    return Math.max(0, Number(match[1]) - 1)
}

async function loadXlsx() {
    try {
        const { createRequire } = await import('node:module')
        const require = createRequire(path.join(repoRoot(), 'packages', 'components', 'package.json'))
        return require('xlsx')
    } catch {
        return null
    }
}

export async function describeSpreadsheet(filename, buffer) {
    const ext = extensionOf(filename)
    if (ext === 'csv' || ext === 'tsv') return { rows: countDelimitedRows(buffer), sheets: [] }
    if (!SPREADSHEET_EXTENSIONS.has(ext)) return { rows: null, sheets: [] }
    const xlsx = await loadXlsx()
    if (!xlsx) return { rows: null, sheets: [] }
    try {
        const workbook = xlsx.read(buffer, { type: 'buffer', cellFormula: false, cellHTML: false })
        const sheets = Array.isArray(workbook.SheetNames) ? workbook.SheetNames : []
        let rows = 0
        for (const name of sheets) {
            rows = Math.max(rows, rowsFromRef(workbook.Sheets?.[name]?.['!ref']))
        }
        return { rows, sheets }
    } catch {
        return { rows: null, sheets: [] }
    }
}

function displayName(filename) {
    const base = path.basename(String(filename || 'upload')).replace(/[\r\n\0]/g, '') || 'upload'
    return base.slice(0, 180)
}

function escapeAttr(value) {
    return String(value ?? '')
        .replace(/[\r\n\0]/g, '')
        .replace(/'/g, '')
}

export function formatPrependedDocument(name, text, truncated) {
    const safeName = displayName(name).replace(/['<>]/g, '')
    const body = String(text ?? '').replace(/<\/doc>/gi, '< /doc>')
    const marked = truncated ? `${body}\n\n[document truncated]` : body
    return `<doc name='${safeName}'>${marked}</doc>\n\n`
}

export function formatUploadStub({ name, absolutePath, size, mime, rows, sheets } = {}) {
    const attrs = [
        `name='${escapeAttr(displayName(name))}'`,
        `path='${escapeAttr(absolutePath || '')}'`,
        `bytes='${Number(size) || 0}'`,
        `mime='${escapeAttr(mime || '')}'`
    ]
    if (rows != null && Number.isFinite(Number(rows))) attrs.push(`rows='${Number(rows)}'`)
    if (Array.isArray(sheets) && sheets.length) attrs.push(`sheets='${escapeAttr(sheets.join(','))}'`)
    return (
        `<file ${attrs.join(' ')}>\n` +
        'Stored on disk. Do not paste this file into the prompt. Pass the path to the upload harness so a specialist can sample it.\n' +
        '</file>\n\n'
    )
}

export function uploadSource({ name, absolutePath, size, mime, rows, sheets } = {}) {
    return {
        pageContent: formatUploadStub({ name, absolutePath, size, mime, rows, sheets }).trim(),
        metadata: {
            source: displayName(name),
            bytes: Number(size) || 0,
            mime: String(mime || ''),
            ...(rows != null && Number.isFinite(Number(rows)) ? { rows: Number(rows) } : {}),
            ...(Array.isArray(sheets) && sheets.length ? { sheets: sheets.join(',') } : {}),
            storedFile: String(absolutePath || '')
        }
    }
}

export function buildUploadQuestionPart({ name, mime, size, absolutePath, rows, sheets, extractedText, extractedTruncated } = {}) {
    if (shouldStubUpload({ filename: name, size, rows })) {
        const block = formatUploadStub({ name, absolutePath, size, mime, rows, sheets })
        return {
            mode: 'stub',
            block,
            truncated: false,
            source: absolutePath ? uploadSource({ name, absolutePath, size, mime, rows, sheets }) : null
        }
    }
    const bounded = boundPrependText(extractedText, { truncated: extractedTruncated })
    if (!String(bounded.text || '').trim()) {
        const error = new Error(`Could not read any text from ${displayName(name)}`)
        error.code = 'empty_upload'
        throw error
    }
    return {
        mode: 'prepend',
        block: formatPrependedDocument(name, bounded.text, bounded.truncated),
        truncated: bounded.truncated,
        source: null
    }
}

export function storageRootFromEnv(env = process.env) {
    if (env.BLOB_STORAGE_PATH && String(env.BLOB_STORAGE_PATH).trim()) return path.resolve(env.BLOB_STORAGE_PATH)
    const home = env.HOME || env.USERPROFILE
    if (!home) return ''
    return path.resolve(home, '.cuttlely', 'storage')
}

export function defaultUploadRoots(env = process.env) {
    const root = storageRootFromEnv(env)
    return root ? [root] : []
}

function hasDotDot(candidate) {
    const normalized = String(candidate || '').replace(/\\/g, '/')
    return normalized.split('/').some((part) => part === '..')
}

function isInside(root, target) {
    const rel = path.relative(root, target)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
    return true
}

function realDir(dir) {
    try {
        return fs.realpathSync(dir)
    } catch {
        return path.resolve(dir)
    }
}

// A prediction upload lives at <storage>/<org>/<chatflow>/<file>. Anything else is refused.
export function assertAllowlistedUploadPath(candidate, roots = defaultUploadRoots()) {
    const raw = String(candidate || '')
    if (!raw || raw.includes('\0') || hasDotDot(raw)) throw new UploadPathError()
    let real
    try {
        real = fs.realpathSync(path.resolve(raw))
    } catch {
        throw new UploadPathError()
    }
    let stat
    try {
        stat = fs.statSync(real)
    } catch {
        throw new UploadPathError()
    }
    if (!stat.isFile()) throw new UploadPathError()
    for (const root of roots || []) {
        if (!root) continue
        const realRoot = realDir(root)
        if (!isInside(realRoot, real)) continue
        const parts = path.relative(realRoot, real).split(path.sep).filter(Boolean)
        if (parts.length < 3) throw new UploadPathError()
        if (parts.some((part) => part === '.' || part === '..')) throw new UploadPathError()
        return real
    }
    throw new UploadPathError()
}

export function stageUploadFile(sourcePath, workspaceDir, roots = defaultUploadRoots()) {
    const real = assertAllowlistedUploadPath(sourcePath, roots)
    const destDir = path.join(workspaceDir, 'uploads')
    fs.mkdirSync(destDir, { recursive: true })
    const dest = path.join(destDir, path.basename(real))
    fs.copyFileSync(real, dest)
    return dest
}

function parseAttrs(raw) {
    const attrs = {}
    // The lookbehind starts a name only at the start of a word, so a long run with no `=` is scanned once.
    const re = /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]+)='([^']*)'/g
    let match = re.exec(raw)
    while (match) {
        attrs[match[1]] = match[2]
        match = re.exec(raw)
    }
    return attrs
}

export function parseUploadStubs(text) {
    const stubs = []
    const re = /<file\b([^>]*)>[\s\S]*?<\/file>/gi
    let match = re.exec(String(text ?? ''))
    while (match) {
        const attrs = parseAttrs(match[1])
        stubs.push({
            name: attrs.name || '',
            path: attrs.path || '',
            bytes: attrs.bytes || '',
            mime: attrs.mime || '',
            rows: attrs.rows || '',
            sheets: attrs.sheets || '',
            rawPath: attrs.path || ''
        })
        match = re.exec(String(text ?? ''))
    }
    return stubs
}

function sampleScriptPath() {
    return path.join(repoRoot(), 'samples', 'scripts', 'sample_csv.py')
}

function copySampleScript(workspaceDir) {
    const script = sampleScriptPath()
    if (!fs.existsSync(script)) return ''
    const destDir = path.join(workspaceDir, 'uploads')
    fs.mkdirSync(destDir, { recursive: true })
    const dest = path.join(destDir, 'sample_csv.py')
    fs.copyFileSync(script, dest)
    return dest
}

function specialistSamplesFiles(specialist) {
    return Boolean(specialist?.codeExecution || specialist?.shell || specialist?.fileAccess)
}

// Stage allowlisted uploads into each sampling specialist's workspace and drop any other path.
export function prepareHarnessTurnUploads({ question, specialists, workspaceFor, roots } = {}) {
    const text = String(question ?? '')
    const stubs = parseUploadStubs(text)
    if (!stubs.length) return { question: text, sources: [], notes: new Map() }
    const rootList = roots || defaultUploadRoots()
    let rewritten = text
    const sources = []
    const accepted = []
    for (const stub of stubs) {
        try {
            const real = assertAllowlistedUploadPath(stub.path, rootList)
            const next = { ...stub, path: real }
            accepted.push(next)
            sources.push(
                uploadSource({
                    name: stub.name,
                    absolutePath: real,
                    size: stub.bytes,
                    mime: stub.mime,
                    rows: stub.rows === '' ? null : Number(stub.rows),
                    sheets: stub.sheets ? String(stub.sheets).split(',').filter(Boolean) : []
                })
            )
        } catch {
            if (stub.rawPath) rewritten = rewritten.split(stub.rawPath).join('[upload path refused]')
        }
    }
    const notes = new Map()
    for (const specialist of specialists || []) {
        if (!specialistSamplesFiles(specialist) || !accepted.length) continue
        const workspace = typeof workspaceFor === 'function' ? workspaceFor(specialist) : ''
        if (!workspace) continue
        const lines = ['Sample these uploaded files from disk. Do not print, cat, or return the whole file.']
        for (const stub of accepted) {
            try {
                const staged = stageUploadFile(stub.path, workspace, rootList)
                lines.push(
                    `- name=${stub.name || path.basename(staged)} staged=${staged} bytes=${stub.bytes || ''} rows=${stub.rows || ''} mime=${
                        stub.mime || ''
                    }`
                )
            } catch {
                lines.push(`- name=${stub.name || 'upload'} path refused`)
            }
        }
        const script = copySampleScript(workspace)
        if (script) {
            lines.push(
                `Helper: python ${script} <staged csv path>. It prints a short sample, caps stdout at ${SAMPLER_STDOUT_CAP} characters, and refuses to dump the file.`
            )
        }
        notes.set(specialist.name, lines.join('\n'))
    }
    return { question: rewritten, sources, notes }
}
