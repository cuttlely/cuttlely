import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EtlError } from './errors.mjs'
import { etlDir } from './db.mjs'
import { compareSegments, splitList, walkFiles } from './ignore.mjs'
import { readDelimitedRows, readHeader, readLines, readSegments } from './readers.mjs'
import { initNode } from './nodes.mjs'
import { stableStringify } from './graph.mjs'
import { JsonStrictError, parseStrict } from './json-strict.mjs'
import { checkUploadAccess, entryRoots, pathAccess, relativeKey, repoDataExcludes } from './paths.mjs'
import { coerceValue, defaultCaps, flattenLoaderMetadata, jsonMetadata, parseSchema, RecordReject } from './schema.mjs'

const run = promisify(execFile)

const LANGUAGES = {
    js: 'js',
    jsx: 'js',
    mjs: 'js',
    cjs: 'js',
    ts: 'ts',
    tsx: 'ts',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    rb: 'ruby',
    php: 'php',
    cs: 'csharp',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    hpp: 'cpp',
    swift: 'swift',
    scala: 'scala',
    sol: 'sol',
    md: 'markdown',
    mdx: 'markdown',
    html: 'html',
    css: 'css',
    sql: 'sql',
    sh: 'shell',
    yaml: 'yaml',
    yml: 'yaml',
    json: 'json',
    toml: 'toml'
}

function intInput(value, fallback) {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : fallback
}

function boolInput(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback
    return value === true || value === 'true'
}

// Read access for a source path (O3): see pathAccess in paths.mjs. Gives the resolved path or throws bad_source.
export function checkPath(target, options = {}) {
    return pathAccess(target, options).path
}

export function formatFor(file, format) {
    if (format && format !== 'auto') return format
    const ext = path.extname(file).toLowerCase()
    if (ext === '.csv') return 'csv'
    if (ext === '.tsv') return 'tsv'
    if (ext === '.jsonl' || ext === '.ndjson') return 'jsonl'
    return 'text'
}

// A run-level problem found while reading (bad header, missing key config): the run fails instead of the unit.
function fatal(code, message) {
    const error = new EtlError(code, message)
    error.fatal = true
    return error
}

// The key column (CSV) or field (JSONL). JSONL used to read `idField`, which the node never declared (E8).
export function keyColumn(inputs) {
    return String(inputs.idColumn ?? inputs.idField ?? '').trim()
}

const MAX_KEY_CHARS = 512

// Keys are NFC-normalized and trimmed; empty is missing_key, over 512 characters is value_too_long:key.
export function normalizeKey(raw) {
    if (raw === null || raw === undefined) throw new RecordReject('missing_key', null, 'the key is missing')
    const key = String(raw?.$bigint ?? raw)
        .normalize('NFC')
        .trim()
    if (!key) throw new RecordReject('missing_key', null, 'the key is empty')
    if (key.length > MAX_KEY_CHARS)
        throw new RecordReject('value_too_long', 'key', `the key is ${key.length} characters (cap ${MAX_KEY_CHARS})`)
    return key
}

// Everything upstream of embedding that shapes a source's records, so changing the schema, the key, a transform or
// the splitter re-reads an unchanged file (E8). Paths and folder globs are left out; they change the unit set instead.
export function configHash(source) {
    const inputs = { ...(source.inputs || {}) }
    delete inputs.paths
    delete inputs.include
    delete inputs.exclude
    return crypto
        .createHash('sha256')
        .update(
            stableStringify({
                inputs,
                transforms: (source.transforms || []).map((t) => t.inputs || {}),
                splitter: source.splitter ? { name: source.splitter.nodeName, inputs: source.splitter.inputs || {} } : null
            })
        )
        .digest('hex')
        .slice(0, 12)
}

