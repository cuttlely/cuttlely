jest.mock('../../../src/storageUtils', () => ({
    addSingleFileToStorage: jest.fn(async (_mime: string, _buffer: Buffer, fileName: string) => ({
        path: `FILE-STORAGE::${fileName}`,
        totalSize: 4
    })),
    getFileFromStorage: jest.fn(async (name: string) => {
        if (name === 'missing.png') throw new Error('not found')
        if (name === 'big.png') return Buffer.alloc(5 * 1024 * 1024 + 1)
        return Buffer.from(`bytes of ${name}`)
    })
}))

const { harnessOnEvent, storeHarnessImages, harnessToolOutput, streamStoredImages, uploadedImages } = require('./Harness')
const { addSingleFileToStorage, getFileFromStorage } = require('../../../src/storageUtils')

type Sent = { kind: string; name?: string; data: unknown }

function fakeStreamer() {
    const sent: Sent[] = []
    return {
        sent,
        streamCustomEvent: (_chatId: string, name: string, data: unknown) => sent.push({ kind: 'custom', name, data }),
        streamStartEvent: (_chatId: string, data: unknown) => sent.push({ kind: 'start', data }),
        streamTokenEvent: (_chatId: string, data: unknown) => sent.push({ kind: 'token', data }),
        streamSourceDocumentsEvent: (_chatId: string, data: unknown) => sent.push({ kind: 'sources', data })
    }
}

describe('Harness node stream events', () => {
    it('marks an answer partial that also goes out as a token', () => {
        const sse = fakeStreamer()
        const streamed = { answer: false }
        const onEvent = harnessOnEvent({ sseStreamer: sse, chatId: 'c1' }, true, undefined, streamed)
        onEvent({ type: 'partial', phase: 'answer', text: 'researcher ' })
        onEvent({ type: 'partial', phase: 'answer', text: 'reads' })
        expect(sse.sent).toEqual([
            {
                kind: 'custom',
                name: 'harness.partial',
                data: { type: 'partial', phase: 'answer', text: 'researcher ', streamedAsToken: true }
            },
            { kind: 'start', data: 'researcher ' },
            { kind: 'token', data: 'researcher ' },
            { kind: 'custom', name: 'harness.partial', data: { type: 'partial', phase: 'answer', text: 'reads', streamedAsToken: true } },
            { kind: 'token', data: 'reads' }
        ])
        expect(streamed.answer).toBe(true)
    })

    it('leaves other events unmarked and sends no token for them', () => {
        const sse = fakeStreamer()
        const onEvent = harnessOnEvent({ sseStreamer: sse, chatId: 'c1' }, true)
        const route = { type: 'partial', phase: 'route', text: '{"steps":[]}' }
        onEvent(route)
        onEvent({ type: 'specialist', phase: 'start' })
        expect(sse.sent).toEqual([
            { kind: 'custom', name: 'harness.partial', data: route },
            { kind: 'custom', name: 'harness.specialist', data: { type: 'specialist', phase: 'start' } }
        ])
    })

    it('does not mark answer partials when the answer is not streamed as tokens', () => {
        const sse = fakeStreamer()
        const onEvent = harnessOnEvent({ sseStreamer: sse, chatId: 'c1' }, false)
        const partial = { type: 'partial', phase: 'answer', text: 'Hi' }
        onEvent(partial)
        expect(sse.sent).toEqual([{ kind: 'custom', name: 'harness.partial', data: partial }])
    })
})

