import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { localMediaHref, mediaHash, mediaHrefProblems, mediaHrefs, mediaUrl, repoMediaLinkProblems } from './media-version.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The built homepage, produced here so `npm test` does not depend on a build that already ran. */
function builtHomepage() {
    const htmlPath = path.join(root, 'dist', 'index.html')
    const inputs = [
        path.join(root, 'src/pages/index.astro'),
        path.join(root, 'scripts/media-version.mjs'),
        path.join(root, 'astro.config.mjs')
    ]
    const built = fs.existsSync(htmlPath) ? fs.statSync(htmlPath).mtimeMs : 0
    const stale = inputs.some((file) => fs.statSync(file).mtimeMs > built)
    if (stale) {
        const result = spawnSync('npm', ['run', 'build'], {
            cwd: root,
            stdio: 'inherit',
            env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', CI: '1' }
        })
        assert.equal(result.status, 0, 'homepage build failed')
    }
    return fs.readFileSync(htmlPath, 'utf8')
}

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

    const html = builtHomepage()
    const urls = [...html.matchAll(/\b(?:src|poster|href)="(\/media\/[^"]+)"/g)].map((match) => match[1])
    assert.ok(urls.length >= 20, `expected the homepage media urls, found ${urls.length}`)
    for (const url of urls) {
        const clean = url.split('?')[0]
        assert.equal(url, mediaUrl(clean), url)
        assert.match(url, /\?v=[0-9a-f]{8}$/)
    }
    const og = html.match(/property="og:image" content="https:\/\/cuttlely\.com(\/social\/[^"]+)"/)
    assert.ok(og, 'the homepage Open Graph image is a hashed /social URL')
    assert.equal(og[1], mediaUrl(og[1].split('?')[0]))
    assert.match(og[1], /\?v=[0-9a-f]{8}$/)
})

test('mediaHrefs skips file paths and mediaUrl() calls', () => {
    const text = [
        'https://cuttlely.com/media/products/testing.mp4',
        'src="./website/public/media/products/testing-poster.webp"',
        "poster={mediaUrl('/media/products/testing-poster.webp')}"
    ].join('\n')
    assert.deepEqual(mediaHrefs(text), ['https://cuttlely.com/media/products/testing.mp4'])
})

test('localMediaHref drops only the site origin, not a lookalike host', () => {
    assert.equal(localMediaHref('https://cuttlely.com/media/clip.mp4?v=abcd1234'), '/media/clip.mp4?v=abcd1234')
    assert.equal(localMediaHref('/media/clip.mp4?v=abcd1234'), '/media/clip.mp4?v=abcd1234')
    assert.equal(localMediaHref('https://cuttlely.com.example/media/clip.mp4'), 'https://cuttlely.com.example/media/clip.mp4')
})

test('mediaHrefProblems fails a missing or stale hash and accepts the file hash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-href-'))
    fs.mkdirSync(path.join(dir, 'media'))
    fs.writeFileSync(path.join(dir, 'media', 'clip.mp4'), 'frame-bytes')
    const hashed = mediaUrl('/media/clip.mp4', dir)
    assert.deepEqual(mediaHrefProblems(`<a href="/media/clip.mp4">`, dir), ['/media/clip.mp4'])
    assert.deepEqual(mediaHrefProblems(`<a href="/media/clip.mp4?v=deadbeef">`, dir), ['/media/clip.mp4?v=deadbeef'])
    assert.deepEqual(mediaHrefProblems(`<a href="${hashed}">`, dir), [])
    assert.deepEqual(mediaHrefProblems(`<a href="https://cuttlely.com${hashed}">`, dir), [])
})

test('repository markdown media links carry the hash of the public file', () => {
    const repo = path.resolve(root, '..')
    assert.deepEqual(repoMediaLinkProblems(repo), [])
})
