// OCRs the entrance of each homepage closing card. A figure that is not the
// sourced value fails the test. Without tesseract or ffmpeg the check skips.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const media = path.join(root, 'public', 'media')

function tool(name) {
    return spawnSync('which', [name], { encoding: 'utf8' }).status === 0
}

/** @type {{file: string, from: number, to: number, allow: number[]}[]} */
const cards = [
    { file: 'customer-care-demo.mp4', from: 71.0, to: 73.0, allow: [0.8, 1.9, 19.8] },
    { file: 'customer-care-demo.webm', from: 71.0, to: 73.0, allow: [0.8, 1.9, 19.8] },
    { file: 'products/chatflows-loop.mp4', from: 32.0, to: 34.2, allow: [1.1, 1.3] },
    { file: 'products/chatflows.mp4', from: 32.0, to: 34.2, allow: [1.1, 1.3] },
    { file: 'products/agentflows-loop.mp4', from: 26.8, to: 29.2, allow: [0.9, 1.2, 0.8] },
    { file: 'products/agentflows.mp4', from: 26.8, to: 29.2, allow: [0.9, 1.2, 0.8] },
    { file: 'products/share-and-embed-loop.mp4', from: 24.2, to: 26.6, allow: [0.4, 0.8] },
    { file: 'products/share-and-embed.mp4', from: 24.2, to: 26.6, allow: [0.4, 0.8] },
    { file: 'products/harnesses-loop.mp4', from: 44.4, to: 47.2, allow: [4.2, 855, 3.7] },
    { file: 'products/harnesses.mp4', from: 44.4, to: 47.2, allow: [4.2, 855, 3.7] },
    { file: 'products/build-with-ai-loop.mp4', from: 28.0, to: 30.6, allow: [5.3, 4.0, 701] },
    { file: 'products/build-with-ai.mp4', from: 28.0, to: 30.6, allow: [5.3, 4.0, 701] },
    { file: 'products/knowledge-pipelines-loop.mp4', from: 32.0, to: 34.8, allow: [1, 33, 0] },
    { file: 'products/knowledge-pipelines.mp4', from: 32.0, to: 34.8, allow: [1, 33, 0] }
]

// A decimal figure, or a millisecond figure. Bare "19s" and "20 runs" are not figures.
const DECIMAL = /^(\d+\.\d+)\s*(s|x)?$/i
const MILLIS = /^(\d+)\s*ms$/i

function closeEnough(value, allow) {
    return allow.some((ok) => Math.abs(value - ok) < 0.05)
}

function figuresIn(tsv) {
    const found = []
    for (const row of tsv.split('\n').slice(1)) {
        const parts = row.split('\t')
        if (parts.length < 12 || !parts[11].trim()) continue
        const conf = Number(parts[10])
        if (!Number.isFinite(conf) || conf < 80) continue
        const height = Number(parts[9])
        // The big figures are tall. Caption words and "20 runs" stay out.
        if (!Number.isFinite(height) || height < 28) continue
        const text = parts[11].trim().replace(/[|]/g, '')
        const match = DECIMAL.exec(text) || MILLIS.exec(text)
        if (!match) continue
        const value = Number(match[1])
        if (!Number.isFinite(value)) continue
        found.push({ value, text, conf })
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
        ['-y', '-i', frame, '-vf', 'crop=iw*0.7:ih*0.34:iw*0.15:ih*0.40,scale=iw*2:ih*2:flags=lanczos', up],
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

test('closing card entrance shows only the sourced figures', () => {
    if (!tool('tesseract') || !tool('ffmpeg')) {
        console.log('tesseract or ffmpeg is not installed, so the closing-card check was skipped')
        return
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'closing-card-'))
    const bad = []
    try {
        for (const card of cards) {
            const file = path.join(media, card.file)
            if (!fs.existsSync(file)) continue
            for (let at = card.from; at <= card.to + 0.001; at += 0.4) {
                const stamp = Math.round(at * 10) / 10
                const found = ocrFrame(file, stamp, tmp)
                for (const figure of found) {
                    if (!closeEnough(figure.value, card.allow)) {
                        bad.push(`${card.file} @ ${stamp.toFixed(1)}s: ${figure.text}`)
                    }
                }
            }
        }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
    }
    assert.deepEqual(bad, [], bad.join('\n'))
})