describe('Harness node specialist images', () => {
    const png = {
        type: 'png',
        mime: 'image/png',
        name: 'charts/cake sales.png',
        specialist: 'analyst',
        base64: Buffer.from('demo').toString('base64')
    }

    beforeEach(() => addSingleFileToStorage.mockClear())

    it('stores an image a specialist wrote in the chat file storage and returns an image artifact', async () => {
        const stored = await storeHarnessImages([png], { chatflowid: 'flow-1', chatId: 'chat-1', orgId: 'org-1' })
        expect(stored).toHaveLength(1)
        expect(stored[0].type).toBe('png')
        expect(stored[0].data).toMatch(/^FILE-STORAGE::harness_analyst_\d+_0_cake_sales\.png$/)
        const [mime, buffer, , orgId, chatflowId, chatId] = addSingleFileToStorage.mock.calls[0]
        expect([mime, buffer.toString(), orgId, chatflowId, chatId]).toEqual(['image/png', 'demo', 'org-1', 'flow-1', 'chat-1'])
    })

    it('stores nothing on a publish check replay or without a chat, and keeps ready artifacts', async () => {
        const ready = { type: 'png', data: 'FILE-STORAGE::earlier.png' }
        expect(await storeHarnessImages([png, ready], { chatflowid: 'flow-1', chatId: 'chat-1', replay: true })).toEqual([ready])
        expect(await storeHarnessImages([png], {})).toEqual([])
        expect(await storeHarnessImages(undefined, { chatflowid: 'flow-1', chatId: 'chat-1' })).toEqual([])
        expect(addSingleFileToStorage).not.toHaveBeenCalled()
    })

    it('stores nothing during a publish check of a chatflow', async () => {
        expect(await storeHarnessImages([png], { chatflowid: 'flow-1', chatId: 'check-1', cuttlelyReplay: true })).toEqual([])
        expect(addSingleFileToStorage).not.toHaveBeenCalled()
    })

    it('skips a type the chat cannot show', async () => {
        const gif = { ...png, type: 'gif', mime: 'image/gif', name: 'a.gif' }
        expect(await storeHarnessImages([gif], { chatflowid: 'flow-1', chatId: 'chat-1' })).toEqual([])
    })

    it('as an agent tool, returns the stored images after the artifacts marker the agent reads', async () => {
        const { ARTIFACTS_PREFIX } = require('../../../src/agents')
        const output = await harnessToolOutput({ text: 'Chart drawn.', artifacts: [png] }, { chatflowid: 'flow-1', chatId: 'chat-1' })
        const [text, json] = output.split(ARTIFACTS_PREFIX)
        expect(text).toBe('Chart drawn.')
        expect(JSON.parse(json)).toEqual([
            { type: 'png', data: expect.stringMatching(/^FILE-STORAGE::harness_analyst_\d+_0_cake_sales\.png$/) }
        ])
        expect(await harnessToolOutput({ text: 'No chart.' }, { chatflowid: 'flow-1', chatId: 'chat-1' })).toBe('No chart.')
    })

    it('sends the stored images to a live chat, and nothing when there are none', () => {
        const sent: unknown[] = []
        const sseStreamer = { streamArtifactsEvent: (chatId: string, data: unknown) => sent.push([chatId, data]) }
        const images = [{ type: 'png', data: 'FILE-STORAGE::harness_analyst_1_0_chart.png' }]
        streamStoredImages({ sseStreamer, chatId: 'chat-1' }, images)
        streamStoredImages({ sseStreamer, chatId: 'chat-1' }, [])
        streamStoredImages({ chatId: 'chat-1' }, images)
        expect(sent).toEqual([['chat-1', images]])
    })
})

describe('uploadedImages', () => {
    const options = { orgId: 'org-1', chatflowid: 'flow-1', chatId: 'chat-1' }

    beforeEach(() => getFileFromStorage.mockClear())

    it('reads attached images from the chat storage and keeps image links', async () => {
        const images = await uploadedImages({
            ...options,
            uploads: [
                { type: 'stored-file', name: 'receipt.png', mime: 'image/png' },
                { type: 'url', name: 'chart.jpg', mime: 'image/jpeg', data: 'https://example.com/chart.jpg' }
            ]
        })
        expect(images).toEqual([
            `data:image/png;base64,${Buffer.from('bytes of receipt.png').toString('base64')}`,
            'https://example.com/chart.jpg'
        ])
        expect(getFileFromStorage).toHaveBeenCalledWith('receipt.png', 'org-1', 'flow-1', 'chat-1')
    })

    it('skips other files, missing or oversized images, and stops at four', async () => {
        const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined)
        const many = Array.from({ length: 6 }, (_, index) => ({ type: 'stored-file', name: `p${index}.png`, mime: 'image/png' }))
        expect(
            await uploadedImages({
                ...options,
                uploads: [
                    { type: 'stored-file:full', name: 'notes.pdf', mime: 'application/pdf' },
                    { type: 'stored-file', name: 'missing.png', mime: 'image/png' },
                    { type: 'stored-file', name: 'big.png', mime: 'image/png' },
                    { type: 'url', name: 'x.png', mime: 'image/png', data: 'file:///etc/hosts' }
                ]
            })
        ).toEqual([])
        expect(await uploadedImages({ ...options, uploads: many })).toHaveLength(4)
        expect(await uploadedImages(options)).toEqual([])
        expect(quiet).toHaveBeenCalledTimes(1)
        quiet.mockRestore()
    })
})