// `workspaceId` is the pipeline's workspace: an upload path must be in that workspace's upload folder, and a
// folder walk skips uploads that belong to other workspaces.
function fileList(inputs, { workspaceId } = {}) {
    const entries = splitList(inputs.paths)
    if (!entries.length) throw new EtlError('bad_source', 'Streaming Files needs at least one file or folder path.')
    const include = splitList(inputs.include)
    const resolved = entries.map((entry) => checkPath(entry, { workspaceId }))
    for (const abs of resolved) checkUploadAccess(abs, workspaceId)
    const readable = (file) => {
        try {
            checkUploadAccess(file, workspaceId)
            return true
        } catch {
            return false
        }
    }
    const roots = entryRoots(resolved, { workspaceId })
    const files = []
    entries.forEach((entry, i) => {
        const abs = resolved[i]
        const root = roots[i]
        let stat
        try {
            stat = fs.statSync(abs)
        } catch {
            throw new EtlError('bad_source', `File or folder "${path.basename(entry)}" was not found on the server.`)
        }
        const add = (file, size, mtimeMs) => {
            const rel = relativeKey(file, root)
            files.push({ key: `${root.label}/${rel}`, rel, root: root.showLabel ? root.label : null, abs: file, size, mtimeMs })
        }
        if (stat.isDirectory()) {
            for (const file of walkFiles(abs, { respectGitignore: false, include })) {
                if (readable(file.abs)) add(file.abs, file.size, file.mtimeMs)
            }
        } else add(abs, stat.size, Math.floor(stat.mtimeMs))
    })
    files.sort((a, b) => compareSegments(a.key, b.key))
    return files.filter((file, i) => i === 0 || files[i - 1].key !== file.key)
}

function baseMetadata(file, extra) {
    return file.root ? { source: file.rel, root: file.root, ...extra } : { source: file.rel, ...extra }
}

// A rejected record keeps what is known about it: its key if one could be read, its position and the raw text.
function rejected(error, fields) {
    const reject = error instanceof RecordReject ? error : new RecordReject(error.code || 'parse_error', error.field, error.message)
    return { reject: { code: reject.code, field: reject.field, reason: reject.reason, message: reject.message }, ...fields }
}

function csvDocs(file, inputs, format) {
    const delimiter = inputs.delimiter ? String(inputs.delimiter).replace('\\t', '\t') : format === 'tsv' ? '\t' : ','
    const textColumns = splitList(inputs.textColumns)
    const metadataColumns = splitList(inputs.metadataColumns)
    const idColumn = keyColumn(inputs)
    const schema = parseSchema(inputs.schema)
    const caps = schema?.caps || defaultCaps()
    const allowTrailing = boolInput(inputs.allowTrailingDelimiter, true)
    const name = file.rel
    return async function* docs({ offset = 0, ordinal = 0 } = {}) {
        if (!idColumn)
            throw fatal(
                'missing_key_config',
                `Streaming Files reads ${name} as ${format.toUpperCase()}; set "Key column or field" so edited rows replace their old chunks.`
            )
        const header = await readHeader(file.abs, delimiter)
        if (header.error) throw fatal('bad_source', `The header row of ${name} is malformed: ${header.error.message}.`)
        if (header.duplicates.length)
            throw fatal(
                'duplicate_header',
                `duplicate_header: ${name} has more than one column named ${header.duplicates.map((d) => `"${d}"`).join(', ')}.`
            )
        const columns = header.fields
        const index = new Map(columns.map((col, i) => [col, i]))
        const wanted = [...textColumns, ...metadataColumns, idColumn, ...Object.keys(schema?.fields || {})]
        const missing = [...new Set(wanted.filter((col) => !index.has(col)))]
        if (missing.length)
            throw fatal('missing_column', `missing_column:${missing[0]}: ${name} has no column ${missing.map((m) => `"${m}"`).join(', ')}.`)
        const textIdx = (textColumns.length ? textColumns : columns).map((col) => index.get(col))
        const nullValues = schema?.nullValues || ['']
        let row = ordinal
        let first = offset === 0 || offset < header.next
        for await (const record of readDelimitedRows(file.abs, {
            start: Math.max(offset, header.next),
            delimiter,
            maxRecordBytes: caps.maxRecordBytes
        })) {
            row += 1
            const bom = first && header.bom
            first = false
            const position = { offset: record.offset, next: record.next, ordinal: row, strict: true, bom }
            const rawLine = () => record.fields.join(delimiter)
            if (record.error) {
                yield rejected(record.error, { ...position, raw: rawLine() })
                continue
            }
            const fields =
                allowTrailing && record.trailingEmpty && record.fields.length === columns.length + 1
                    ? record.fields.slice(0, -1)
                    : record.fields
            const keyIdx = index.get(idColumn)
            const value = (i) => {
                const raw = fields[i]
                if (raw === undefined) return null
                if (!record.quoted[i] && nullValues.includes(raw)) return null
                return raw
            }
            const keyGuess = fields[keyIdx]
            try {
                if (fields.length !== columns.length)
                    throw new RecordReject('field_count', null, `${fields.length} fields, the header has ${columns.length}`)
                const docKey = normalizeKey(value(keyIdx))
                const typed = {}
                const coerced = {}
                for (const [field, def] of Object.entries(schema?.fields || {})) {
                    coerced[field] = coerceValue(field, def, value(index.get(field)), { fromCsv: true })
                    if (def.type === 'json' || def.maxLength) typed[field] = true
                }
                let nullText = 0
                const parts = []
                for (const i of textIdx) {
                    const v = value(i)
                    if (v === null || v === '') {
                        nullText += 1
                        continue
                    }
                    parts.push(textIdx.length === 1 ? v : `${columns[i]}: ${v}`)
                }
                const metadata = baseMetadata(file, { row })
                for (const col of metadataColumns) metadata[col] = Object.hasOwn(coerced, col) ? coerced[col] : value(index.get(col))
                yield { pageContent: parts.join('\n'), metadata, docKey, typed, caps, coercions: { nullText }, raw: rawLine(), ...position }
            } catch (error) {
                if (!(error instanceof RecordReject)) throw error
                yield rejected(error, { ...position, docKey: keyGuess ? String(keyGuess).trim() : undefined, raw: rawLine() })
            }
        }
    }
}

