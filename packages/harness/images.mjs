import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Images and files a specialist wrote in its own workspace during this turn, such as a chart from execute_code or a
// PDF report. They go back to the chat as artifacts. Hidden folders, symlinks, empty files, files over the size limit
// and files whose bytes do not match their extension are skipped.
export const TURN_IMAGE_LIMITS = { count: 4, bytes: 5 * 1024 * 1024, depth: 3 }
// PDF, DOCX, XLSX, PPTX and CSV files: up to 4 per turn and 10 MB each.
export const TURN_FILE_LIMITS = { count: 4, bytes: 10 * 1024 * 1024, depth: 3 }
// Images and files together, per turn. Newest first: whatever would go over this total is left out.
export const TURN_ARTIFACT_BYTES = 20 * 1024 * 1024

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')
const ZIP_SIGNATURE = Buffer.from('504b0304', 'hex')

const IMAGE_TYPES = {
    '.png': { type: 'png', mime: 'image/png' },
    '.jpg': { type: 'jpeg', mime: 'image/jpeg' },
    '.jpeg': { type: 'jpeg', mime: 'image/jpeg' }
}

export const TURN_FILE_TYPES = {
    '.pdf': { type: 'pdf', mime: 'application/pdf' },
    '.docx': { type: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    '.xlsx': { type: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    '.pptx': { type: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
    '.csv': { type: 'csv', mime: 'text/csv' }
}

// The parts an Office file must have, read from the ZIP central directory.
const OOXML_PART = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' }
const OOXML_CONTENT_TYPES = '[Content_Types].xml'
const ZIP_MAX_ENTRIES = 10000

// The entry names in a ZIP's central directory, or null when the archive is malformed. Reads stay inside the buffer.
export function zipEntryNames(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 22 || !bytes.subarray(0, 4).equals(ZIP_SIGNATURE)) return null
    // The end-of-central-directory record is in the last 22 bytes plus up to 65535 bytes of comment.
    let end = -1
    for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65535); at--) {
        if (bytes.readUInt32LE(at) === 0x06054b50) {
            end = at
            break
        }
    }
    if (end < 0) return null
    const count = bytes.readUInt16LE(end + 10)
    const size = bytes.readUInt32LE(end + 12)
    const offset = bytes.readUInt32LE(end + 16)
    if (count === 0 || count > ZIP_MAX_ENTRIES || offset + size > end) return null
    // Every entry must sit inside the declared directory, and the entries must fill it exactly.
    const limit = offset + size
    const names = []
    let at = offset
    for (let i = 0; i < count; i++) {
        if (at + 46 > limit || bytes.readUInt32LE(at) !== 0x02014b50) return null
        const nameLength = bytes.readUInt16LE(at + 28)
        const next = at + 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32)
        if (next > limit) return null
        names.push(bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8'))
        at = next
    }
    return at === limit ? names : null
}

function isOoxml(type, bytes) {
    const names = zipEntryNames(bytes)
    return Boolean(names && names.includes(OOXML_CONTENT_TYPES) && names.includes(OOXML_PART[type]))
}

// True when the bytes are the type the extension says. A renamed file, such as a ZIP saved as .docx or a PDF saved
// as .csv, does not reach the chat.
export function matchesTurnType(type, bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) return false
    switch (type) {
        case 'png':
            return bytes.subarray(0, 8).equals(PNG_SIGNATURE)
        case 'jpeg':
            return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        case 'pdf':
            return bytes.subarray(0, 5).toString('latin1') === '%PDF-'
        case 'docx':
        case 'xlsx':
        case 'pptx':
            return isOoxml(type, bytes)
        case 'csv':
            return isCsvText(bytes)
        default:
            return false
    }
}

// CSV is UTF-8 text: no NUL bytes and no invalid sequences.
function isCsvText(bytes) {
    if (bytes.includes(0)) return false
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        return true
    } catch {
        return false
    }
}

// Each specialist run gets its own folder for chat images and files in its workspace, named by a fresh id. Only that
// folder is read, so two chats running the same specialist at once never pick up each other's files. The folder is
// removed after. The folder name is the one images have always used.
export const TURN_IMAGE_FOLDER = 'chat-images'

