// Real Chrome, held video responses. The unit fake cannot see that play() fetches a preload="none"
// element; this counts the requests the browser actually opens.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
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

test(
    'a real browser keeps at most two loop downloads in flight while responses are held',
    { skip: chrome ? false : 'no Chrome binary' },
    async () => {
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
    }
)

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

test('resume after an aborted fetch requests the next loops', { skip: chrome ? false : 'no Chrome binary' }, async () => {
    const requested = new Set()
    const tries = new Map()
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
        if (!id) {
            res.statusCode = 404
            res.end()
            return
        }
        requested.add(id)
        tries.set(id, (tries.get(id) || 0) + 1)
        inflight.set(url, (inflight.get(url) || 0) + 1)
        note()
        req.on('close', () => {
            inflight.set(url, (inflight.get(url) || 1) - 1)
            note()
        })
        // The open download is what resume restarts. The retry fails so the slot is released.
        if ((id === '0' || id === '1') && tries.get(id) === 1) return
        if (id === '0' || id === '1') {
            res.statusCode = 404
            res.end('no')
        }
    })
    const port = await listen(server)
    const debugPort = await new Promise((resolve) => {
        const probe = createServer()
        probe.listen(0, '127.0.0.1', () => {
            const { port: free } = probe.address()
            probe.close(() => resolve(free))
        })
    })
    const dir = mkdtempSync(path.join(tmpdir(), 'loop-resume-'))
    const browser = spawn(
        chrome,
        [
            '--headless=new',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--remote-allow-origins=*',
            `--remote-debugging-port=${debugPort}`,
            '--autoplay-policy=no-user-gesture-required',
            '--window-size=1280,900',
            `--user-data-dir=${dir}`,
            `http://127.0.0.1:${port}/`
        ],
        { stdio: 'ignore' }
    )
    try {
        const started = Date.now()
        while (Date.now() - started < 8000 && !(requested.has('0') && requested.has('1'))) {
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
        assert.ok(requested.has('0') && requested.has('1'), `first loops did not start (${[...requested].join(' ')})`)
        assert.equal(requested.has('2') || requested.has('3'), false)
        const list = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json())
        const pageTarget = list.find((target) => target.type === 'page' && String(target.url).includes(String(port)))
        const ws = new WebSocket(pageTarget.webSocketDebuggerUrl)
        const pending = new Map()
        let next = 1
        const send = (method, params) => {
            const id = next++
            ws.send(JSON.stringify({ id, method, params }))
            return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
        }
        ws.addEventListener('message', (event) => {
            const message = JSON.parse(event.data)
            const waiter = pending.get(message.id)
            if (!waiter) return
            pending.delete(message.id)
            if (message.error) waiter.reject(new Error(message.error.message))
            else waiter.resolve(message.result)
        })
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true })
            ws.addEventListener('error', reject, { once: true })
        })
        // The aborted sockets are the freeze. resume is delivered while the page is visible.
        await send('Runtime.evaluate', { expression: "document.dispatchEvent(new Event('resume'))" })
        const deadline = Date.now() + 8000
        while (Date.now() < deadline && !(requested.has('2') && requested.has('3'))) {
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
        await new Promise((resolve) => setTimeout(resolve, 400))
        ws.close()
        assert.ok(requested.has('2') && requested.has('3'), `later loops were not requested (${[...requested].join(' ')})`)
        assert.equal(requested.has('4') || requested.has('5'), false, `cap exceeded (${[...requested].join(' ')})`)
        assert.ok(peak <= 2, `peak in-flight loops ${peak}`)
    } finally {
        browser.kill('SIGKILL')
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
    }
})

