// Every mp4 the homepage serves should start with the moov atom, so playback
// can begin before the file has finished downloading.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const media = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'media')

function walk(dir) {
    const out = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) out.push(...walk(full))
        else if (entry.name.endsWith('.mp4')) out.push(full)
    }
    return out.sort()
}

/** Top-level boxes. Returns true when moov begins before mdat. */
export function moovBeforeMdat(buffer) {
    let offset = 0
    let moov = -1
    let mdat = -1
    while (offset + 8 <= buffer.length) {
        let size = buffer.readUInt32BE(offset)
        const type = buffer.toString('latin1', offset + 4, offset + 8)
        let header = 8
        if (size === 1) {
            if (offset + 16 > buffer.length) break
            size = Number(buffer.readBigUInt64BE(offset + 8))
            header = 16
        } else if (size === 0) {
            size = buffer.length - offset
        }
        if (type === 'moov') moov = offset
        if (type === 'mdat') mdat = offset
        if (!Number.isFinite(size) || size < header) break
        offset += size
    }
    return moov >= 0 && mdat >= 0 && moov < mdat
}

test('every served homepage mp4 has moov before mdat', () => {
    const files = walk(media)
    assert.ok(files.length > 0)
    const late = files.filter((file) => !moovBeforeMdat(fs.readFileSync(file))).map((file) => path.relative(media, file))
    assert.deepEqual(late, [], late.join('\n'))
})
