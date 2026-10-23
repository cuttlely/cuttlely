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

describe('makeA2aEncoder artifacts', () => {
    const meta = { rpcId: 1, taskId: 't', contextId: 'c', artifactId: 'a' }
    const artifacts = { kind: 'event' as const, payload: { event: 'artifacts', data: [] } }
    const token = { kind: 'event' as const, payload: { event: 'token', data: 'Hi' } }
    const parse = (s: string | null) => JSON.parse(String(s).slice(6)).result

    it('sends links as an answer chunk and keeps append order with tokens', () => {
        const encoder = makeA2aEncoder(meta, () => '[Download r.pdf](https://x.example/r)')
        expect(parse(encoder(token as any)).append).toBe(false)
        const chunk = parse(encoder(artifacts as any))
        expect(chunk.append).toBe(true)
        expect(chunk.artifact.parts[0].text).toBe('\n\n[Download r.pdf](https://x.example/r)')
        expect(makeA2aEncoder(meta)(artifacts as any)).toBeNull()
    })
})

describe('makeA2aEncoder attachment filter', () => {
    it('removes attachment: links from streamed tokens and flushes held text', () => {
        const meta = { rpcId: 1, taskId: 't', contextId: 'c', artifactId: 'a' }
        const encoder = makeA2aEncoder(meta)
        const text = (s: string | null) => (s ? JSON.parse(s.slice(6)).result.artifact.parts[0].text : '')
        const out = ['Hi ', '![c](attach', 'ment:c.png)', ' bye ['].map((t) =>
            text(encoder({ kind: 'event', payload: { event: 'token', data: t } } as any))
        )
        expect(out.join('') + encoder.flush()).toBe('Hi  bye [')
    })
})
