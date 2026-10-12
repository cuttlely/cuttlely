import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Images a specialist wrote in its own workspace during this turn, such as a chart from execute_code. They go back
// to the chat as artifacts. Hidden folders, symlinks, empty files and files over the size limit are skipped.
export const TURN_IMAGE_LIMITS = { count: 4, bytes: 5 * 1024 * 1024, depth: 3 }
const IMAGE_TYPES = {
    '.png': { type: 'png', mime: 'image/png' },
    '.jpg': { type: 'jpeg', mime: 'image/jpeg' },
    '.jpeg': { type: 'jpeg', mime: 'image/jpeg' }
}

// Each specialist run gets its own image folder in its workspace, named by a fresh id. Only that folder is read, so
// two chats running the same specialist at once never pick up each other's images. The folder is removed after.
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

export function turnImageNote(dir) {
    return dir
        ? `To show an image in the chat, save it as a PNG or JPEG file in this folder: ${dir}\nImages saved anywhere else are not shown.`
        : ''
}

// The folder is a server path; the answer names the file only.
export function hideTurnImageDir(text, dir) {
    if (!dir || typeof text !== 'string') return text
    return text.split(`${dir}${path.sep}`).join('').split(dir).join('the chat')
}

export function removeTurnImageDir(dir) {
    if (!dir || path.basename(path.dirname(dir)) !== TURN_IMAGE_FOLDER) return
    fs.rmSync(dir, { recursive: true, force: true })
}

export function turnImages(dir, since, { specialist = '', limits = TURN_IMAGE_LIMITS } = {}) {
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
            const kind = IMAGE_TYPES[path.extname(entry.name).toLowerCase()]
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
    const images = []
    for (const item of found.slice(0, limits.count)) {
        try {
            images.push({
                type: item.kind.type,
                mime: item.kind.mime,
                name: item.name,
                specialist,
                base64: fs.readFileSync(item.full).toString('base64')
            })
        } catch {
            // A file removed after the scan is skipped.
        }
    }
    return images
}

// One list for the turn: newest specialist images first, the same file once, capped at the count limit.
export function mergeTurnImages(lists, limit = TURN_IMAGE_LIMITS.count) {
    const seen = new Set()
    const out = []
    for (const image of lists.flat()) {
        const key = `${image.specialist}/${image.name}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(image)
        if (out.length >= limit) break
    }
    return out
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
