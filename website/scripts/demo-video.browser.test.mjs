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

const posterPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function connectChrome(port, debugPort) {
    return (async () => {
        const deadline = Date.now() + 8000
        let page = null
        while (Date.now() < deadline) {
            try {
                const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json())
                page = targets.find((target) => target.type === 'page' && String(target.url).includes(String(port)))
                if (page) break
            } catch {
                // Chrome is still starting.
            }
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
        assert.ok(page, 'Chrome did not open the page')
        const ws = new WebSocket(page.webSocketDebuggerUrl)
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
        const evalValue = async (expression) => {
            const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
            if (result.exceptionDetails) {
                const details = result.exceptionDetails
                throw new Error(details.exception?.description || details.text || 'evaluate failed')
            }
            return result.result.value
        }
        return {
            send,
            evalValue,
            close: () => ws.close()
        }
    })()
}

test(
    'reduced motion keeps a play button and the poster on the hero and every tile',
    { skip: chrome ? false : 'no Chrome binary' },
    async () => {
        const requested = []
        const tiles = [1, 2, 3, 4, 5, 6]
            .map(
                (i) => `<div class="stage">
<video data-loop-video muted loop playsinline preload="none" poster="/poster.webp" src="/media/${i}.mp4"></video>
<button type="button" class="cl-play-overlay" data-play-with-sound aria-label="Play tile ${i} with sound">Play</button>
</div>`
            )
            .join('')
        const server = createServer((req, res) => {
            const url = req.url.split('?')[0]
            requested.push(url)
            if (url === '/demo-video.mjs') {
                res.setHeader('content-type', 'text/javascript')
                res.end(readFileSync(path.join(root, 'src/scripts/demo-video.mjs')))
                return
            }
            if (url === '/poster.webp') {
                res.setHeader('content-type', 'image/png')
                res.end(posterPng)
                return
            }
            if (url === '/') {
                res.setHeader('content-type', 'text/html')
                res.end(`<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; }
  .stage { position: relative; width: 320px; }
  video { display: block; width: 320px; height: 80px; background: #221a44; }
  .cl-play-overlay { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 5.75rem; height: 5.75rem; }
</style>
<div class="stage">
<video data-demo-video muted loop playsinline preload="none" poster="/poster.webp" src="/media/0.mp4"></video>
<button type="button" class="cl-play-overlay" data-play-with-sound aria-label="Play the demo with sound">Play</button>
</div>
${tiles}
<script type="module">
import { initDemoVideo } from '/demo-video.mjs'
window.__start = () => {
  document.body.dataset.started = initDemoVideo() ? 'yes' : 'no'
}
</script>`)
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
        const dir = mkdtempSync(path.join(tmpdir(), 'play-reduced-'))
        const browser = spawn(
            chrome,
            [
                '--headless=new',
                '--no-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--remote-allow-origins=*',
                `--remote-debugging-port=${debugPort}`,
                '--window-size=1280,900',
                `--user-data-dir=${dir}`,
                `http://127.0.0.1:${port}/`
            ],
            { stdio: 'ignore' }
        )
        try {
            const { send, evalValue, close } = await connectChrome(port, debugPort)
            const readyDeadline = Date.now() + 8000
            let ready = false
            while (Date.now() < readyDeadline) {
                ready = await evalValue(`typeof window.__start === 'function'`)
                if (ready) break
                await new Promise((resolve) => setTimeout(resolve, 50))
            }
            assert.equal(ready, true)
            await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
            const reduced = await evalValue(`matchMedia('(prefers-reduced-motion: reduce)').matches`)
            assert.equal(reduced, true)
            await evalValue('window.__start()')
            const state = await evalValue(`(() => {
            const buttons = [...document.querySelectorAll('[data-play-with-sound]')]
            const videos = [...document.querySelectorAll('video')]
            return {
                started: document.body.dataset.started,
                buttons: buttons.map((button) => ({
                    tag: button.tagName,
                    type: button.type,
                    label: button.getAttribute('aria-label'),
                    hidden: button.hidden,
                    width: button.getBoundingClientRect().width
                })),
                videos: videos.map((video) => ({
                    paused: video.paused,
                    poster: video.getAttribute('poster'),
                    preload: video.preload,
                    ready: video.readyState
                }))
            }
        })()`)
            assert.equal(state.started, 'no')
            assert.equal(state.buttons.length, 7)
            assert.equal(state.videos.length, 7)
            assert.equal(state.buttons[0].label, 'Play the demo with sound')
            for (const button of state.buttons) {
                assert.equal(button.tag, 'BUTTON')
                assert.equal(button.type, 'button')
                assert.equal(button.hidden, false)
                assert.ok(button.width >= 80, `play button width ${button.width}`)
            }
            for (const video of state.videos) {
                assert.equal(video.paused, true)
                assert.equal(video.poster, '/poster.webp')
                assert.equal(video.preload, 'none')
                assert.equal(video.ready, 0)
            }
            assert.equal(
                requested.some((url) => url.startsWith('/media/')),
                false
            )
            close()
        } finally {
            browser.kill('SIGKILL')
            server.closeAllConnections()
            await new Promise((resolve) => server.close(resolve))
        }
    }
)

test(
    'clicking play starts at the beginning with sound, and a tile dialog does that every time',
    { skip: chrome ? false : 'no Chrome binary' },
    async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'play-sound-'))
        const clipPath = path.join(dir, 'clip.mp4')
        const encoded = spawnSync(
            'ffmpeg',
            [
                '-y',
                '-f',
                'lavfi',
                '-i',
                'testsrc=size=320x180:rate=30:duration=2',
                '-f',
                'lavfi',
                '-i',
                'sine=frequency=440:sample_rate=44100:duration=2',
                '-c:v',
                'libx264',
                '-pix_fmt',
                'yuv420p',
                '-profile:v',
                'high',
                '-c:a',
                'aac',
                '-shortest',
                '-movflags',
                '+faststart',
                '-g',
                '30',
                clipPath
            ],
            { stdio: 'ignore' }
        )
        assert.equal(encoded.status, 0, 'ffmpeg could not build the clip')
        const file = readFileSync(clipPath)
        const server = createServer((req, res) => {
            const url = req.url.split('?')[0]
            if (url === '/demo-video.mjs') {
                res.setHeader('content-type', 'text/javascript')
                res.end(readFileSync(path.join(root, 'src/scripts/demo-video.mjs')))
                return
            }
            if (url === '/clip.mp4') {
                res.writeHead(200, {
                    'content-type': 'video/mp4',
                    'content-length': String(file.length),
                    'accept-ranges': 'bytes',
                    'cache-control': 'no-store'
                })
                res.end(file)
                return
            }
            if (url === '/') {
                res.setHeader('content-type', 'text/html')
                res.end(`<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; }
  .stage { position: relative; width: 640px; }
  video { display: block; width: 640px; height: 200px; background: #222; }
  button.cl-play-overlay { position: absolute; top: 50%; left: 50%; width: 5.75rem; height: 5.75rem; transform: translate(-50%, -50%); }
</style>
<div class="stage">
<video data-demo-video controls muted loop playsinline preload="none" poster="/poster.webp" src="/clip.mp4"></video>
<button type="button" class="cl-play-overlay" data-play-with-sound aria-label="Play the demo with sound">Play</button>
</div>
<div class="stage">
<video data-loop-video muted loop playsinline preload="none" poster="/poster.webp" src="/clip.mp4"></video>
<button type="button" class="cl-play-overlay" data-play-with-sound data-video-dialog-open="full" aria-label="Play the tile with sound">Play</button>
<dialog id="full"><video controls playsinline preload="none" src="/clip.mp4"></video></dialog>
</div>
<section id="test-every-change-before-it-goes-live">
<div class="stage">
<video id="testing-player" data-demo-video controls muted loop playsinline preload="none" poster="/poster.webp" src="/clip.mp4"></video>
<button type="button" class="cl-play-overlay" data-play-with-sound aria-label="Play the testing video with sound">Play</button>
</div>
</section>
<script type="module">
import { initDemoVideo, initVideoDialogs } from '/demo-video.mjs'
initDemoVideo()
initVideoDialogs()
</script>`)
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
        const readExpr = `(() => {
        const hero = document.querySelector('[data-demo-video]')
        const heroButton = hero.nextElementSibling
        const tile = document.querySelector('[data-loop-video]')
        const dialog = document.getElementById('full')
        const full = dialog.querySelector('video')
        return {
            hero: { t: hero.currentTime, muted: hero.muted, loop: hero.loop, controls: hero.controls, volume: hero.volume, paused: hero.paused },
            heroButtonHidden: heroButton.hidden,
            dialogOpen: dialog.open,
            full: full ? { t: full.currentTime, muted: full.muted, loop: full.loop, paused: full.paused, volume: full.volume } : null
        }
    })()`
        try {
            const { send, evalValue, close } = await connectChrome(port, debugPort)
            const waitFor = async (label, predicate, ms = 8000) => {
                const deadline = Date.now() + ms
                let last = null
                while (Date.now() < deadline) {
                    last = await evalValue(readExpr)
                    if (last && predicate(last)) return last
                    await new Promise((resolve) => setTimeout(resolve, 50))
                }
                assert.fail(`${label}: ${JSON.stringify(last)}`)
            }
            const before = await waitFor(
                'silent preview advanced',
                (state) => state.hero.t > 0.35 && state.hero.muted === true && state.hero.loop === true
            )
            assert.equal(before.heroButtonHidden, false)
            // Headless key events do not activate a focused button. Enter and Space still do in a browser,
            // because the control is a real button; this click is the activation those keys perform.
            const pressed = await evalValue(`(() => {
            const video = document.querySelector('[data-demo-video]')
            const button = document.querySelector('[data-play-with-sound]')
            video.volume = 0.3
            const rect = button.getBoundingClientRect()
            button.click()
            return { tag: button.tagName, type: button.type, width: rect.width }
        })()`)
            assert.equal(pressed.tag, 'BUTTON')
            assert.equal(pressed.type, 'button')
            assert.ok(pressed.width >= 80)
            const playing = await waitFor(
                'hero restarted with sound',
                (state) =>
                    state.hero.muted === false &&
                    state.hero.loop === false &&
                    state.hero.controls === true &&
                    state.hero.t < 0.45 &&
                    state.heroButtonHidden === true,
                4000
            )
            assert.equal(playing.hero.muted, false)
            assert.equal(playing.hero.volume, 0.3)
            assert.ok(playing.hero.t + 0.05 < before.hero.t, `playhead ${playing.hero.t} did not return before ${before.hero.t}`)
            await evalValue(`(() => {
            const hero = document.querySelector('[data-demo-video]')
            hero.currentTime = Math.max(0, (hero.duration || 2) - 0.08)
            const pending = hero.play()
            if (pending && pending.catch) pending.catch(() => {})
        })()`)
            const reset = await waitFor(
                'hero returned to the silent preview',
                (state) =>
                    state.heroButtonHidden === false &&
                    state.hero.muted === true &&
                    state.hero.loop === true &&
                    state.hero.controls === false
            )
            assert.ok(reset.hero.t < 0.6, `preview playhead ${reset.hero.t}`)
            await evalValue(`document.querySelector('#full video').volume = 0.3`)
            await evalValue(`document.querySelector('[data-loop-video]').click()`)
            const dialog = await waitFor(
                'tile preview opened the dialog',
                (state) => state.dialogOpen === true && state.full && state.full.muted === false && state.full.loop === false
            )
            assert.ok(dialog.full.t < 0.45, `dialog playhead ${dialog.full.t}`)
            assert.equal(dialog.full.muted, false)
            assert.equal(dialog.full.volume, 0.3)
            await evalValue(`document.querySelector('#full video').currentTime = 1.1`)
            await evalValue(`document.getElementById('full').close()`)
            const closed = await waitFor('dialog paused', (state) => state.dialogOpen === false && state.full.paused === true)
            assert.ok(closed.full.t > 0.8, `closed playhead ${closed.full.t}`)
            await evalValue(`document.querySelector('#full video').volume = 0.3`)
            await evalValue(`document.querySelector('[data-video-dialog-open]').click()`)
            const again = await waitFor(
                'dialog reopened at the start',
                (state) => state.dialogOpen === true && state.full.muted === false && state.full.t < 0.45
            )
            assert.ok(again.full.t < 0.45)
            assert.equal(again.full.muted, false)
            assert.equal(again.full.volume, 0.3)
            assert.equal(again.full.loop, false)
            const overlays = await evalValue(`(() => {
            const section = document.querySelector('[aria-label="Play the testing video with sound"]')
            const sectionRect = section ? section.getBoundingClientRect() : null
            return {
                section: section ? { tag: section.tagName, hidden: section.hidden, width: sectionRect.width } : null,
                testingVideos: document.querySelectorAll('#test-every-change-before-it-goes-live video').length,
                testingTile: document.getElementById('testing-tile')
            }
        })()`)
            assert.equal(overlays.section.tag, 'BUTTON')
            assert.equal(overlays.section.hidden, false)
            assert.ok(overlays.section.width >= 80)
            assert.equal(overlays.testingVideos, 1)
            assert.equal(overlays.testingTile, null)
            await evalValue(`document.getElementById('testing-player').volume = 0.3`)
            await evalValue(`document.querySelector('[aria-label="Play the testing video with sound"]').click()`)
            const testingRead = `(() => {
            const video = document.getElementById('testing-player')
            const button = document.querySelector('[aria-label="Play the testing video with sound"]')
            return { t: video.currentTime, muted: video.muted, loop: video.loop, controls: video.controls, volume: video.volume, paused: video.paused, buttonHidden: button.hidden }
        })()`
            const testingDeadline = Date.now() + 4000
            let testing = null
            while (Date.now() < testingDeadline) {
                testing = await evalValue(testingRead)
                if (testing && testing.muted === false && testing.loop === false && testing.t < 0.45 && testing.buttonHidden === true) break
                await new Promise((resolve) => setTimeout(resolve, 50))
            }
            assert.equal(testing.muted, false, `testing player ${JSON.stringify(testing)}`)
            assert.equal(testing.loop, false)
            assert.ok(testing.t < 0.45, `testing playhead ${testing.t}`)
            assert.equal(testing.volume, 0.3)
            assert.equal(testing.buttonHidden, true)
            close()
        } finally {
            browser.kill('SIGKILL')
            server.closeAllConnections()
            await new Promise((resolve) => server.close(resolve))
        }
    }
)

test('the tile play button stays clear of the watch chip at each column width', { skip: chrome ? false : 'no Chrome binary' }, async () => {
    const tile = (title) => `<li class="cl-tile"><div class="cl-tile-media">
<video class="cl-tile-video" data-loop-video muted loop playsinline preload="none" width="960" height="540"></video>
<button type="button" class="cl-play-overlay" data-play-with-sound aria-label="Play ${title} with sound">
<svg viewBox="0 0 24 24" width="36" height="36" aria-hidden="true"><path d="M8 5v14l12-7z" fill="currentColor" /></svg>
</button>
<a class="cl-tile-play" href="/clip.mp4">Watch with sound <span class="cl-tile-play-length">0:35</span></a>
</div></li>`
    const server = createServer((req, res) => {
        const url = req.url.split('?')[0]
        if (url === '/site.css') {
            res.setHeader('content-type', 'text/css')
            res.end(readFileSync(path.join(root, 'src/styles/site.css')))
            return
        }
        if (url === '/brand.css') {
            res.setHeader('content-type', 'text/css')
            res.end(readFileSync(path.join(root, 'src/styles/brand.css')))
            return
        }
        if (url === '/') {
            res.setHeader('content-type', 'text/html')
            res.end(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/brand.css">
<link rel="stylesheet" href="/site.css">
<style>:root { --sl-text-xs: 0.8125rem; } body { margin: 0; } .frame { box-sizing: border-box; max-width: 72rem; margin: 0 auto; padding: 1.5rem; }</style>
<div class="frame cl-home" data-theme="light">
<div class="cl-video-stage"><video class="cl-demo-video" data-demo-video width="1280" height="720"></video>
<button type="button" class="cl-play-overlay" data-play-with-sound aria-label="Play the demo with sound">Play</button></div>
<ul class="cl-tiles">${['Knowledge pipelines', 'Chatflows', 'Agentflows'].map(tile).join('')}</ul>
</div>`)
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
    const dir = mkdtempSync(path.join(tmpdir(), 'play-size-'))
    const browser = spawn(
        chrome,
        [
            '--headless=new',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--remote-allow-origins=*',
            `--remote-debugging-port=${debugPort}`,
            '--window-size=1280,900',
            `--user-data-dir=${dir}`,
            '--force-prefers-color-scheme=light',
            `http://127.0.0.1:${port}/`
        ],
        { stdio: 'ignore' }
    )
    const measure = `(() => {
        const boxes = (el) => {
            const r = el.getBoundingClientRect()
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
        }
        const axisGap = (a, b) => ({
            x: Math.max(a.left - b.right, b.left - a.right),
            y: Math.max(a.top - b.bottom, b.top - a.bottom)
        })
        const contrast = (rgb) => {
            const parts = rgb.match(/[\\d.]+/g).map(Number)
            const lin = (c) => {
                const s = c / 255
                return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
            }
            return 0.2126 * lin(parts[0]) + 0.7152 * lin(parts[1]) + 0.0722 * lin(parts[2])
        }
        const button = document.querySelector('.cl-tile-media .cl-play-overlay')
        const paint = getComputedStyle(button)
        const lumA = contrast(paint.backgroundColor)
        const lumB = contrast(paint.color)
        const ratio = (Math.max(lumA, lumB) + 0.05) / (Math.min(lumA, lumB) + 0.05)
        let ring = ''
        for (const sheet of document.styleSheets) {
            let rules
            try {
                rules = [...sheet.cssRules]
            } catch {
                continue
            }
            for (const rule of rules) {
                if (rule.selectorText === '.cl-play-overlay:focus-visible') ring = rule.cssText
            }
        }
        return {
            hero: boxes(document.querySelector('.cl-video-stage .cl-play-overlay')).width,
            innerWidth: window.innerWidth,
            tiles: [...document.querySelectorAll('.cl-tile')].map((tile) => {
                const play = tile.querySelector('.cl-play-overlay')
                const chip = tile.querySelector('.cl-tile-play')
                const frame = boxes(tile.querySelector('.cl-tile-video'))
                const a = boxes(play)
                const b = boxes(chip)
                const sep = axisGap(a, b)
                return {
                    button: a.width,
                    chip: b.width,
                    sepX: sep.x,
                    sepY: sep.y,
                    titleGap: frame.left + frame.width * 0.498 - a.right,
                    frame: frame.width
                }
            }),
            contrast: ratio,
            ring
        }
    })()`
    try {
        const { send, evalValue, close } = await connectChrome(port, debugPort)
        await evalValue(`document.documentElement.dataset.theme = 'light'`)
        for (const width of [1280, 1024, 480, 390]) {
            await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
            await evalValue(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
            const state = await evalValue(measure)
            assert.ok(Math.abs(state.innerWidth - width) <= 2, `${width}px laid out at ${state.innerWidth}`)
            assert.ok(state.hero >= 76, `${width}px hero button ${state.hero}`)
            if (width >= 640) assert.ok(state.hero >= 90, `${width}px hero button ${state.hero}`)
            assert.equal(state.tiles.length, 3)
            for (const tile of state.tiles) {
                assert.ok(tile.button >= 56 && tile.button <= 64, `${width}px tile button ${tile.button}`)
                assert.ok(tile.button >= 44, `${width}px hit area ${tile.button}`)
                const overlaps = tile.sepX < 0 && tile.sepY < 0
                assert.equal(overlaps, false, `${width}px button overlaps the chip ${JSON.stringify(tile)}`)
                assert.ok(tile.sepX >= 8 || tile.sepY >= 8, `${width}px button/chip clearance ${JSON.stringify(tile)}`)
                assert.ok(tile.titleGap >= 4, `${width}px button crosses the title ${JSON.stringify(tile)}`)
            }
            assert.ok(state.contrast >= 4.5, `${width}px contrast ${state.contrast}`)
            assert.match(state.ring, /3px/)
            assert.match(state.ring, /outline-offset:\s*4px/)
        }
        close()
    } finally {
        browser.kill('SIGKILL')
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
    }
})

function shortClip(dir) {
    const clipPath = path.join(dir, 'clip.mp4')
    const encoded = spawnSync(
        'ffmpeg',
        [
            '-y',
            '-f',
            'lavfi',
            '-i',
            'testsrc=size=320x180:rate=30:duration=2',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=440:sample_rate=44100:duration=2',
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-shortest',
            '-movflags',
            '+faststart',
            clipPath
        ],
        { stdio: 'ignore' }
    )
    assert.equal(encoded.status, 0, 'ffmpeg could not build the clip')
    return readFileSync(clipPath)
}

async function openDebugChrome(port, { width = 1280, height = 900, reduced = false } = {}) {
    const debugPort = await new Promise((resolve) => {
        const probe = createServer()
        probe.listen(0, '127.0.0.1', () => {
            const { port: free } = probe.address()
            probe.close(() => resolve(free))
        })
    })
    const dir = mkdtempSync(path.join(tmpdir(), 'play-fix-'))
    const args = [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--remote-allow-origins=*',
        `--remote-debugging-port=${debugPort}`,
        `--window-size=${width},${height}`,
        '--autoplay-policy=no-user-gesture-required',
        `--user-data-dir=${dir}`,
        `http://127.0.0.1:${port}/`
    ]
    if (reduced) args.splice(1, 0, '--force-prefers-reduced-motion')
    const browser = spawn(chrome, args, { stdio: 'ignore' })
    const session = await connectChrome(port, debugPort)
    return { browser, ...session }
}

test(
    'reduced motion returns the hero poster without a second fetch, then replays from the start',
    { skip: chrome ? false : 'no Chrome binary' },
    async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'play-poster-'))
        const file = shortClip(dir)
        let clips = 0
        const server = createServer((req, res) => {
            const url = req.url.split('?')[0]
            if (url === '/demo-video.mjs') {
                res.setHeader('content-type', 'text/javascript')
                res.end(readFileSync(path.join(root, 'src/scripts/demo-video.mjs')))
                return
            }
            if (url === '/poster.webp') {
                res.setHeader('content-type', 'image/png')
                res.end(posterPng)
                return
            }
            if (url === '/count') {
                res.end(String(clips))
                return
            }
            if (url === '/clip.mp4') {
                clips += 1
                res.writeHead(200, {
                    'content-type': 'video/mp4',
                    'content-length': String(file.length),
                    'accept-ranges': 'bytes',
                    'cache-control': 'no-store'
                })
                res.end(file)
                return
            }
            if (url === '/') {
                res.setHeader('content-type', 'text/html')
                res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>video{display:block;width:320px;height:180px;background:#111}</style>
<video data-demo-video controls muted loop playsinline preload="none" poster="/poster.webp" width="320" height="180">
<source src="/clip.mp4" type="video/mp4" />
</video>
<button type="button" data-play-with-sound aria-label="Play the demo with sound">Play</button>
<script type="module">
import { initDemoVideo } from '/demo-video.mjs'
window.__start = () => { document.body.dataset.autoplay = initDemoVideo() ? '1' : '0' }
</script>`)
                return
            }
            res.statusCode = 404
            res.end()
        })
        const port = await listen(server)
        const { browser, send, evalValue, close } = await openDebugChrome(port, { reduced: true })
        const read = `(() => {
        const video = document.querySelector('[data-demo-video]')
        const button = document.querySelector('[data-play-with-sound]')
        return {
            autoplay: document.body.dataset.autoplay || '',
            src: video.currentSrc,
            width: video.videoWidth,
            ready: video.readyState,
            paused: video.paused,
            muted: video.muted,
            t: video.currentTime,
            hidden: button.hidden,
            poster: video.getAttribute('poster') || '',
            sources: video.querySelectorAll('source').length
        }
    })()`
        try {
            await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
            const readyDeadline = Date.now() + 8000
            let ready = false
            while (Date.now() < readyDeadline) {
                ready = await evalValue(`typeof window.__start === 'function'`)
                if (ready) break
                await new Promise((resolve) => setTimeout(resolve, 50))
            }
            assert.equal(ready, true)
            await evalValue('window.__start()')
            const started = await evalValue(read)
            assert.equal(started.autoplay, '0')
            assert.equal(started.poster, '/poster.webp')
            await evalValue(`document.querySelector('[data-play-with-sound]').click()`)
            const playing = await (async () => {
                const deadline = Date.now() + 8000
                let last = null
                while (Date.now() < deadline) {
                    last = await evalValue(read)
                    if (last.muted === false && last.paused === false && last.t > 0.15) return last
                    await new Promise((resolve) => setTimeout(resolve, 50))
                }
                assert.fail(`hero did not start: ${JSON.stringify(last)}`)
            })()
            assert.ok(playing.sources >= 1)
            await evalValue(`(() => {
            const video = document.querySelector('[data-demo-video]')
            video.currentTime = Math.max(0, (video.duration || 2) - 0.08)
            const pending = video.play()
            if (pending && pending.catch) pending.catch(() => {})
        })()`)
            const ended = await (async () => {
                const deadline = Date.now() + 8000
                let last = null
                while (Date.now() < deadline) {
                    last = await evalValue(read)
                    if (
                        last.hidden === false &&
                        last.sources === 0 &&
                        last.ready === 0 &&
                        last.width === 0 &&
                        last.poster === '/poster.webp'
                    )
                        return last
                    await new Promise((resolve) => setTimeout(resolve, 50))
                }
                assert.fail(`poster did not return: ${JSON.stringify(last)}`)
            })()
            assert.equal(ended.width, 0)
            assert.equal(ended.sources, 0)
            const beforeReplay = clips
            await new Promise((resolve) => setTimeout(resolve, 300))
            assert.equal(clips, beforeReplay, 'loading the poster fetched the video again')
            await evalValue(`document.querySelector('[data-play-with-sound]').click()`)
            const again = await (async () => {
                const deadline = Date.now() + 8000
                let last = null
                while (Date.now() < deadline) {
                    last = await evalValue(read)
                    if (last.muted === false && last.paused === false && last.t > 0.05 && last.t < 0.5 && last.sources >= 1) return last
                    await new Promise((resolve) => setTimeout(resolve, 50))
                }
                assert.fail(`replay did not start: ${JSON.stringify(last)}`)
            })()
            assert.ok(again.t < 0.5, `replay playhead ${again.t}`)
            await new Promise((resolve) => setTimeout(resolve, 400))
            assert.ok(clips - beforeReplay <= 1, `replay opened ${clips - beforeReplay} requests`)
            close()
        } finally {
            browser.kill('SIGKILL')
            server.closeAllConnections()
            await new Promise((resolve) => server.close(resolve))
        }
    }
)

test('a narrow page pauses the hero when a tile dialog starts', { skip: chrome ? false : 'no Chrome binary' }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'play-narrow-'))
    const file = shortClip(dir)
    const server = createServer((req, res) => {
        const url = req.url.split('?')[0]
        if (url === '/demo-video.mjs') {
            res.setHeader('content-type', 'text/javascript')
            res.end(readFileSync(path.join(root, 'src/scripts/demo-video.mjs')))
            return
        }
        if (url === '/clip.mp4') {
            res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(file.length), 'accept-ranges': 'bytes' })
            res.end(file)
            return
        }
        if (url === '/') {
            res.setHeader('content-type', 'text/html')
            res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>video{display:block;width:300px;height:160px;background:#111} .stage{position:relative}</style>
<div class="stage">
<video data-demo-video muted loop playsinline preload="none" width="320" height="180"><source src="/clip.mp4" type="video/mp4" /></video>
<button type="button" data-play-with-sound aria-label="Play the demo with sound">Play</button>
</div>
<div class="stage">
<video data-loop-video muted loop playsinline preload="none" width="320" height="180"><source src="/clip.mp4" type="video/mp4" /></video>
<button type="button" data-play-with-sound data-video-dialog-open="full" aria-label="Play the tile with sound">Play</button>
<dialog id="full"><video controls playsinline preload="none"><source src="/clip.mp4" type="video/mp4" /></video></dialog>
</div>
<script type="module">
import { initDemoVideo, initVideoDialogs } from '/demo-video.mjs'
window.__start = () => {
  document.body.dataset.autoplay = initDemoVideo() ? '1' : '0'
  initVideoDialogs()
}
</script>`)
            return
        }
        res.statusCode = 404
        res.end()
    })
    const port = await listen(server)
    const { browser, send, evalValue, close } = await openDebugChrome(port, { width: 390, height: 800 })
    const read = `(() => {
        const hero = document.querySelector('[data-demo-video]')
        const dialog = document.getElementById('full')
        const full = dialog.querySelector('video')
        const sounding = [...document.querySelectorAll('video')].filter((video) => video.paused === false && video.muted === false).map((video) => video === full ? 'dialog' : 'other')
        return {
            width: window.innerWidth,
            narrow: matchMedia('(max-width: 50rem)').matches,
            autoplay: document.body.dataset.autoplay || '',
            hero: { paused: hero.paused, muted: hero.muted, t: hero.currentTime },
            open: dialog.open,
            full: { paused: full.paused, muted: full.muted, t: full.currentTime },
            sounding
        }
    })()`
    try {
        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: false })
        await evalValue(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
        const readyDeadline = Date.now() + 8000
        let ready = false
        while (Date.now() < readyDeadline) {
            ready = await evalValue(`typeof window.__start === 'function'`)
            if (ready) break
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
        assert.equal(ready, true)
        await evalValue('window.__start()')
        const started = await evalValue(read)
        assert.ok(Math.abs(started.width - 390) <= 2, `laid out at ${started.width}`)
        assert.equal(started.narrow, true)
        assert.equal(started.autoplay, '0')
        await evalValue(`document.querySelector('[data-demo-video]').nextElementSibling.click()`)
        const heroPlaying = await (async () => {
            const deadline = Date.now() + 8000
            let last = null
            while (Date.now() < deadline) {
                last = await evalValue(read)
                if (last.hero.paused === false && last.hero.muted === false && last.hero.t > 0.15) return last
                await new Promise((resolve) => setTimeout(resolve, 50))
            }
            assert.fail(`hero did not start: ${JSON.stringify(last)}`)
        })()
        assert.equal(heroPlaying.hero.paused, false)
        await evalValue(`document.querySelector('[data-video-dialog-open]').click()`)
        const dialog = await (async () => {
            const deadline = Date.now() + 8000
            let last = null
            while (Date.now() < deadline) {
                last = await evalValue(read)
                if (last.open === true && last.full.paused === false && last.full.muted === false && last.hero.paused === true) return last
                await new Promise((resolve) => setTimeout(resolve, 50))
            }
            assert.fail(`dialog did not take over: ${JSON.stringify(last)}`)
        })()
        assert.equal(dialog.hero.paused, true)
        assert.deepEqual(dialog.sounding, ['dialog'])
        close()
    } finally {
        browser.kill('SIGKILL')
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
    }
})
