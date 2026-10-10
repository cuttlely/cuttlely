import { acceptChatSubmit, harnessRunPath } from './harnessCanvasChat'

describe('harness canvas chat', () => {
    it('posts the canvas chat to the harness runs API', () => {
        expect(harnessRunPath('chief-of-staff')).toBe('/api/v1/harnesses/chief-of-staff/runs')
        expect(harnessRunPath('a b')).toBe('/api/v1/harnesses/a%20b/runs')
    })

    it('accepts one Enter and ignores a second while a send is in flight', () => {
        expect(acceptChatSubmit({ key: 'Enter', text: 'VACUUM INTO x' })).toBe(true)
        expect(acceptChatSubmit({ key: 'Enter', text: 'VACUUM INTO x', busy: true })).toBe(false)
        expect(acceptChatSubmit({ key: 'Enter', text: 'VACUUM INTO x', shiftKey: true })).toBe(false)
        expect(acceptChatSubmit({ key: 'Enter', text: '   ' })).toBe(false)
        expect(acceptChatSubmit({ key: 'a', text: 'VACUUM INTO x' })).toBe(false)
    })
})