function jsonlDocs(file, inputs) {
    const textField = String(inputs.textField || '').trim()
    const idField = keyColumn(inputs)
    const schema = parseSchema(inputs.schema)
    const caps = schema?.caps || defaultCaps()
    const name = file.rel
    return async function* docs({ offset = 0, ordinal = 0 } = {}) {
        if (!idField)
            throw fatal(
                'missing_key_config',
                `Streaming Files reads ${name} as JSON Lines; set "Key column or field" so edited lines replace their old chunks.`
            )
        let line = ordinal
        for await (const record of readLines(file.abs, { start: offset, maxRecordBytes: caps.maxRecordBytes })) {
            line += 1
            const position = { offset: record.offset, next: record.next, ordinal: line, strict: true, bom: Boolean(record.bom) }
            if (record.error) {
                yield rejected(record.error, { ...position, raw: record.text })
                continue
            }
            if (record.blank) {
                yield { filter: 'blank_line', ...position }
                continue
            }
            let obj
            try {
                obj = parseStrict(record.text)
                if (!obj || typeof obj !== 'object' || Array.isArray(obj))
                    throw new RecordReject('parse_error', null, 'JSONL records must be objects')
            } catch (error) {
                if (error instanceof JsonStrictError) {
                    // A too-deep path can be 32 segments; the reason names the top-level field, the message the full path.
                    const field = error.code === 'json_too_deep' && error.field ? error.field.split('.')[0] : error.field
                    yield rejected(new RecordReject(error.code, field, `line ${line}: ${error.message}`), { ...position, raw: record.text })
                    continue
                }
                if (error instanceof RecordReject) {
                    yield rejected(error, { ...position, raw: record.text })
                    continue
                }
                throw error
            }
            const field = textField || ['text', 'content', 'body'].find((key) => typeof obj[key] === 'string')
            const text = field && typeof obj[field] === 'string' ? obj[field] : JSON.stringify(obj)
            try {
                const docKey = normalizeKey(Object.hasOwn(obj, idField) ? obj[idField] : null)
                const { metadata, typed } = jsonMetadata(obj, { schema, skip: field ? [field] : [] })
                const typedCaps = {}
                for (const key of Object.keys(typed))
                    if (schema.fields[key].type === 'json' || schema.fields[key].maxLength) typedCaps[key] = true
                yield {
                    pageContent: text,
                    metadata: { ...baseMetadata(file, { line }), ...metadata },
                    docKey,
                    typed: typedCaps,
                    caps,
                    raw: record.text,
                    ...position
                }
            } catch (error) {
                if (!(error instanceof RecordReject)) throw error
                const guess = obj[idField]
                yield rejected(error, {
                    ...position,
                    docKey: guess != null && typeof guess !== 'object' ? String(guess) : undefined,
                    raw: record.text
                })
            }
        }
    }
}