test('a partially buffered loop returns to its saved time after resume', { skip: chrome ? false : 'no Chrome binary' }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'loop-playhead-'))
    const clipPath = path.join(dir, 'clip.mp4')
    const encoded = spawnSync(
        'ffmpeg',
        [
            '-y',
            '-f',
            'lavfi',
            '-i',
            'testsrc=size=640x360:rate=30:duration=12',
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-profile:v',
            'high',
            '-an',
            '-movflags',
            '+faststart',
            '-g',
            '30',
            '-b:v',
            '800k',
            clipPath
        ],
        { stdio: 'ignore' }
    )
    assert.equal(encoded.status, 0, 'ffmpeg could not build the clip')
    const file = readFileSync(clipPath)
    // Drip a short prefix. One burst makes Chromium fire canplaythrough and free the slot.
    const prefixCap = 64_000
    let release = false
    const kinds = []
    const partials = []
    const drip = setInterval(() => {
        if (release) return
        for (const item of partials) {
            if (item.offset >= prefixCap) continue
            const next = file.subarray(item.offset, Math.min(prefixCap, item.offset + 8000))
            item.offset += next.length
            item.res.write(next)
        }
    }, 30)
    const server = createServer((req, res) => {
        const url = req.url.split('?')[0]
        if (url === '/demo-video.mjs') {
            res.setHeader('content-type', 'text/javascript')
            res.end(readFileSync(path.join(root, 'src/scripts/demo-video.mjs')))
            return
        }
        if (url === '/') {
            res.setHeader('content-type', 'text/html')
            res.end(`<!doctype html><meta charset="utf-8"><style>video{display:block;width:320px;height:30vh;background:#222}</style>
<video data-demo-video muted playsinline preload="none" src="/clip.mp4"></video>
<video data-loop-video muted playsinline preload="none" src="/clip.mp4"></video>
<script type="module">
import { initDemoVideo } from '/demo-video.mjs'
for (const video of document.querySelectorAll('video')) {
    video.addEventListener('canplaythrough', () => {
        video.dataset.through = '1'
    })
}
initDemoVideo()
</script>`)
            return
        }
        if (url === '/clip.mp4') {
            kinds.push(release ? 'full' : 'partial')
            if (!release) {
                // No content length: Chromium will play this chunk while the socket stays open.
                res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' })
                partials.push({ res, offset: 0 })
                return
            }
            const header = req.headers.range
            const match = header && /bytes=(\d*)-(\d*)/.exec(header)
            const start = match && match[1] ? Number(match[1]) : 0
            let end = match && match[2] ? Number(match[2]) : file.length - 1
            end = Math.min(end, file.length - 1)
            const slice = file.subarray(start, end + 1)
            if (header) {
                res.writeHead(206, {
                    'content-type': 'video/mp4',
                    'accept-ranges': 'bytes',
                    'content-range': `bytes ${start}-${end}/${file.length}`,
                    'content-length': String(slice.length),
                    'cache-control': 'no-store'
                })
                res.end(slice)
                return
            }
            res.writeHead(200, {
                'content-type': 'video/mp4',
                'content-length': String(file.length),
                'accept-ranges': 'bytes',
                'cache-control': 'no-store'
            })
            res.end(file)
            return
        }
        res.statusCode = 404
        res.end()
    })
    const port = await listen(server)
    const debugPort = await new Promise((resolve) => {
        const probe = createServer()
        probe.listen(0, '127.0.0.1', () => {
            const { port: free } = probe.address()
            probe.close(() => resolve(free))
        })
    })
    const browser = spawn(
        chrome,
        [
            '--headless=new',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--remote-allow-origins=*',
            `--remote-debugging-port=${debugPort}`,
            '--autoplay-policy=no-user-gesture-required',
            '--window-size=1280,900',
            `--user-data-dir=${dir}`,
            `http://127.0.0.1:${port}/`
        ],
        { stdio: 'ignore' }
    )
    const snapshot = `(() => [...document.querySelectorAll('video')].map((video) => ({
        t: video.currentTime,
        rs: video.readyState,
        ns: video.networkState,
        paused: video.paused,
        through: video.dataset.through || '',
        seek: video.seekable.length ? video.seekable.end(0) : 0
    })))()`
    try {
        const list = await (async () => {
            const deadline = Date.now() + 8000
            while (Date.now() < deadline) {
                try {
                    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json())
                    const pageTarget = targets.find((target) => target.type === 'page' && String(target.url).includes(String(port)))
                    if (pageTarget) return pageTarget
                } catch {
                    // Chrome is still starting.
                }
                await new Promise((resolve) => setTimeout(resolve, 50))
            }
            return null
        })()
        assert.ok(list, 'Chrome did not open the page')
        const ws = new WebSocket(list.webSocketDebuggerUrl)
        const pending = new Map()
        let next = 1
        const send = (method, params) => {
            const id = next++
            ws.send(JSON.stringify({ id, method, params }))
            return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
        }
        ws.addEventListener('message', (event) => {
            const message = JSON.parse(event.data)
            const waiter = pending.get(message.id)
            if (!waiter) return
            pending.delete(message.id)
            if (message.error) waiter.reject(new Error(message.error.message))
            else waiter.resolve(message.result)
        })
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true })
            ws.addEventListener('error', reject, { once: true })
        })
        const read = async () => {
            const result = await send('Runtime.evaluate', { expression: snapshot, returnByValue: true })
            return result.result.value
        }
        const waitFor = async (label, predicate, ms = 8000) => {
            const deadline = Date.now() + ms
            let last = null
            while (Date.now() < deadline) {
                last = await read()
                if (last && predicate(last)) return last
                await new Promise((resolve) => setTimeout(resolve, 50))
            }
            assert.fail(`${label}: ${JSON.stringify(last)} requests ${kinds.join(',')}`)
        }
        const stillPartial = (video) => video.t > 0.3 && video.rs > 0 && video.rs < 4 && video.ns === 2 && !video.through
        await waitFor('both loops started playing while still downloading', (videos) => videos.length === 2 && videos.every(stillPartial))
        await send('Runtime.evaluate', {
            expression: `document.querySelector('[data-loop-video]').style.cssText = 'position:absolute;top:400vh;width:320px;height:30vh'`
        })
        const before = await waitFor(
            'the off-screen loop paused while its download was still open',
            (videos) => stillPartial(videos[0]) && videos[0].paused === false && stillPartial(videos[1]) && videos[1].paused === true
        )
        release = true
        await send('Runtime.evaluate', { expression: "document.dispatchEvent(new Event('resume'))" })
        const after = await waitFor('playhead restored', (videos) => {
            const playing = videos[0]
            const paused = videos[1]
            return (
                playing.paused === false &&
                playing.seek >= before[0].t &&
                playing.t + 0.25 >= before[0].t &&
                paused.paused === true &&
                paused.seek >= before[1].t &&
                Math.abs(paused.t - before[1].t) <= 0.25
            )
        })
        assert.equal(after[0].paused, false)
        assert.ok(after[0].t + 0.25 >= before[0].t, `on-screen loop at ${after[0].t}, saved ${before[0].t}`)
        assert.equal(after[1].paused, true)
        assert.ok(Math.abs(after[1].t - before[1].t) <= 0.25, `off-screen loop at ${after[1].t}, saved ${before[1].t}`)
        assert.ok(kinds.filter((kind) => kind === 'full').length >= 1)
        ws.close()
    } finally {
        clearInterval(drip)
        browser.kill('SIGKILL')
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
    }
})

