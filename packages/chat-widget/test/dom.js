// A jsdom window installed as globals, plus a fake Cuttlely server for the widget tests.
import { JSDOM } from 'jsdom'

export function installDom(url = 'https://shop.example/') {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url, pretendToBeVisual: true })
    const { window } = dom
    const keys = [
        'window',
        'document',
        'HTMLElement',
        'customElements',
        'localStorage',
        'navigator',
        'location',
        'FileReader',
        'Node',
        'getComputedStyle'
    ]
    const saved = {}
    for (const key of keys) {
        saved[key] = Object.getOwnPropertyDescriptor(globalThis, key)
        Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
    }
    globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
    return {
        window,
        restore() {
            for (const key of keys) {
                if (saved[key]) Object.defineProperty(globalThis, key, saved[key])
                else delete globalThis[key]
            }
            delete globalThis.requestAnimationFrame
            window.close()
        }
    }
}

const frame = (obj) => 'message:\ndata:' + JSON.stringify(obj) + '\n\n'

export function sseResponse(events) {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
        start(controller) {
            for (const evt of events) controller.enqueue(encoder.encode(frame(evt)))
            controller.close()
        }
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

export const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** routes: { config, predict(body, call), feedback(body) } each returning a Response. Records every request. */
export function fakeServer(routes) {
    const calls = []
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url)
        let body = init.body
        if (typeof body === 'string') body = JSON.parse(body)
        calls.push({ path: u.pathname, search: u.search, method: init.method || 'GET', body, headers: init.headers || {} })
        if (u.pathname.startsWith('/api/v1/public-chatbotConfig/')) return routes.config ? routes.config() : json(200, {})
        if (u.pathname.startsWith('/api/v1/prediction/'))
            return routes.predict(body, calls.filter((c) => c.path.startsWith('/api/v1/prediction/')).length)
        if (u.pathname.startsWith('/api/v1/feedback')) return routes.feedback ? routes.feedback(body) : json(200, {})
        if (u.pathname === '/api/v1/get-upload-file') return routes.file ? routes.file(u, init) : json(404, { message: 'not found' })
        return json(404, { message: 'not found' })
    }
    return { calls, fetchImpl }
}

export const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

export async function until(check, timeout = 2000) {
    const start = Date.now()
    while (Date.now() - start < timeout) {
        if (check()) return
        await tick(5)
    }
    throw new Error('timed out waiting for the widget')
}
