// Real Chrome, held video responses. The unit fake cannot see that play() fetches a preload="none"
// element; this counts the requests the browser actually opens.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const chrome = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((bin) =>
    existsSync(bin)
)

const page = `<!doctype html>
<meta charset="utf-8">
<style>video{display:block;width:320px;height:8vh;background:#222}</style>
<video data-demo-video muted loop playsinline preload="none" src="/media/0.mp4"></video>
${[1, 2, 3, 4, 5, 6].map((i) => `<video data-loop-video muted loop playsinline preload="none" src="/media/${i}.mp4"></video>`).join('\n')}
<script type="module">
import { initDemoVideo } from '/demo-video.mjs'
initDemoVideo()
fetch('/ready')
</script>`

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

test('a real browser keeps at most two loop downloads in flight while responses are held', { skip: chrome ? false : 'no Chrome binary' }, async () => {
    const paths = new Set()
    const seen = []
    let ready = false
    const server = createServer((req, res) => {
        const url = req.url.split('?')[0]
        seen.push(url)
        if (url === '/ready') {
            ready = true
            res.end('ok')
            return
        }
        if (url === '/demo-video.mjs') {
            res.setHeader('content-type', 'text/javascript')
            res.end(readFileSync(path.join(root, 'src/scripts/demo-video.mjs')))
            return
        }
        if (url === '/') {
            res.setHeader('content-type', 'text/html')
            res.end(page)
            return
        }
        if (url.startsWith('/media/')) {
            paths.add(url)
            // Hold the body so the slot stays taken and a later loop cannot start.
            return
        }
        res.statusCode = 404
        res.end()
    })
    const port = await listen(server)
    const dir = mkdtempSync(path.join(tmpdir(), 'loop-cap-'))
    const browser = spawn(
        chrome,
        [
            '--headless=new',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--autoplay-policy=no-user-gesture-required',
            '--window-size=1280,900',
            `--user-data-dir=${dir}`,
            `http://127.0.0.1:${port}/`
        ],
        { stdio: 'ignore' }
    )
    try {
        const deadline = Date.now() + 8000
        while (Date.now() < deadline && !(ready && paths.size >= 1)) {
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
        // Give a late play() time to open the other five, which is what the cap forbids.
        await new Promise((resolve) => setTimeout(resolve, 1000))
        assert.equal(ready, true, `the page script did not run (${seen.join(' ')})`)
        assert.deepEqual([...paths].sort(), ['/media/0.mp4', '/media/1.mp4'], `requests: ${seen.join(' ')}`)
    } finally {
        browser.kill('SIGKILL')
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
    }
})

function loopMarkup(i) {
    return `<video data-loop-video muted loop playsinline preload="none" width="960" height="540">
<source src="/media/${i}.webm" type="video/webm" />
<source src="/media/${i}.mp4" type="video/mp4" />
</video>`
}

test('a failed WebM and MP4 candidate frees the slot for the next loops', { skip: chrome ? false : 'no Chrome binary' }, async () => {
    const requested = new Set()
    const inflight = new Map()
    let peak = 0
    const note = () => {
        const ids = new Set()
        for (const [url, count] of inflight) {
            if (count <= 0) continue
            const id = url.match(/\/media\/(\d+)\./)?.[1]
            if (id) ids.add(id)
        }
        peak = Math.max(peak, ids.size)
    }
    const server = createServer((req, res) => {
        const url = req.url.split('?')[0]
        if (url === '/ready') {
            res.end('ok')
            return
        }
        if (url === '/demo-video.mjs') {
            res.setHeader('content-type', 'text/javascript')
            res.end(readFileSync(path.join(root, 'src/scripts/demo-video.mjs')))
            return
        }
        if (url === '/') {
            res.setHeader('content-type', 'text/html')
            res.end(`<!doctype html><meta charset="utf-8"><style>video{display:block;width:320px;height:8vh;background:#222}</style>
${[0, 1, 2, 3, 4, 5].map(loopMarkup).join('')}
<script type="module">import { initDemoVideo } from '/demo-video.mjs'; initDemoVideo(); fetch('/ready')</script>`)
            return
        }
        const id = url.match(/\/media\/(\d+)\./)?.[1]
        if (id) {
            requested.add(id)
            inflight.set(url, (inflight.get(url) || 0) + 1)
            note()
            req.on('close', () => {
                inflight.set(url, (inflight.get(url) || 1) - 1)
                note()
            })
            // The first two loops fail both candidates. Later loops are held so a third slot would show up.
            if (id === '0' || id === '1') {
                res.statusCode = 404
                res.end('no')
                return
            }
            return
        }
        res.statusCode = 404
        res.end()
    })
    const port = await listen(server)
    const dir = mkdtempSync(path.join(tmpdir(), 'loop-source-'))
    const browser = spawn(
        chrome,
        [
            '--headless=new',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--autoplay-policy=no-user-gesture-required',
            '--window-size=1280,900',
            `--user-data-dir=${dir}`,
            `http://127.0.0.1:${port}/`
        ],
        { stdio: 'ignore' }
    )
    try {
        const deadline = Date.now() + 8000
        while (Date.now() < deadline && !(requested.has('2') && requested.has('3'))) {
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
        assert.ok(requested.has('2') && requested.has('3'), `later loops were not requested (${[...requested].join(' ')})`)
        assert.equal(requested.has('4') || requested.has('5'), false, `cap exceeded (${[...requested].join(' ')})`)
        assert.ok(peak <= 2, `peak in-flight loops ${peak}`)
    } finally {
        browser.kill('SIGKILL')
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
    }
})
