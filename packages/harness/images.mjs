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

// All text uses the segment masker. Deliverables name their basename; other paths use a workspace or server placeholder.
export function hideTurnImageDir(text, dir, root = dir ? path.dirname(path.dirname(path.dirname(dir))) : '') {
    if (typeof text !== 'string') return text
    const out = hideWorkspacePaths(text, root, dir)
    // An explicitly supplied chat folder is also covered when it sits outside the root.
    return dir ? hideWorkspacePaths(out, dir, dir) : out
}

// Paths are recognized in every segment, independently of Markdown or JSON grammar.
// Backslashes preceding quotes belong to JSON escapes; leave an even number in the match.
const PATH_CHARS = String.raw`[^\s"'\x60<>()\[\]*|]`
const PATH_START = String.raw`(?:file:\/\/[^/\\\s]*|(?<![A-Za-z0-9])(?:[a-z]:[\\/]|\\\\[a-z0-9])|(?<=[\s(<"'\x60*_~=:,;\[])~?\/|^~?\/|%2f|\\+(?:/|u002f))`
const MASK_HOLD = 8192
const rootCache = new Map()
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function workspaceRoots(root) {
    if (rootCache.has(root)) return rootCache.get(root)
    const roots = [root]
    try {
        const real = fs.realpathSync(root)
        if (real !== root) roots.push(real)
    } catch {
        // Error previews may name a workspace that has already been removed.
    }
    const literals = new Set()
    for (const value of roots) {
        let escaped = value
        for (let depth = 0; depth < 4; depth++) {
            literals.add(escaped)
            escaped = JSON.stringify(escaped).slice(1, -1)
        }
        for (const slash of ['\\/', '\\u002f']) {
            escaped = value.replaceAll('/', slash)
            for (let depth = 0; depth < 3; depth++) {
                literals.add(escaped)
                escaped = JSON.stringify(escaped).slice(1, -1)
            }
        }
        for (const encoded of [encodeURI(value), encodeFilePath(value), encodeURIComponent(value), value.replaceAll('/', '%2f')]) {
            literals.add(encoded)
            literals.add(encoded.replace(/%[0-9a-f]{2}/gi, (hex) => hex.toLowerCase()))
        }
        literals.add(`file://${value}`)
    }
    const variants = [...literals].filter(Boolean).sort((a, b) => b.length - a.length)
    const info = {
        roots,
        variants,
        boundaryPrefixes: variants
            .flatMap((value) => [...value.matchAll(/[\s"]/g)].map((match) => value.slice(0, match.index + 1)))
            .filter((prefix) => !variants.includes(prefix)),
        backstop: new RegExp(`(?:${variants.map(escapeRegex).join('|')})${PATH_CHARS}*`, 'g'),
        overlap: Math.max(0, ...variants.map((value) => value.length - 1)),
        // URL and relative Markdown targets win over generic path starts.
        regex: new RegExp(
            String.raw`(?:<|&lt;)\/[a-z][a-z0-9:-]*(?=\s|>|&gt;)|https?:\/\/[^\s"'\x60<>*|]+|(?<=\()(?:#[^\s)"']*|\.\.?\/[^\s)"']*)|(?:${variants
                .map(escapeRegex)
                .join('|')}|${PATH_START})${PATH_CHARS}*`,
            'gi'
        )
    }
    if (rootCache.size >= 64) rootCache.delete(rootCache.keys().next().value)
    rootCache.set(root, info)
    return info
}

function maskPath(raw, info) {
    // Preserve punctuation, emphasis and JSON escape prefixes at the end of a path.
    const suffix = raw.match(/(?:[._,;:!?]+|~~)+$/)?.[0] || ''
    let token = suffix ? raw.slice(0, -suffix.length) : raw
    const slashes = token.match(/\\+$/)?.[0].length || 0
    const escape = slashes % 2 ? token.slice(-slashes) : ''
    if (escape) token = token.slice(0, -slashes)
    if (/^[\/~]$/.test(token)) return raw
    let local = token.replace(/^file:\/\/[^/\\\s]*/i, '')
    local = local
        .replace(/\\+u002f/gi, '/')
        .replace(/\\+\//g, '/')
        .replace(/\\+/g, '/')
    try {
        local = decodeURIComponent(local)
    } catch {}
    const resolved = path.resolve(local)
    const inside = info.roots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
    let shown = inside ? 'the workspace' : 'a server path'
    if (inside && !local.split('/').includes('..') && /\.(?:pdf|docx|xlsx|pptx|csv|png|jpe?g)$/i.test(local)) {
        try {
            if (fs.statSync(resolved).isFile()) shown = `the workspace file ${path.basename(resolved)}`
        } catch {}
    }
    return shown + escape + suffix
}

function maskSegment(text, info, url = false) {
    // A forced cap can split a URL; the synthetic prefix preserves its remaining bytes.
    const prefix = url ? 'https://' : ''
    const shown = (prefix + text)
        .replace(info.regex, (raw) => {
            if (/^(?:(?:<|&lt;)\/|https?:\/\/|#|\.\.?\/)/i.test(raw)) return raw
            return maskPath(raw, info)
        })
        .slice(prefix.length)
    // Literal configured and real roots are hidden even inside URLs or relative targets.
    return shown.replace(info.backstop, (raw) => maskPath(raw, info))
}

export function workspaceMaskState() {
    return { buffer: '', url: false, containers: [], quoted: false, escaped: false, key: null }
}

// Masked JSON keys can collide with another path or a literal placeholder. Keep the
// same encounter-order suffixes as parsed object masking, without holding the JSON
// document or changing its formatting. Values and array strings pass through.
function keepJsonKeys(text, state, info) {
    const out = []
    for (const char of text) {
        if (state.quoted) {
            if (char === '"' && !state.escaped) {
                if (state.key !== null) {
                    const names = state.containers.at(-1).names
                    try {
                        const original = JSON.parse('"' + state.key + '"')
                        const key = JSON.parse('"' + maskSegment(state.key, info) + '"')
                        let name = key
                        for (let n = 2; names.has(name) && names.get(name) !== original; n++) name = `${key} (${n})`
                        names.set(name, original)
                        if (name !== key) out.push(name.slice(key.length))
                    } catch {
                        // An unfinished or non-JSON literal still uses the text masker.
                    }
                    state.key = null
                }
                state.quoted = false
            } else if (state.key !== null) state.key += char
            state.escaped = char === '\\' && !state.escaped
        } else if (char === '"') {
            state.quoted = true
            state.escaped = false
            if (state.containers.at(-1)?.key) state.key = ''
        } else if (char === '{' || char === '[') {
            state.containers.push(char === '{' ? { key: true, names: new Map() } : { key: false })
        } else if (char === '}' || char === ']') state.containers.pop()
        else if (char === ':' && state.containers.at(-1)?.names) state.containers.at(-1).key = false
        else if (char === ',' && state.containers.at(-1)?.names) state.containers.at(-1).key = true
        out.push(char)
    }
    return out.join('')
}

export function scanWorkspaceText(state, text, root, flush = false) {
    if (!root || typeof text !== 'string') return text
    const info = workspaceRoots(root)
    const out = []
    // Process the same boundaries and cap offsets even when all text arrives in one chunk.
    for (let at = 0; at < text.length; at++) {
        const char = text[at]
        state.buffer += char
        if (/[\s"]/.test(char)) {
            // A configured root can itself contain spaces. Hold a possible literal prefix.
            const partial = info.boundaryPrefixes.some((prefix) => state.buffer.endsWith(prefix))
            if (!partial) {
                out.push(maskSegment(keepJsonKeys(state.buffer, state, info), info, state.url))
                state.url = false
                state.buffer = ''
            }
        }
        if (state.buffer.length > MASK_HOLD) {
            let cut = state.buffer.length - info.overlap
            for (const value of info.variants) {
                const at = state.buffer.lastIndexOf(value, cut)
                if (at >= 0 && at < cut && at + value.length > cut) cut = at
            }
            // Do not split an escape pair at a forced boundary.
            if ((state.buffer.slice(0, cut).match(/\\+$/)?.[0].length || 0) % 2) cut--
            if (cut) {
                const prefix = state.url ? 'https://' : ''
                const crossingUrl = [...(prefix + state.buffer).matchAll(info.regex)].some(
                    (match) =>
                        /^https?:\/\//i.test(match[0]) &&
                        match.index < prefix.length + cut &&
                        match.index + match[0].length > prefix.length + cut
                )
                out.push(maskSegment(keepJsonKeys(state.buffer.slice(0, cut), state, info), info, state.url))
                state.url = crossingUrl
                state.buffer = state.buffer.slice(cut)
            }
        }
    }
    if (flush) {
        out.push(maskSegment(keepJsonKeys(state.buffer, state, info), info, state.url))
        state.url = false
        state.buffer = ''
    }
    return out.join('')
}

export function hideWorkspacePaths(text, root, chatDir = '') {
    if (!root || typeof text !== 'string') return text
    return scanWorkspaceText(workspaceMaskState(), text, root, true)
}

export function namesRoot(text, root) {
    return hideWorkspacePaths(text, root) !== text
}

// Compatibility helpers for callers asking where an unfinished path begins.
export function rootStarts(text, root, partial = false) {
    const info = workspaceRoots(root)
    const starts = []
    for (const match of text.matchAll(info.regex)) {
        if (maskSegment(match[0], info) !== match[0]) starts.push(match.index)
    }
    if (partial)
        for (const value of info.variants) {
            for (let length = 1; length < value.length && length <= text.length; length++) {
                if (text.endsWith(value.slice(0, length))) starts.push(text.length - length)
            }
        }
    return starts
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
