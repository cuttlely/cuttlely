// While the server boots, its port answers with a small "Cuttlely is starting" page instead of refusing the
// connection, so a browser opened early shows progress rather than an error. The page reloads itself every two
// seconds. /api paths answer 503 JSON, so ping (and the Compose health check) stay "not ready" until boot is done.
import http from 'http'
import type { AddressInfo } from 'net'

let bootStep = 'Starting'

export function setBootStep(step: string): void {
    bootStep = step
}

export function currentBootStep(): string {
    return bootStep
}

const escapeHtml = (text: string) =>
    text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c))

export function startingPageHtml(step: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="2">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cuttlely is starting</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f7f7fb;color:#1f2330}
main{text-align:center;max-width:460px;padding:24px}
.spin{width:36px;height:36px;margin:0 auto 20px;border:4px solid #dcdcf0;border-top-color:#5b5bd6;border-radius:50%;animation:s 0.9s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
h1{font-size:22px;margin:0 0 8px}
p{margin:6px 0;color:#545a6e;line-height:1.45}
.step{font-weight:600;color:#1f2330}
</style>
</head>
<body>
<main>
<div class="spin" aria-hidden="true"></div>
<h1>Cuttlely is starting</h1>
<p class="step" role="status">${escapeHtml(step)}…</p>
<p>This page opens Cuttlely by itself when it is ready, usually within a minute.</p>
</main>
</body>
</html>
`
}

export interface StartingPage {
    close(): Promise<void>
    port(): number
}

export function handleStartingRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const step = currentBootStep()
    res.setHeader('Retry-After', '2')
    res.setHeader('Cache-Control', 'no-store')
    if ((req.url || '').startsWith('/api')) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'starting', step }))
        return
    }
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(startingPageHtml(step))
}

// Resolves null when the port cannot be taken (then boot goes on without the page, as before).
export function startStartingPage(port: number, host?: string): Promise<StartingPage | null> {
    if (process.env.CUTTLELY_STARTING_PAGE === 'off') return Promise.resolve(null)
    return new Promise((resolve) => {
        const server = http.createServer(handleStartingRequest)
        server.once('error', () => resolve(null))
        server.listen(port, host, () =>
            resolve({
                port: () => (server.address() as AddressInfo).port,
                close: () =>
                    new Promise<void>((done) => {
                        server.close(() => done())
                        server.closeAllConnections()
                    })
            })
        )
    })
}

// The line printed once the server is ready, with the address to open.
export function readyBanner(port: number, host?: string): string[] {
    const shown = !host || host === '0.0.0.0' || host === '::' ? 'localhost' : host
    const url = `http://${shown}:${port}`
    const line = '─'.repeat(url.length + 26)
    return [line, `✅ Cuttlely is ready. Open ${url}`, line]
}