export function newTurnImageDir(workspace) {
    if (!workspace) return ''
    const dir = path.join(workspace, TURN_IMAGE_FOLDER, crypto.randomUUID())
    try {
        fs.mkdirSync(dir, { recursive: true })
    } catch {
        // Images are optional: a workspace that cannot take the folder runs the task without them.
        return ''
    }
    return dir
}

const MB = 1024 * 1024

export function turnImageNote(dir) {
    return dir
        ? [
              `To show an image in the chat, save it as a PNG or JPEG file in this folder: ${dir}`,
              `To send a file to the chat as a download, save it there as a PDF, DOCX, XLSX, PPTX or CSV file (up to ${
                  TURN_FILE_LIMITS.bytes / MB
              } MB each, ${TURN_ARTIFACT_BYTES / MB} MB per turn in all).`,
              'Images and files saved anywhere else are not shown.'
          ].join('\n')
        : ''
}

// All text uses the token scanner. Deliverables name their basename; other paths use a workspace or server placeholder.
export function hideTurnImageDir(text, dir, root = dir ? path.dirname(path.dirname(path.dirname(dir))) : '') {
    if (typeof text !== 'string') return text
    const out = hideWorkspacePaths(text, root, dir)
    // An explicitly supplied chat folder is also covered when it sits outside the root.
    return dir ? hideWorkspacePaths(out, dir, dir) : out
}

