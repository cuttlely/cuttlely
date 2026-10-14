// Fails when a homepage media file shows a currency amount.
// Frames are taken every half second. Without tesseract the check skips and says why,
// so a machine that cannot OCR does not fail the suite.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mediaDir = path.join(root, 'public', 'media')

/** Half a second. The same interval the audit used. */
const INTERVAL = 0.5

// A symbol may sit a word away from its amount (`$ | 25.20`). A space after the symbol is fine (`$ 1,000`).
// The amount may be one digit (`$5`), a plain run (`$1000`, `$0.00`), or thousands with a 1–3 digit first group (`$1,234`).
// The symbol is its own mark: not glued to a letter or digit on either side.
const NUMBER = String.raw`(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`
const SYMBOL_SRC = String.raw`(?<![A-Za-z0-9])[$€£](?:\s|\|)*(${NUMBER})(?![A-Za-z])`
const SPELLED =
    '(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[-\\s](?:one|two|three|four|five|six|seven|eight|nine)|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)'
const AMOUNT = `(?:${SPELLED}|\\d[\\d,]*(?:\\.\\d+)?)`
const UNIT = '(?:dollars?|cents?|euros?|pounds?)'
// "twenty-five dollars", "20 cents", "two euros", "five pounds", and the same with the unit first.
// "a" and "an" are not amounts, so "a pound of flour" is not a hit.
const NAMED_SRC = `\\b(?:${AMOUNT}\\s+${UNIT}|${UNIT}\\s+${AMOUNT})\\b`
const USD_SRC = String.raw`\b(?:USD\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*USD)\b`

/**
 * A symbol glued to a thousands-grouped token count, or to its three-digit tail, directly before
 * "in" or "out" is a token count: "$5,541 in", "$5,541in", and "$541 in" (read from "5,541 in").
 * Punctuation jammed against that "in" or "out" is a space first, so "$541,in" is the same shape.
 * "$25 in" and "$10 out" stay amounts.
 */
function softenTracePunctuation(text) {
    return String(text)
        .replace(/[^\s\w$€£.]+(?=\s*(?:in|out)\b)/gi, ' ')
        .replace(/(?<![A-Za-z0-9])[$€£]\s*(?:\d{1,3}(?:,\d{3})+|\d{3})(?:,?\s*)?(?=(?:in|out)\b)/gi, ' ')
}

/**
 * A currency amount on one line, or null.
 * `decimal` and `spelled` are the low-confidence shapes. `whole2` is a two-digit whole amount.
 * `whole3` is a three-digit whole amount. Anything else valid is `other`.
 */
/** A run trace names a grouped token count and a short misread on the same line (`1,957 in - $33 out`). */
function isTraceLine(line) {
    return /\d{1,3}(?:,\d{3})+\s+(?:in|out)\b/i.test(line) && /[$€£]\s*\d{1,3}\s+(?:in|out)\b/i.test(line)
}

function classifyAmount(text) {
    const line = softenTracePunctuation(text)
    if (isTraceLine(line)) return null
    const named = new RegExp(NAMED_SRC, 'i').exec(line) || new RegExp(USD_SRC, 'i').exec(line)
    if (named) return { kind: 'spelled', start: named.index, end: named.index + named[0].length, line }
    const symbol = new RegExp(SYMBOL_SRC, 'g')
    const match = symbol.exec(line)
    if (!match) return null
    const amount = match[1]
    let kind = 'other'
    if (amount.includes('.')) kind = 'decimal'
    else {
        const digits = amount.replace(/\D/g, '').length
        if (digits === 2) kind = 'whole2'
        else if (digits === 3) kind = 'whole3'
    }
    return { kind, start: match.index, end: match.index + match[0].length, line }
}

/** True when a single line of text names a currency amount. */
export function lineHasMoney(text) {
    return classifyAmount(text) !== null
}

/**
 * Confidence applies to the joined line. Every word at 85 or higher keeps any valid amount.
 * Otherwise a decimal or a spelled unit still counts, and a two-digit whole amount counts at 60 or higher.
 * A three-digit whole amount below 85 does not.
 */
function countsAtConfidence(kind, confs) {
    if (!confs.length) return false
    if (confs.every((conf) => conf >= 85)) return true
    if (kind === 'decimal' || kind === 'spelled') return true
    return kind === 'whole2' && Math.min(...confs) >= 60
}

function tool(name) {
    const found = spawnSync('which', [name], { encoding: 'utf8' })
    return found.status === 0 ? found.stdout.trim() : ''
}

function walk(dir) {
    const out = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) out.push(...walk(full))
        else if (/\.(mp4|webm|webp)$/i.test(entry.name)) out.push(full)
    }
    return out.sort()
}

