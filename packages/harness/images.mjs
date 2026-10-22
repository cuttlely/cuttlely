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

// The folder is a server path; the answer names the file only. Any other path inside a specialist workspace, such as
// <root>/<profile>/exports/report.pdf, is shown as its file name too, the chat folder itself as "the chat" and a bare
// workspace folder as "the workspace". root is the folder that holds every specialist workspace; it defaults to the
// one the chat folder sits in.
export function hideTurnImageDir(text, dir, root = dir ? path.dirname(path.dirname(path.dirname(dir))) : '') {
    if (typeof text !== 'string') return text
    const out = hideWorkspacePaths(text, root, dir)
    // A chat folder outside the workspaces root still names its files only.
    return dir ? hideWorkspacePaths(out, dir, dir) : out
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const trimSep = (value) => (value.length > 1 && value.endsWith(path.sep) ? value.slice(0, -1) : value)

export function hideWorkspacePaths(text, root, chatDir = '') {
    if (!root || typeof text !== 'string') return text
    const base = trimSep(root)
    if (base === path.sep || !path.isAbsolute(base) || !text.includes(base)) return text
    const chat = chatDir ? trimSep(chatDir) : ''
    const sep = escapeRegExp(path.sep)
    // The root must start a path (not follow a letter, a dot or a separator) and end at a separator or a boundary.
    const head = `(?<![A-Za-z0-9._~${sep}-])(?:file://)?${escapeRegExp(base)}(?![A-Za-z0-9_~-]|\\.[A-Za-z0-9_~.${sep}-])`
    const shown = (full) => {
        const rest = full.replace(/^file:\/\//, '')
        if (chat && (rest === chat || rest === `${chat}${path.sep}`)) return 'the chat'
        const parts = rest.slice(base.length).split(path.sep).filter(Boolean)
        // Under the chat folder itself every path is a file name; under the root the first part is a workspace.
        if (base === chat) return parts.length ? parts[parts.length - 1] : 'the chat'
        return parts.length <= 1 ? 'the workspace' : parts[parts.length - 1]
    }
    // A quoted path may hold spaces and punctuation: everything up to the same closing quote is the path, so a
    // backticked or double-quoted path may hold an apostrophe.
    // A quoted path starts with the root and a separator, or is the root alone; "<root> backup/..." is another folder.
    const quotes = ['"', "'", '`'].map((quote) => new RegExp(`${quote}(${head}(?:${sep}[^${quote}\\n]*)?)${quote}`, 'g'))
    // A bare root followed by a space and a relative path is a sibling folder whose name starts with the root's name.
    const word = `[^\\s'"\`<>()\\[\\]{}|,;${sep}][^\\s'"\`<>()\\[\\]{}|,;]*${sep}`
    const bare = new RegExp(`${head}(?:${sep}[^\\s'"\`<>()\\[\\]{}|,;]*|(?![ \\t]+${word}))`, 'g')
    const bareOnly = (value) =>
        value.replace(bare, (match) => {
            // Sentence punctuation after a path is not part of it.
            const tail = /[.:!?]+$/.exec(match)?.[0] || ''
            return shown(match.slice(0, match.length - tail.length)) + tail
        })
    // In quoted text a path may hold spaces. It is read one folder at a time, in a single pass: a folder name has no
    // leading or trailing space and none of ;:<>|?* or ", ". The last part is the rest of the quote when that ends in a
    // file extension, otherwise it ends at the first space. The rest keeps its words, and any further path is masked.
    const badFolder = /^\s|\s$|[;:<>|?*]|, /
    const fileEnd = /\.[A-Za-z0-9]{1,8}$/
    const space = /\s/g
    const quotedPaths = (full) => {
        const start = new RegExp(`^${head}`).exec(full)?.[0].length || 0
        const s = path.sep
        let pos = start
        let end = full.length
        while (pos < full.length && full[pos] === s) {
            const next = full.indexOf(s, pos + 1)
            if (next !== -1) {
                const folder = full.slice(pos + 1, next)
                if (folder && !badFolder.test(folder)) {
                    pos = next
                    continue
                }
            } else if (fileEnd.test(full.slice(pos + 1))) {
                break
            }
            space.lastIndex = pos + 1
            const gap = space.exec(full)
            end = gap ? gap.index : full.length
            break
        }
        if (end === full.length) return shown(full)
        return shown(full.slice(0, end)) + bareOnly(full.slice(end))
    }
    let out = text
    for (const quoted of quotes) {
        // Quoted text naming two or more paths ("a.pdf and b.pdf", a move error) keeps its words; each path is masked.
        out = out.replace(quoted, (match, full) => `${match[0]}${quotedPaths(full)}${match[0]}`)
    }
    return bareOnly(out)
}

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
