// Product closing cards are sampled. The customer-care card is read on every
// frame from the fade (frame 2110) through the end, by check-closing-card.mjs.
// A listed file that is not on disk fails the test. Without tesseract or
// ffmpeg the OCR portion skips.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CUSTOMER_CARE_FILES, scanCustomerCareFile } from './check-closing-card.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const media = path.join(root, 'public', 'media')

function tool(name) {
    return spawnSync('which', [name], { encoding: 'utf8' }).status === 0
}

function card(file, from, to, allow) {
    return { file, from, to, allow, require: allow }
}

/** @type {{file: string, from: number, to: number, allow: number[], require: number[]}[]} */
const cards = [
    card('products/chatflows-loop.mp4', 32.0, 34.2, [1.1, 1.3]),
    card('products/chatflows-loop.webm', 32.0, 34.2, [1.1, 1.3]),
    card('products/chatflows.mp4', 32.0, 34.2, [1.1, 1.3]),
    card('products/agentflows-loop.mp4', 26.8, 29.2, [0.9, 1.2, 0.8]),
    card('products/agentflows-loop.webm', 26.8, 29.2, [0.9, 1.2, 0.8]),
    card('products/agentflows.mp4', 26.8, 29.2, [0.9, 1.2, 0.8]),
    card('products/share-and-embed-loop.mp4', 24.2, 26.6, [0.4, 0.8]),
    card('products/share-and-embed-loop.webm', 24.2, 26.6, [0.4, 0.8]),
    card('products/share-and-embed.mp4', 24.2, 26.6, [0.4, 0.8]),
    card('products/harnesses-loop.mp4', 44.4, 47.2, [4.2, 855, 3.7]),
    card('products/harnesses-loop.webm', 44.4, 47.2, [4.2, 855, 3.7]),
    card('products/harnesses.mp4', 44.4, 47.2, [4.2, 855, 3.7]),
    card('products/build-with-ai-loop.mp4', 28.0, 30.6, [5.3, 4.0, 701]),
    card('products/build-with-ai-loop.webm', 28.0, 30.6, [5.3, 4.0, 701]),
    card('products/build-with-ai.mp4', 28.0, 30.6, [5.3, 4.0, 701]),
    card('products/knowledge-pipelines-loop.mp4', 32.0, 34.8, [1, 33, 0]),
    card('products/knowledge-pipelines-loop.webm', 32.0, 34.8, [1, 33, 0]),
    card('products/knowledge-pipelines.mp4', 32.0, 34.8, [1, 33, 0])
]

// Decimals, whole numbers, a dropped decimal point ("13s" for 1.3 s), and a trailing percent.
const DECIMAL = /^(\d+\.\d+)\s*(s|x)?$/i
const INTEGER = /^(\d+)/
const MILLIS = /^(\d+)\s*ms$/i
const SPLIT_SECOND = /^(\d)(\d)s$/i
const LEADING_ONE = /^[Ll][\s.]?1s?$/

function figureValue(text, height) {
    if (LEADING_ONE.test(text)) return 1.1
    if (height >= 90 && /^<\W*$/.test(text)) return 1
    if (height >= 90 && /^[Il|]$/.test(text)) return 1
    if (height >= 90 && /^[Oo]$/.test(text)) return 0
    const split = SPLIT_SECOND.exec(text) || /^(\d)(\d)\d*s$/i.exec(text)
    if (split) return Number(`${split[1]}.${split[2]}`)
    const decimal = DECIMAL.exec(text)
    if (decimal) return Number(decimal[1])
    const millis = MILLIS.exec(text)
    if (millis) return Number(millis[1])
    if (text.endsWith('%')) {
        const percent = DECIMAL.exec(text.slice(0, -1))
        if (percent) return Number(percent[1])
    }
    const integer = INTEGER.exec(text)
    if (integer && integer[0] === text.replace(/[^0-9].*$/, '')) {
        const whole = Number(integer[1])
        if (integer[0].length === 1 && whole > 1) return NaN
        return whole
    }
    return NaN
}

function sourced(value, allow) {
    // Tesseract reads the build card's 5 as 9.
    if (allow.includes(5.3) && Math.abs(value - 9.3) <= 0.06) return 5.3
    return value
}