function extract(file, dest) {
    fs.mkdirSync(dest, { recursive: true })
    const ext = path.extname(file).toLowerCase()
    const pattern = path.join(dest, 'f-%04d.png')
    const args =
        ext === '.webp'
            ? ['-y', '-i', file, '-vf', 'scale=iw*2:ih*2:flags=lanczos', pattern]
            : ['-y', '-i', file, '-vf', `fps=${1 / INTERVAL},scale=iw*2:ih*2:flags=lanczos`, pattern]
    const run = spawnSync('ffmpeg', args, { encoding: 'utf8' })
    if (run.status !== 0) throw new Error(`ffmpeg could not read ${path.relative(root, file)}`)
    return fs
        .readdirSync(dest)
        .filter((name) => name.endsWith('.png'))
        .sort()
        .map((name) => path.join(dest, name))
}

function ocr(image) {
    return new Promise((resolve, reject) => {
        const child = spawn('tesseract', [image, 'stdout', '--psm', '6', '-l', 'eng', '--oem', '1', 'tsv'], {
            env: { ...process.env, OMP_THREAD_LIMIT: '1' }
        })
        let out = ''
        let err = ''
        child.stdout.on('data', (chunk) => {
            out += chunk
        })
        child.stderr.on('data', (chunk) => {
            err += chunk
        })
        child.on('error', reject)
        child.on('close', (code) => {
            if (code !== 0) reject(new Error(err || `tesseract exited ${code}`))
            else resolve(out)
        })
    })
}

/** OCR words joined by block, paragraph and line, then checked as one line. */
export function moneyIn(tsv) {
    const lines = new Map()
    for (const row of tsv.split('\n').slice(1)) {
        const parts = row.split('\t')
        if (parts.length < 12 || !parts[11].trim()) continue
        const conf = Number(parts[10])
        const text = parts[11].trim()
        if (!Number.isFinite(conf) || conf < 0) continue
        // page, block, paragraph, line — the same line in another block is a different line.
        const key = [parts[1], parts[2], parts[3], parts[4]].join('\t')
        const bag = lines.get(key) || []
        bag.push({ order: Number(parts[5]) || 0, text, conf })
        lines.set(key, bag)
    }
    const hits = []
    for (const words of lines.values()) {
        words.sort((a, b) => a.order - b.order)
        const line = words.map((word) => word.text).join(' ')
        const hit = classifyAmount(line)
        if (!hit) continue
        let cursor = 0
        const involved = []
        for (const word of words) {
            const start = cursor
            const end = start + word.text.length
            cursor = end + 1
            if (hit.line.length === line.length && end > hit.start && start < hit.end) involved.push(word.conf)
        }
        const confs = involved.length ? involved : words.map((word) => word.conf)
        const loneSymbol = words.find((word) => /^[$€£]$/.test(word.text) && word.conf < 85)
        if (loneSymbol && hit.kind !== 'decimal' && hit.kind !== 'spelled') continue
        if (countsAtConfidence(hit.kind, confs)) hits.push(line)
    }
    return hits
}

async function pool(items, limit, fn) {
    const ret = new Array(items.length)
    let next = 0
    async function worker() {
        while (next < items.length) {
            const i = next
            next += 1
            ret[i] = await fn(items[i], i)
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
    return ret
}

/**
 * @param {string} [dir]
 * @returns {Promise<{skipped?: string, hits: {file: string, at: string, text: string}[]}>}
 */
function missingTool() {
    if (!tool('tesseract')) return 'tesseract is not installed'
    if (!tool('ffmpeg')) return 'ffmpeg is not installed'
    return ''
}

export async function scanMedia(dir = mediaDir) {
    const missing = missingTool()
    if (missing) {
        const message = `${missing}, so the media money check was skipped`
        if (process.env.CUTTLELY_MEDIA_REQUIRE_TOOLS === '1') throw new Error(message)
        return { skipped: message, hits: [] }
    }
    const files = walk(dir)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'media-money-'))
    const hits = []
    try {
        for (const file of files) {
            const frames = extract(file, path.join(tmp, path.basename(file)))
            const found = await pool(frames, 8, async (frame) => {
                const text = moneyIn(await ocr(frame))
                if (!text.length) return null
                const n = Number(path.basename(frame).match(/(\d+)\.png$/)[1])
                const at = path.extname(file).toLowerCase() === '.webp' ? 'poster' : `${((n - 1) * INTERVAL).toFixed(1)}s`
                return { at, text: text.join(' ') }
            })
            for (const row of found) {
                if (!row) continue
                hits.push({ file: path.relative(root, file), at: row.at, text: row.text })
            }
        }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
    }
    return { hits }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const result = await scanMedia()
    if (result.skipped) {
        console.log(result.skipped)
        process.exit(0)
    }
    if (!result.hits.length) {
        console.log('no currency amounts in homepage media')
        process.exit(0)
    }
    for (const hit of result.hits) console.log(`${hit.file} @ ${hit.at}: ${hit.text}`)
    process.exit(1)
}