function textDocs(file, inputs) {
    const segmentBytes = intInput(inputs.segmentKb, 256) * 1024
    return async function* docs({ offset = 0, ordinal = 0 } = {}) {
        let segment = ordinal
        for await (const part of readSegments(file.abs, { start: offset, segmentBytes })) {
            segment += 1
            yield {
                pageContent: part.text,
                metadata: baseMetadata(file, { segment }),
                // Two roots can hold the same relative path, so the shown root label is part of the key (E16).
                docKey: `${file.root ? `${file.root}/` : ''}${file.rel}#${segment}`,
                offset: part.offset,
                next: part.next,
                ordinal: segment,
                bom: Boolean(part.bom)
            }
        }
    }
}

function fileDocs(file, inputs) {
    const format = formatFor(file.abs, inputs.format)
    if (format === 'csv' || format === 'tsv') return csvDocs(file, inputs, format)
    if (format === 'jsonl') return jsonlDocs(file, inputs)
    return textDocs(file, inputs)
}

const NUL = 0

function looksBinary(file) {
    const fd = fs.openSync(file, 'r')
    try {
        const buf = Buffer.alloc(8192)
        const n = fs.readSync(fd, buf, 0, buf.length, 0)
        return buf.subarray(0, n).includes(NUL)
    } finally {
        fs.closeSync(fd)
    }
}

function safeGitUrl(url) {
    let parsed
    try {
        parsed = new URL(url)
    } catch {
        throw new EtlError('bad_source', `"${url}" is not a git URL.`)
    }
    if (parsed.protocol !== 'https:') throw new EtlError('bad_source', 'Code Repository clones https URLs only.')
    const host = parsed.hostname
    if (/^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd])/i.test(host)) {
        throw new EtlError('bad_source', 'Code Repository does not clone from loopback or private addresses.')
    }
    return parsed.toString()
}

// `--` ends git's options, so a branch or URL that starts with `-` (say `--upload-pack=...`) is never read as one.
export function gitSyncArgs({ dir, url, branch, existing }) {
    if (branch.startsWith('-')) throw new EtlError('bad_source', `Branch "${branch}" is not a branch name.`)
    if (existing) return ['-C', dir, 'fetch', '--depth', '1', 'origin', '--', branch || 'HEAD']
    return ['clone', '--depth', '1', ...(branch ? ['--branch', branch] : []), '--', url, dir]
}

async function ensureRepo(source, ctx) {
    const inputs = source.inputs || {}
    if (inputs.repoPath) {
        const access = pathAccess(inputs.repoPath, { workspaceId: ctx.workspaceId, repo: true })
        const root = access.path
        if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
            throw new EtlError('bad_source', `Repository folder "${inputs.repoPath}" was not found on the server.`)
        }
        return { root, label: inputs.repoLabel || path.basename(root), checkout: access.via === 'repo' }
    }
    if (!inputs.gitUrl) throw new EtlError('bad_source', 'Code Repository needs a folder path or a git URL.')
    const url = safeGitUrl(inputs.gitUrl)
    const branch = String(inputs.branch || '').trim()
    const dir = path.join(etlDir(), 'repos', `${ctx.pipelineId || 'preview'}-${source.nodeId}`.replace(/[^A-Za-z0-9_.-]/g, '_'))
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    if (fs.existsSync(path.join(dir, '.git'))) {
        await run('git', gitSyncArgs({ dir, url, branch, existing: true }), { env, timeout: 600000 })
        await run('git', ['-C', dir, 'reset', '--hard', 'FETCH_HEAD'], { env, timeout: 120000 })
    } else {
        fs.mkdirSync(path.dirname(dir), { recursive: true })
        await run('git', gitSyncArgs({ dir, url, branch, existing: false }), { env, timeout: 600000 })
    }
    return {
        root: dir,
        label:
            inputs.repoLabel ||
            url
                .replace(/\.git$/, '')
                .split('/')
                .slice(-2)
                .join('/')
    }
}