function closeEnough(value, allow) {
    // A last-digit OCR wobble (19.85 for 19.8) still matches. The old medians do not.
    return allow.some((ok) => Math.abs(value - ok) <= 0.08)
}

function nearest(value, allow) {
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

function figuresIn(tsv) {
    const found = []
    for (const row of tsv.split('\n').slice(1)) {
        const parts = row.split('\t')
        if (parts.length < 12 || !parts[11].trim()) continue
        const conf = Number(parts[10])
        if (!Number.isFinite(conf) || conf < 40) continue
        const height = Number(parts[9])
        // The big figures are tall. Caption words stay out.
        if (!Number.isFinite(height) || height < 70) continue
        const text = parts[11].trim().replace(/[|]/g, '')
        const left = Number(parts[6])
        const value = figureValue(text, height)
        if (!Number.isFinite(value) || !Number.isFinite(left)) continue
        found.push({ value, text, conf, left })
    }
    return found
}

function ocrFrame(file, at, dest) {
    const frame = path.join(dest, 'frame.png')
    const shot = spawnSync('ffmpeg', ['-y', '-ss', String(at), '-i', file, '-frames:v', '1', frame], { encoding: 'utf8' })
    if (shot.status !== 0) throw new Error(`ffmpeg could not read ${file} at ${at}`)
    const up = path.join(dest, 'up.png')
    const scaled = spawnSync(
        'ffmpeg',
        [
            '-y',
            '-i',
            frame,
            '-vf',
            'crop=iw*0.68:ih*0.18:iw*0.15:ih*0.43,scale=iw*4:ih*4:flags=lanczos,format=gray,negate,eq=contrast=1.3',
            up
        ],
        { encoding: 'utf8' }
    )
    if (scaled.status !== 0) throw new Error(`ffmpeg could not crop ${file} at ${at}`)
    const read = spawnSync('tesseract', [up, 'stdout', '--psm', '6', '-l', 'eng', '--oem', '1', 'tsv'], {
        encoding: 'utf8',
        env: { ...process.env, OMP_THREAD_LIMIT: '1' }
    })
    if (read.status !== 0) throw new Error(read.stderr || 'tesseract failed')
    return figuresIn(read.stdout)
}

test('closing card samples show only the sourced figures', async () => {
    const listed = [...CUSTOMER_CARE_FILES, ...cards.map((card) => card.file)]
    const missing = listed.filter((name) => !fs.existsSync(path.join(media, name))).map((name) => `${name} is missing`)
    assert.deepEqual(missing, [], missing.join('\n'))
    if (!tool('tesseract') || !tool('ffmpeg')) {
        const message = 'tesseract or ffmpeg is not installed, so the closing-card check was skipped'
        if (process.env.CUTTLELY_MEDIA_REQUIRE_TOOLS === '1') assert.fail(message)
        console.log(message)
        return
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'closing-card-'))
    const bad = []
    try {
        for (const name of CUSTOMER_CARE_FILES) {
            bad.push(...(await scanCustomerCareFile(path.join(media, name))))
        }
        for (const card of cards) {
            const file = path.join(media, card.file)
            const seen = new Map()
            for (let at = card.from; at <= card.to + 0.001; at += 0.2) {
                const stamp = Math.round(at * 10) / 10
                const found = ocrFrame(file, stamp, tmp)
                for (const figure of found) {
                    const value = sourced(figure.value, card.allow)
                    const key = nearest(value, card.allow)
                    if (key === null) {
                        const partial = figure.text.length === 1 && card.allow.some((ok) => ok !== value && Math.floor(ok) === value)
                        if (figure.conf >= 70 && !partial) bad.push(`${card.file} @ ${stamp.toFixed(1)}s: ${figure.text}`)
                        continue
                    }
                    const lefts = seen.get(key) || []
                    lefts.push(figure.left)
                    seen.set(key, lefts)
                }
            }
            for (const value of card.require || []) {
                if (!seen.has(value)) bad.push(`${card.file}: did not read ${value}`)
            }
            const required = card.require || []
            if (required.length > 1 && required.every((value) => seen.has(value))) {
                const order = required.map((value) => median(seen.get(value)))
                for (let i = 1; i < order.length; i += 1) {
                    if (!(order[i] > order[i - 1])) bad.push(`${card.file}: figures are out of card order`)
                }
            }
        }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
    }
    assert.deepEqual(bad, [], bad.join('\n'))
})
