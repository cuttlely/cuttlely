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

// A symbol may sit a word away from its amount (`$ | 25.20`), and the amount may be whole (`$25`).
// The symbol is its own mark: not glued to a letter or digit on either side, so a misread id does not count.
// A whole amount needs at least two digits. One digit is how a rule or an S is misread.
const SYMBOL = /(?<![A-Za-z0-9])[$€£](?:\s|\|)*(\d[\d,]*\.\d+|\d{2,}[\d,]*)(?![A-Za-z])/g
const SPELLED =
    '(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[-\\s](?:one|two|three|four|five|six|seven|eight|nine)|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|a|an)'
const AMOUNT = `(?:${SPELLED}|\\d[\\d,]*(?:\\.\\d+)?)`
const UNIT = '(?:dollars?|cents?|euros?|pounds?)'
// "twenty-five dollars", "20 cents", "two euros", "five pounds", and the same with the unit first.
const NAMED = new RegExp(`\\b(?:${AMOUNT}\\s+${UNIT}|${UNIT}\\s+${AMOUNT})\\b`, 'i')
const USD_AMOUNT = /\b(?:USD\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*USD)\b/i

/** True when a single line of text names a currency amount. */
export function lineHasMoney(text) {
    const line = String(text)
    if (NAMED.test(line) || USD_AMOUNT.test(line)) return true
    SYMBOL.lastIndex = 0
    let match
    while ((match = SYMBOL.exec(line))) {
        const amount = match[1]
        const digits = amount.replace(/\D/g, '')
        if (/^0+$/.test(digits)) continue
        const whole = !amount.includes('.')
        // Four bare digits are an id misread (`$1384`). A real whole amount is shorter, or grouped.
        if (whole && !amount.includes(',') && digits.length > 3) continue
        const after = line.slice(match.index + match[0].length)
        // "533 out" misread as "$33 out" is a token count, not an amount.
        if (whole && /^\s+(?:in|out)\b/i.test(after)) continue
        return true
    }
    return false
}

/** A low-confidence word that already names an amount, unlike a bare `:s£`. */
function lowConfidenceAmount(text) {
    return lineHasMoney(text)
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
        // A dim glyph is usually a rule or a box. A dim word that already names an amount still counts.
        if (!Number.isFinite(conf) || conf < 0) continue
        if (conf < 85 && !lowConfidenceAmount(text)) continue
        // page, block, paragraph, line — the same line in another block is a different line.
        const key = [parts[1], parts[2], parts[3], parts[4]].join('\t')
        const bag = lines.get(key) || []
        bag.push({ order: Number(parts[5]) || 0, text })
        lines.set(key, bag)
    }
    const hits = []
    for (const words of lines.values()) {
        words.sort((a, b) => a.order - b.order)
        const line = words.map((word) => word.text).join(' ')
        if (lineHasMoney(line)) hits.push(line)
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
export async function scanMedia(dir = mediaDir) {
    if (!tool('tesseract')) return { skipped: 'tesseract is not installed, so the media money check was skipped', hits: [] }
    if (!tool('ffmpeg')) return { skipped: 'ffmpeg is not installed, so the media money check was skipped', hits: [] }
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
