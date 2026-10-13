import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { mediaHash, mediaUrl } from './media-version.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('media hash is the first 8 hex characters of sha256', () => {
    assert.equal(mediaHash('hello'), crypto.createHash('sha256').update('hello').digest('hex').slice(0, 8))
    assert.equal(mediaHash('hello'), '2cf24dba')
})

test('mediaUrl appends the hash of the file it names', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-url-'))
    fs.mkdirSync(path.join(dir, 'media'))
    fs.writeFileSync(path.join(dir, 'media', 'clip.mp4'), 'frame-bytes')
    const url = mediaUrl('/media/clip.mp4', dir)
    assert.equal(url, `/media/clip.mp4?v=${mediaHash('frame-bytes')}`)
    fs.writeFileSync(path.join(dir, 'media', 'clip.mp4'), 'other-bytes')
    assert.notEqual(mediaUrl('/media/clip.mp4', dir), url)
})

test('every homepage video and poster URL carries that file content hash', () => {
    const astro = fs.readFileSync(path.join(root, 'src/pages/index.astro'), 'utf8')
    const stripped = astro.replace(/mediaUrl\(\s*(['"`])\/media\/[\s\S]*?\1\s*\)/g, '')
    assert.equal(/\/media\//.test(stripped), false, 'a homepage media path is not passed through mediaUrl')

    const htmlPath = path.join(root, 'dist', 'index.html')
    assert.equal(fs.existsSync(htmlPath), true, 'npm run build must run before this test so dist/index.html exists')
    const html = fs.readFileSync(htmlPath, 'utf8')
    const urls = [...html.matchAll(/\b(?:src|poster|href)="(\/media\/[^"]+)"/g)].map((match) => match[1])
    assert.ok(urls.length >= 20, `expected the homepage media urls, found ${urls.length}`)
    for (const url of urls) {
        const clean = url.split('?')[0]
        assert.equal(url, mediaUrl(clean), url)
        assert.match(url, /\?v=[0-9a-f]{8}$/)
    }
})
