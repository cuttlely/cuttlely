// Reads every frame of the customer-care closing card, from the fade
// (frame 2110) through the last frame. A figure outside 0.8 s, 1.9 s, and
// 19.8 s fails. Each of those three has to be read. The home page serves
// both the mp4 and the webm.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const media = path.join(root, 'public', 'media')

/** First frame of the card fade. Frame 0 is the start of the file. */
export const FADE_START_FRAME = 2110

export const CUSTOMER_CARE_FILES = ['customer-care-demo.mp4', 'customer-care-demo.webm']

export const CUSTOMER_CARE_FIGURES = [0.8, 1.9, 19.8]

const DECIMAL = /^(\d+\.\d+)\s*(s|x)?$/i
const MILLIS = /^(\d+)\s*ms$/i

export function nearest(value, allow) {
    let best = null
    let bestDist = 0.08
    for (const ok of allow) {
        const dist = Math.abs(value - ok)
        if (dist <= bestDist) {
            best = ok
            bestDist = dist
        }
    }
    return best
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function figuresIn(tsv) {
    const found = []
    for (const row of tsv.split('\n').slice(1)) {
        const parts = row.split('\t')
        if (parts.length < 12 || !parts[11].trim()) continue
        const conf = Number(parts[10])
        if (!Number.isFinite(conf) || conf < 80) continue
        const height = Number(parts[9])
        if (!Number.isFinite(height) || height < 28) continue
        const text = parts[11].trim().replace(/[|]/g, '')
        const match = DECIMAL.exec(text) || MILLIS.exec(text)
        if (!match) continue
        const value = Number(match[1])
        const left = Number(parts[6])
        if (!Number.isFinite(value) || !Number.isFinite(left)) continue
        found.push({ value, text, conf, left })
    }
    return found
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

function extract(file, dest) {
    fs.mkdirSync(dest, { recursive: true })
    const pattern = path.join(dest, 'f-%04d.png')
    const vf = `select='gte(n\\,${FADE_START_FRAME})',crop=iw*0.7:ih*0.34:iw*0.15:ih*0.40,scale=iw*2:ih*2:flags=lanczos`
    const run = spawnSync('ffmpeg', ['-y', '-i', file, '-vf', vf, '-vsync', 'vfr', pattern], { encoding: 'utf8' })
    if (run.status !== 0) throw new Error(`ffmpeg could not read ${file}`)
    return fs
        .readdirSync(dest)
        .filter((name) => name.endsWith('.png'))
        .sort()
        .map((name) => path.join(dest, name))
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

/** Frames 2110 through 2344, one image per frame. */
export const CUSTOMER_CARE_FRAME_COUNT = 235

/** Every frame from the fade through the end of one customer-care file. */
export async function scanCustomerCareFile(file) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'closing-card-'))
    const name = path.basename(file)
    try {
        const frames = extract(file, tmp)
        if (frames.length !== CUSTOMER_CARE_FRAME_COUNT) {
            return [`${name}: expected ${CUSTOMER_CARE_FRAME_COUNT} frames from ${FADE_START_FRAME} through 2344, got ${frames.length}`]
        }
        const rows = await pool(frames, 8, async (frame, index) => {
            const n = FADE_START_FRAME + index
            return { n, figures: figuresIn(await ocr(frame)) }
        })
        const bad = []
        const seen = new Map()
        for (const row of rows) {
            const at = (row.n / 30).toFixed(2)
            for (const figure of row.figures) {
                const key = nearest(figure.value, CUSTOMER_CARE_FIGURES)
                if (key === null) {
                    bad.push(`${name} frame ${row.n} (${at}s): ${figure.text}`)
                    continue
                }
                const lefts = seen.get(key) || []
                lefts.push(figure.left)
                seen.set(key, lefts)
            }
        }
        for (const value of CUSTOMER_CARE_FIGURES) {
            if (!seen.has(value)) bad.push(`${name}: did not read ${value}`)
        }
        if (CUSTOMER_CARE_FIGURES.every((value) => seen.has(value))) {
            const order = CUSTOMER_CARE_FIGURES.map((value) => median(seen.get(value)))
            for (let i = 1; i < order.length; i += 1) {
                if (!(order[i] > order[i - 1])) bad.push(`${name}: figures are out of card order`)
            }
        }
        return bad
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const bad = []
    for (const name of CUSTOMER_CARE_FILES) {
        const file = path.join(media, name)
        if (!fs.existsSync(file)) {
            bad.push(`${name} is missing`)
            continue
        }
        bad.push(...(await scanCustomerCareFile(file)))
    }
    if (bad.length) {
        console.log(bad.join('\n'))
        process.exit(1)
    }
    console.log('customer-care closing card shows 0.8 s, 1.9 s, and 19.8 s on every read frame')
}
