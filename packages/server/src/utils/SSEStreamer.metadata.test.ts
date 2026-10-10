import { SSEStreamer } from './SSEStreamer'

function client() {
    const writes: string[] = []
    return { writes, response: { write: (data: string) => writes.push(data), end: jest.fn() } }
}

const metadataOf = (writes: string[]) => JSON.parse(writes[writes.length - 1].replace('message:\ndata:', '').trim())

describe('SSEStreamer metadata session token', () => {
    it('adds the session token only when the caller asks for it', () => {
        const streamer = new SSEStreamer()
        const c = client()
        streamer.addExternalClient('chat-1', c.response as any)
        streamer.streamMetadataEvent('chat-1', { chatId: 'chat-1', chatMessageId: 'm1', sessionToken: 'tok' })
        expect(metadataOf(c.writes).data).toEqual({ chatId: 'chat-1', chatMessageId: 'm1' })
        streamer.streamMetadataEvent('chat-1', { chatId: 'chat-1', chatMessageId: 'm1', sessionToken: 'tok' }, { sessionToken: true })
        expect(metadataOf(c.writes)).toEqual({ event: 'metadata', data: { chatId: 'chat-1', sessionToken: 'tok', chatMessageId: 'm1' } })
    })

    it('skips a missing or empty token', () => {
        const streamer = new SSEStreamer()
        const c = client()
        streamer.addExternalClient('chat-2', c.response as any)
        streamer.streamMetadataEvent('chat-2', { chatId: 'chat-2', sessionToken: '' }, { sessionToken: true })
        expect(metadataOf(c.writes).data).toEqual({ chatId: 'chat-2' })
    })
})
