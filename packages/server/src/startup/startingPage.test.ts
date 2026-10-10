import http from 'http'
import { readyBanner, setBootStep, startingPageHtml, startStartingPage } from './startingPage'

const get = (port: number, path: string) =>
    new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path }, (res) => {
            let body = ''
            res.on('data', (chunk) => (body += chunk))
            res.on('end', () => resolve({ status: res.statusCode || 0, type: String(res.headers['content-type']), body }))
        }).on('error', reject)
    })

describe('starting page', () => {
    it('shows the boot step to a browser and keeps ping not ready, then frees the port', async () => {
        const page = await startStartingPage(0, '127.0.0.1')
        expect(page).not.toBeNull()
        const port = page!.port()
        setBootStep('Loading the building blocks')
        const html = await get(port, '/organization-setup')
        expect(html.status).toBe(503)
        expect(html.type).toContain('text/html')
        expect(html.body).toContain('Cuttlely is starting')
        expect(html.body).toContain('Loading the building blocks')
        expect(html.body).toContain('http-equiv="refresh"')
        const ping = await get(port, '/api/v1/ping')
        expect(ping.status).toBe(503)
        expect(ping.body).not.toContain('pong')
        expect(JSON.parse(ping.body)).toEqual({ status: 'starting', step: 'Loading the building blocks' })
        await page!.close()
        const again = http.createServer()
        await new Promise<void>((resolve, reject) => again.once('error', reject).listen(port, '127.0.0.1', () => resolve()))
        await new Promise<void>((resolve) => again.close(() => resolve()))
    })

    it('steps aside when the port is taken', async () => {
        const taken = http.createServer()
        await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', () => resolve()))
        const port = (taken.address() as { port: number }).port
        expect(await startStartingPage(port, '127.0.0.1')).toBeNull()
        await new Promise<void>((resolve) => taken.close(() => resolve()))
    })

    it('escapes the step text and prints a ready line with a URL people can open', () => {
        expect(startingPageHtml('<b>x</b>')).toContain('&lt;b&gt;x&lt;/b&gt;')
        expect(readyBanner(43117, '0.0.0.0')[1]).toBe('✅ Cuttlely is ready. Open http://localhost:43117')
        expect(readyBanner(43117)[1]).toContain('http://localhost:43117')
        expect(readyBanner(8080, 'cuttlely.internal')[1]).toContain('http://cuttlely.internal:8080')
    })
})