test('a scrub to the start during a restore is not overwritten', { skip: chrome ? false : 'no Chrome binary' }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'loop-scrub-'))
    const clipPath = path.join(dir, 'clip.mp4')
    const encoded = spawnSync(
        'ffmpeg',
        [
            '-y',
            '-f',
            'lavfi',
            '-i',
            'testsrc=size=640x360:rate=30:duration=12',
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-profile:v',
            'high',
            '-an',
            '-movflags',
            '+faststart',
            '-g',
            '30',
            '-b:v',
            '800k',
            clipPath
        ],
        { stdio: 'ignore' }
    )
    assert.equal(encoded.status, 0, 'ffmpeg could not build the clip')
    const file = readFileSync(clipPath)
    let phase = 'partial'
    const reloads = []
    const partials = []
    const drip = setInterval(() => {
        if (phase !== 'partial') return
        for (const item of partials) {
            if (item.sent >= 80 * 1024) continue
            const next = file.subarray(item.sent, Math.min(80 * 1024, item.sent + 8000))
            item.sent += next.length
            item.res.write(next)
        }
    }, 30)
    const server = createServer((req, res) => {
        const url = req.url.split('?')[0]
        if (url === '/demo-video.mjs') {
            res.setHeader('content-type', 'text/javascript')
            res.end(readFileSync(path.join(root, 'src/scripts/demo-video.mjs')))
            return
        }
        if (url === '/') {
            res.setHeader('content-type', 'text/html')
            res.end(`<!doctype html><meta charset="utf-8"><style>video{display:block;width:320px;height:40vh;background:#222}</style>
<video data-demo-video controls muted playsinline preload="none" src="/clip.mp4"></video>
<script type="module">
import { initDemoVideo } from '/demo-video.mjs'
document.querySelector('video').addEventListener('canplaythrough', () => {
    document.querySelector('video').dataset.through = '1'
})
initDemoVideo()
</script>`)
            return
        }
        if (url === '/clip.mp4') {
            res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' })
            if (phase === 'partial') {
                partials.push({ res, sent: 0 })
                return
            }
            // Enough for metadata, not for the saved playhead, so the restore is still waiting.
            const sent = Math.min(file.length, 96 * 1024)
            res.write(file.subarray(0, sent))
            reloads.push({ res, sent })
            return
        }
        res.statusCode = 404
        res.end()
    })
    const port = await listen(server)
    const debugPort = await new Promise((resolve) => {
        const probe = createServer()
        probe.listen(0, '127.0.0.1', () => {
            const { port: free } = probe.address()
            probe.close(() => resolve(free))
        })
    })
    const browser = spawn(
        chrome,
        [
            '--headless=new',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--remote-allow-origins=*',
            `--remote-debugging-port=${debugPort}`,
            '--autoplay-policy=no-user-gesture-required',
            '--window-size=1280,900',
            `--user-data-dir=${dir}`,
            `http://127.0.0.1:${port}/`
        ],
        { stdio: 'ignore' }
    )
    const snapshot = `(() => {
        const video = document.querySelector('video')
        const end = video.seekable.length ? video.seekable.end(0) : 0
        return {
            t: video.currentTime,
            rs: video.readyState,
            ns: video.networkState,
            paused: video.paused,
            seeking: video.seeking,
            seek: end,
            through: video.dataset.through || ''
        }
    })()`
    try {
        const list = await (async () => {
            const deadline = Date.now() + 8000
            while (Date.now() < deadline) {
                try {
                    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json())
                    const pageTarget = targets.find((target) => target.type === 'page' && String(target.url).includes(String(port)))
                    if (pageTarget) return pageTarget
                } catch {
                    // Chrome is still starting.
                }
                await new Promise((resolve) => setTimeout(resolve, 50))
            }
            return null
        })()
        assert.ok(list, 'Chrome did not open the page')
        const ws = new WebSocket(list.webSocketDebuggerUrl)
        const pending = new Map()
        let next = 1
        const send = (method, params) => {
            const id = next++
            ws.send(JSON.stringify({ id, method, params }))
            return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
        }
        ws.addEventListener('message', (event) => {
            const message = JSON.parse(event.data)
            const waiter = pending.get(message.id)
            if (!waiter) return
            pending.delete(message.id)
            if (message.error) waiter.reject(new Error(message.error.message))
            else waiter.resolve(message.result)
        })
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true })
            ws.addEventListener('error', reject, { once: true })
        })
        const read = async () => {
            const result = await send('Runtime.evaluate', { expression: snapshot, returnByValue: true })
            return result.result.value
        }
        const waitFor = async (label, predicate, ms = 8000) => {
            const deadline = Date.now() + ms
            let last = null
            while (Date.now() < deadline) {
                last = await read()
                if (last && predicate(last)) return last
                await new Promise((resolve) => setTimeout(resolve, 50))
            }
            assert.fail(`${label}: ${JSON.stringify(last)} reloads ${reloads.length}`)
        }
        const before = await waitFor(
            'loop playing while the download is open',
            (video) => video.t > 0.45 && video.rs > 0 && video.rs < 4 && video.ns === 2 && !video.through
        )
        phase = 'reload'
        await send('Runtime.evaluate', { expression: "document.dispatchEvent(new Event('resume'))" })
        await waitFor(
            'reload reached metadata before the saved time was seekable',
            (video) => video.rs >= 1 && video.t < 0.2 && video.seek < before.t
        )
        await send('Runtime.evaluate', { expression: "document.querySelector('video').currentTime = 0" })
        for (const item of reloads) {
            if (item.sent < file.length) item.res.write(file.subarray(item.sent))
            item.res.end()
        }
        const after = await waitFor('file finished without restoring the old playhead', (video) => video.rs === 4 && !video.seeking, 8000)
        assert.ok(after.t + 0.2 < before.t, `scrubbed playhead ${after.t} was written back toward ${before.t}`)
        ws.close()
    } finally {
        clearInterval(drip)
        browser.kill('SIGKILL')
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
    }
})
