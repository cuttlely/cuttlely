import fs from 'fs'
import path from 'path'
import { acceptChatSubmit, harnessCanvasRunPath, harnessRunPath } from './harnessCanvasChat'

describe('harness canvas chat', () => {
    it('keeps the external runs route on the published harness', () => {
        expect(harnessRunPath('chief-of-staff')).toBe('/api/v1/harnesses/chief-of-staff/runs')
        expect(harnessRunPath('a b')).toBe('/api/v1/harnesses/a%20b/runs')
    })

    it('posts the canvas chat and Try it to the internal draft route', () => {
        expect(harnessCanvasRunPath('flow-1')).toBe('/api/v1/internal-prediction/flow-1')
        const chat = fs.readFileSync(path.join(__dirname, '../views/chatmessage/ChatMessage.jsx'), 'utf8')
        const home = fs.readFileSync(path.join(__dirname, '../views/harnesses/HarnessHome.jsx'), 'utf8')
        expect(chat).toContain('harnessCanvasRunPath(chatflowId)')
        expect(chat).toContain('fetchHarnessRun(chatflowid, input)')
        expect(home).toContain('harnessCanvasRunPath(harness.chatflowId)')
        expect(home).toContain('harnessRunPath(name)')
    })

    it('accepts one Enter and ignores a second while a send is in flight', () => {
        expect(acceptChatSubmit({ key: 'Enter', text: 'VACUUM INTO x' })).toBe(true)
        expect(acceptChatSubmit({ key: 'Enter', text: 'VACUUM INTO x', busy: true })).toBe(false)
        expect(acceptChatSubmit({ key: 'Enter', text: 'VACUUM INTO x', shiftKey: true })).toBe(false)
        expect(acceptChatSubmit({ key: 'Enter', text: '   ' })).toBe(false)
        expect(acceptChatSubmit({ key: 'a', text: 'VACUUM INTO x' })).toBe(false)
    })
})
