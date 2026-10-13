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
