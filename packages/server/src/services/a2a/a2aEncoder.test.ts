import { a2aSseData, makeA2aEncoder, silentA2aEncoder } from './a2aEncoder'

describe('makeA2aEncoder', () => {
    it('turns token frames into artifact updates and keeps heartbeats as comments', () => {
        const encoder = makeA2aEncoder({ rpcId: 1, taskId: 't', contextId: 'c', artifactId: 'a' })
        expect(encoder({ kind: 'comment', text: 'heartbeat' })).toBe(':heartbeat\n\n')
        const first = encoder({ kind: 'event', payload: { event: 'token', data: 'He' } }) as string
        const second = encoder({ kind: 'event', payload: { event: 'token', data: 'llo' } }) as string
        expect(first).toContain('"append":false')
        expect(second).toContain('"append":true')
        expect(first).toContain('"lastChunk":false')
        expect(JSON.parse(first.slice(6).trim()).result.artifact.parts[0].text).toBe('He')
        expect(encoder({ kind: 'event', payload: { event: 'start', data: 'x' } })).toBeNull()
        expect(encoder({ kind: 'event', payload: { event: 'error', data: 'secret' } })).toBeNull()
        expect(encoder({ kind: 'event', payload: { event: 'metadata', data: { sessionToken: 'tok' } } })).toBeNull()
        expect(encoder({ kind: 'final', payload: { event: 'end' } })).toBeNull()
        expect(silentA2aEncoder({ kind: 'event', payload: { event: 'token', data: 'x' } })).toBeNull()
        expect(a2aSseData({ a: 1 })).toBe('data: {"a":1}\n\n')
    })
})