// `checkout`: the folder was allowed only as the Cuttlely checkout (O3), so gitignore and the default ignores are on
// whatever the node says, and the data folder is left out.
export function repoFiles(root, inputs, { checkout = false } = {}) {
    return walkFiles(root, {
        respectGitignore: checkout || boolInput(inputs.respectGitignore, true),
        useDefaults: checkout || boolInput(inputs.defaultIgnores, true),
        include: splitList(inputs.include),
        exclude: [...splitList(inputs.exclude), ...(checkout ? repoDataExcludes(root) : [])]
    })
}

export async function estimateSource(source, ctx = {}) {
    if (source.kind !== 'stream') return null
    if (source.nodeName === 'etlFileSource') {
        const files = fileList(source.inputs || {}, ctx)
        return { units: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) }
    }
    const { root, checkout } = await ensureRepo(source, ctx)
    const maxBytes = intInput(source.inputs?.maxFileKb, 1024) * 1024
    let units = 0
    let bytes = 0
    for (const file of repoFiles(root, source.inputs || {}, { checkout })) {
        units += 1
        if (file.size <= maxBytes) bytes += file.size
    }
    return { units, bytes }
}

// Each unit is one file (or one loader result) with a fingerprint; units come out in compareSegments(key) order.
// Every record a unit yields is a ledger record (E7): a document, a `reject` with a reason, or a `filter` with a reason.
export async function* sourceUnits(source, ctx = {}) {
    const inputs = source.inputs || {}
    const config = configHash(source)
    if (source.nodeName === 'etlFileSource') {
        for (const file of fileList(inputs, ctx)) {
            yield {
                key: file.key,
                sourceId: `${source.nodeId}:${file.key}`,
                fingerprint: `${file.size}:${file.mtimeMs}:${config}`,
                bytes: file.size,
                docs: fileDocs(file, inputs)
            }
        }
        return
    }
    if (source.nodeName === 'etlRepoSource') {
        const { root, label, checkout } = await ensureRepo(source, ctx)
        const maxBytes = intInput(inputs.maxFileKb, 1024) * 1024
        for (const file of repoFiles(root, inputs, { checkout })) {
            const ext = path.extname(file.rel).slice(1).toLowerCase()
            const metadata = {
                source: file.rel,
                path: file.rel,
                repository: label,
                extension: ext,
                language: LANGUAGES[ext] || ext || 'text'
            }
            const position = { docKey: file.rel, offset: 0, next: file.size, ordinal: 1 }
            yield {
                key: file.rel,
                sourceId: `${source.nodeId}:${file.rel}`,
                fingerprint: `${file.size}:${file.mtimeMs}:${config}`,
                bytes: file.size,
                docs: async function* docs() {
                    if (file.size > maxBytes) {
                        yield { filter: 'max_file_kb', ...position }
                        return
                    }
                    if (looksBinary(file.abs)) {
                        yield { filter: 'binary_file', ...position }
                        return
                    }
                    const text = await fs.promises.readFile(file.abs, 'utf8')
                    yield { pageContent: text, metadata, ...position }
                }
            }
        }
        return
    }
    yield {
        key: 'loader',
        sourceId: `${source.nodeId}:loader`,
        fingerprint: null,
        bytes: 0,
        docs: async function* docs({ ordinal = 0 } = {}) {
            const output = await initNode(source, { inputs: { textSplitter: undefined }, output: 'document', ctx })
            const list = Array.isArray(output) ? output.flat() : []
            for (let i = ordinal; i < list.length; i += 1) {
                const doc = list[i]
                const position = { offset: 0, next: 0, ordinal: i + 1, loader: true }
                if (!doc || typeof doc.pageContent !== 'string') {
                    yield rejected(new RecordReject('non_string_content', null, 'the loader document has no string pageContent'), position)
                    continue
                }
                const { metadata, flattened } = flattenLoaderMetadata(doc.metadata || {})
                yield { pageContent: doc.pageContent, metadata, docKey: '', coercions: flattened ? { flattened } : {}, ...position }
            }
        }
    }
}