// Rules 1–8 share this state machine, including the bounded-token fallback.
const EDGE = /[\]\)}|<>"`,;:!?]/
const QUOTES = '"\'`'
const LEAD = /^[\]\)}|<>,;:!?]*$/
// Rule 3a: \name\name..., UNC \\host\share, or a drive letter. JSON-escaped data is left alone.
const BACKSLASH_START = /^(?:\\[A-Za-z0-9._$~-]+\\[A-Za-z0-9._$~-]+|\\\\[^\\\s]+\\|[a-z]:[\\/])/i
const jsonSpan = (value) => {
    if (!/^[\[{]/.test(value)) return false
    try {
        JSON.parse(value)
        return true
    } catch {
        return false
    }
}
// An escape anywhere in a malformed span is not enough: its entire decoded
// string body must itself be a valid JSON object or array.
const escapedJsonSpan = (value) => {
    try {
        return jsonSpan(JSON.parse('"' + value + '"'))
    } catch {
        return false
    }
}
const backslashPath = (token, raw) => BACKSLASH_START.test(token) && !/\\"|\\u[0-9a-f]{4}/i.test(raw) && !jsonSpan(raw) && !jsonSpan(token)
// The deliverable basename is kept only for a file that exists under the root at mask time.
const isFile = (value) => {
    try {
        return fs.statSync(value).isFile()
    } catch {
        return false
    }
}
const trimSep = (value) => (value.length > 1 && value.endsWith(path.sep) ? value.slice(0, -1) : value)

function tokenMask(raw, root, continued) {
    let start = 0,
        end = raw.length
    while (start < end && (EDGE.test(raw[start]) || raw[start] === "'")) start++
    while (end > start && (EDGE.test(raw[end - 1]) || raw[end - 1] === "'" || raw[end - 1] === '.')) end--
    const token = raw.slice(start, end)
    if (/^https?:\/\//i.test(token)) return { text: raw, masked: false }
    const slash = /[\/\\]/.test(token)
    const candidate = /^(?:[\/~]|file:\/\/)/i.test(token) || /\.\.|\/\/|%2f|%2e%2e/i.test(token) || backslashPath(token, raw)
    if (!candidate && !(continued && slash)) return { text: raw, masked: false }
    let local = token.replace(/^file:\/\/[^/\\\s]*/i, '')
    try {
        local = decodeURIComponent(local)
    } catch {
        local = local.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    }
    local = local.replace(/\\/g, '/')
    const traversal = local.split('/').includes('..')
    const absolute = trimSep(path.resolve(root))
    const resolved = trimSep(path.resolve(local))
    const inside = resolved === absolute || resolved.startsWith(absolute + path.sep)
    let shown = 'a server path'
    if (inside) {
        const base = path.basename(resolved)
        const deliverable =
            !traversal &&
            /^(?:[\/~]|file:|[a-z]:|%2f)/i.test(token) &&
            /\.(?:pdf|docx|xlsx|pptx|csv|png|jpe?g)$/i.test(base) &&
            isFile(resolved)
        shown = deliverable ? `the workspace file ${base}` : 'the workspace'
    }
    return { text: raw.slice(0, start) + shown + raw.slice(end), masked: true }
}

export function workspaceMaskState() {
    return {
        token: '',
        quote: '',
        overflow: false,
        continued: false,
        capCandidate: false,
        slash: false,
        tail: '',
        prefix: '',
        allowJson: true,
        json: false,
        jdepth: 0,
        jstr: false,
        jesc: false,
        normal: null,
        normalText: '',
        emitted: 0,
        word: '',
        bs: 0
    }
}

export function scanWorkspaceText(state, text, root, flush = false) {
    const out = []
    const finish = () => {
        if (state.overflow) state.continued = true
        else if (state.token) {
            // Rule 5: continuation also covers a quoted next token (fail closed).
            const held = state.token
            const validJson = state.allowJson && (jsonSpan(held) || escapedJsonSpan(held))
            const retry = state.allowJson && /^[\[{]/.test(held) && !validJson
            // JSON-like syntax only defers quote handling. Invalid spans must go through
            // the ordinary scanner before any of their text can leave the buffer.
            let result
            if (retry) {
                const normal = workspaceMaskState()
                normal.allowJson = false
                normal.continued = state.continued
                result = { text: scanWorkspaceText(normal, held, root, true), masked: normal.continued }
            } else result = validJson ? { text: held, masked: false } : tokenMask(held, root, state.continued)
            // A released prefix was final under the ordinary rules as well as the
            // JSON exemption. Only the still-held suffix can need replacement.
            out.push(
                result.text.startsWith(held.slice(0, state.emitted))
                    ? result.text.slice(state.emitted)
                    : tokenMask(held.slice(state.emitted), root, state.continued).text
            )
            state.continued = result.masked
        }
        state.token = ''
        state.overflow = false
        state.capCandidate = false
        state.slash = false
        state.tail = ''
        state.prefix = ''
        state.quote = ''
        state.json = false
        state.jdepth = 0
        state.jstr = false
        state.jesc = false
        state.normal = null
        state.normalText = ''
        state.emitted = 0
        state.word = ''
        state.bs = 0
    }
    // A {/[ token stays whole only while it could still be valid JSON (rule 3a exemption).
    const trackJson = (char) => {
        if (state.jstr) {
            if (state.jesc) state.jesc = false
            else if (char === '\\') state.jesc = true
            else if (char === '"') state.jstr = false
        } else if (char === '"') {
            state.jstr = true
            state.word = ''
        } else if (char === '{' || char === '[') state.jdepth++
        else if (char === '}' || char === ']') state.jdepth--
        else if (/\s/u.test(char)) return
        else if (/[a-z]/i.test(char)) {
            state.word += char
            if (!['true', 'false', 'null'].some((word) => word.startsWith(state.word))) state.json = false
        } else if (/[0-9+\-.{}\[\],:]/.test(char)) state.word = ''
        else state.json = false
    }
    for (const char of text) {
        if (!state.quote && !(state.json && state.jdepth > 0) && /\s/u.test(char)) {
            finish()
            out.push(char)
            continue
        }
        const closing = state.quote === char && !state.slash
        // Rule 1: a quote opens after leading trim characters, or after any delimiter inside a
        // populated token (note:"/tmp/a b"); the text before it is judged as its own token.
        // A token that starts like JSON stays whole so rule 3a can see the JSON span.
        if (!state.quote && !state.overflow && QUOTES.includes(char) && !state.slash) {
            if (LEAD.test(state.token)) state.quote = char
            else if (!state.json && /[^A-Za-z0-9_.~%\/\\-]$/.test(state.token)) {
                // A token that is already a path candidate reads on through the quoted span and is
                // masked whole at its boundary; only other text is judged on its own first.
                if (!state.capCandidate) finish()
                state.quote = char
            }
        }
        if (!state.overflow) {
            if (state.allowJson && !state.token && (char === '{' || char === '[')) {
                state.json = true
                state.jdepth = 1
                state.normal = workspaceMaskState()
                state.normal.allowJson = false
                state.normal.continued = state.continued
            } else if (state.json) trackJson(char)
            if (state.json && state.jstr && state.token.endsWith('"') && /[\/~]/.test(char)) state.capCandidate = true
            state.token += char
            if (state.normal) {
                state.normalText += scanWorkspaceText(state.normal, char, root)
            }
            // Rule 6 keeps ordinary data intact, even when a JSON value or word is long.
            // Track candidate syntax incrementally so long plain text stays linear.
            const tail = (state.tail = (state.tail + char).slice(-6))
            if (state.prefix.length < 256 && (state.prefix || !(EDGE.test(char) || char === "'"))) state.prefix += char
            state.slash = char === '\\' ? !state.slash : false
            // Rule 3a past the prefix limit: count separators of a token that starts with a backslash.
            if (char === '\\' && state.prefix[0] === '\\') state.bs++
            if (
                /\.\.|\/\/|%2f|%2e%2e/i.test(tail) ||
                /^[\/~]/.test(state.prefix) ||
                BACKSLASH_START.test(state.prefix) ||
                (state.bs >= 2 && /[A-Za-z0-9._$~-]/.test(char)) ||
                (state.continued && /[\/\\]/.test(char))
            )
                state.capCandidate = true
            if (state.token.length > 1024 && state.capCandidate && !/^https?:\/\//i.test(state.prefix)) {
                out.push('a server path')
                state.token = ''
                if (state.json && state.jstr) state.quote = '"'
                state.json = false
                state.jstr = false
                state.overflow = true
            }
            // No open ordinary token/quote can be extended by later input. Its
            // unchanged output is therefore final even if JSON validation fails.
            if (
                state.json &&
                state.normal &&
                !state.normal.token &&
                !state.normal.quote &&
                !state.normal.overflow &&
                !state.normal.continued &&
                state.normalText === state.token
            ) {
                out.push(state.token.slice(state.emitted))
                state.emitted = state.token.length
            }
        }
        if (closing) finish()
    }
    if (flush) finish()
    return out.join('')
}

export function hideWorkspacePaths(text, root, chatDir = '') {
    if (!root || typeof text !== 'string') return text
    return scanWorkspaceText(workspaceMaskState(), text, root, true)
}

export function namesRoot(text, root) {
    return hideWorkspacePaths(text, root) !== text
}

// Compatibility helpers use the same token boundaries; streaming itself keeps scanner state.
export function rootStarts(text, root, partial = false) {
    const state = workspaceMaskState()
    const found = []
    let start = 0
    for (let at = 0; at < text.length; at++) {
        const before = state.token.length
        scanWorkspaceText(state, text[at], root)
        if (!before && state.token) start = at
        if (before && !state.token && namesRoot(text.slice(start, at + 1), root)) found.push(start)
    }
    if (state.token && (partial || namesRoot(state.token, root))) found.push(start)
    return found
}

// How a file:// link spells a path: percent-encoded, including "#" and "?".
export const encodeFilePath = (value) => encodeURI(value).replace(/#/g, '%23').replace(/\?/g, '%3F')

// A file:// link may name a host (localhost, 127.0.0.1, [::1] or any other) before the path.
export const FILE_HOST = String.raw`[^/\\\s]*`

export function removeTurnImageDir(dir) {
    if (!dir || path.basename(path.dirname(dir)) !== TURN_IMAGE_FOLDER) return
    fs.rmSync(dir, { recursive: true, force: true })
}

function scanTurnFolder(dir, since, types, limits, specialist) {
    const found = []
    const walk = (folder, depth) => {
        let entries
        try {
            entries = fs.readdirSync(folder, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
            const full = path.join(folder, entry.name)
            if (entry.isDirectory()) {
                if (depth < limits.depth) walk(full, depth + 1)
                continue
            }
            if (!entry.isFile()) continue
            const kind = types[path.extname(entry.name).toLowerCase()]
            if (!kind) continue
            let stat
            try {
                stat = fs.statSync(full)
            } catch {
                continue
            }
            if (stat.mtimeMs < since || stat.size === 0 || stat.size > limits.bytes) continue
            found.push({ full, mtime: stat.mtimeMs, kind, name: path.relative(dir, full).split(path.sep).join('/') })
        }
    }
    if (dir) walk(dir, 0)
    found.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
    const out = []
    for (const item of found) {
        if (out.length >= limits.count) break
        let bytes
        try {
            bytes = fs.readFileSync(item.full)
        } catch {
            // A file removed after the scan is skipped.
            continue
        }
        if (bytes.length === 0 || bytes.length > limits.bytes || !matchesTurnType(item.kind.type, bytes)) continue
        out.push({
            type: item.kind.type,
            mime: item.kind.mime,
            name: item.name,
            specialist,
            mtime: item.mtime,
            bytes: bytes.length,
            base64: bytes.toString('base64')
        })
    }
    return out
}

export function turnImages(dir, since, { specialist = '', limits = TURN_IMAGE_LIMITS } = {}) {
    return scanTurnFolder(dir, since, IMAGE_TYPES, limits, specialist)
}

export function turnFiles(dir, since, { specialist = '', limits = TURN_FILE_LIMITS } = {}) {
    return scanTurnFolder(dir, since, TURN_FILE_TYPES, limits, specialist)
}

// One list for the turn: newest specialist images first, the same file once, capped at the count limit.
export function mergeTurnImages(lists, limit = TURN_IMAGE_LIMITS.count) {
    const seen = new Set()
    const out = []
    // Specialists finish in any order, so sort the whole turn by write time, newest first.
    const items = lists.flat().sort((a, b) => (Number(b?.mtime) || 0) - (Number(a?.mtime) || 0))
    for (const image of items) {
        const key = `${image.specialist}/${image.name}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(image)
        if (out.length >= limit) break
    }
    return out
}

function artifactBytes(item) {
    if (Number.isFinite(item?.bytes)) return item.bytes
    return typeof item?.base64 === 'string' ? Math.floor((item.base64.length * 3) / 4) : 0
}

// The turn's artifacts: images and files, each up to its count limit and the same file once, then newest first
// across both. An item that would take the turn over the byte total is left out and named in `skipped`.
export function mergeTurnArtifacts(
    imageLists,
    fileLists,
    { imageCount = TURN_IMAGE_LIMITS.count, fileCount = TURN_FILE_LIMITS.count, totalBytes = TURN_ARTIFACT_BYTES } = {}
) {
    const artifacts = []
    const skipped = []
    let used = 0
    // Images and files together, newest first, so older items are the ones the byte total leaves out.
    const candidates = [...mergeTurnImages(imageLists || [], imageCount), ...mergeTurnImages(fileLists || [], fileCount)]
    candidates.sort((a, b) => (Number(b?.mtime) || 0) - (Number(a?.mtime) || 0))
    for (const item of candidates) {
        const size = artifactBytes(item)
        if (used + size > totalBytes) {
            skipped.push(item.name)
            continue
        }
        used += size
        // The write time only orders the turn; it is not part of the artifact.
        const { mtime: _mtime, ...artifact } = item
        artifacts.push(artifact)
    }
    return { artifacts, skipped }
}

// Images the user attached to this turn. Harness Prime sees them on its routing and answer calls. Only PNG, JPEG,
// GIF and WebP data URLs, and http(s) image links, are kept, up to the count and size limits.
export const PROMPT_IMAGE_LIMITS = { count: 4, bytes: 5 * 1024 * 1024 }
const PROMPT_DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/

export function promptImages(list, limits = PROMPT_IMAGE_LIMITS) {
    const kept = []
    for (const item of Array.isArray(list) ? list : []) {
        if (kept.length >= limits.count) break
        const url = typeof item === 'string' ? item.trim() : typeof item?.url === 'string' ? item.url.trim() : ''
        if (!url) continue
        const data = PROMPT_DATA_URL.exec(url)
        if (data) {
            const bytes = Math.floor((data[2].length * 3) / 4)
            if (bytes > 0 && bytes <= limits.bytes) kept.push(url)
            continue
        }
        if (/^https?:\/\/\S+$/i.test(url) && url.length <= 2048) kept.push(url)
    }
    return kept
}

// The last user message carries the images. The model call turns it into text and image parts.
export function withPromptImages(messages, images) {
    const list = Array.isArray(messages) ? messages : []
    if (!images?.length) return list
    const index = list.findLastIndex((message) => message?.role === 'user')
    if (index < 0) return list
    return list.map((message, at) => (at === index ? { ...message, images } : message))
}
