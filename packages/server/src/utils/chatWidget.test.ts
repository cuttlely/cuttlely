import fs from 'fs'
import os from 'os'
import path from 'path'
import { readChatWidgetScript } from './chatWidget'

describe('chat widget script', () => {
    let dir: string

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-chat-'))
    })

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('returns null when the widget has not been built', () => {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }))
        expect(readChatWidgetScript(dir)).toBeNull()
        expect(readChatWidgetScript('')).toBeNull()
    })

    it('reads the built script with its version and a content etag', () => {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }))
        fs.mkdirSync(path.join(dir, 'dist'))
        fs.writeFileSync(path.join(dir, 'dist', 'chat.js'), 'window.x=1')
        const script = readChatWidgetScript(dir)
        expect(script?.version).toBe('1.2.3')
        expect(script?.body.toString()).toBe('window.x=1')
        expect(script?.etag).toMatch(/^"1\.2\.3-[A-Za-z0-9_-]{16}"$/)
        fs.writeFileSync(path.join(dir, 'dist', 'chat.js'), 'window.x=2')
        expect(readChatWidgetScript(dir)?.etag).not.toBe(script?.etag)
    })
})
