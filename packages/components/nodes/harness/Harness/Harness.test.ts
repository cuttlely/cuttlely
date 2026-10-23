const mockHarnessRuns: { current: Record<string, unknown> | null } = { current: null }
const listedHarnesses: Array<{ name: string; description?: string; workspaceId?: string }> = []
const assertHarnessWorkspace = jest.fn()
const openHarnessRunTrace = jest.fn()
const queuedRun = jest.fn(async (_opts?: { onRecorded?: (row: unknown) => void; chatId?: string }) => mockHarnessRuns.current)

jest.mock('../engine', () => ({
    loadHarnessEngine: async () => ({
        listHarnesses: () => listedHarnesses,
        runHarness: async () => mockHarnessRuns.current,
        runQueuedHarness: (opts: { onRecorded?: (row: unknown) => void; chatId?: string }) => queuedRun(opts),
        assertHarnessWorkspace: (...args: unknown[]) => assertHarnessWorkspace(...args)
    })
}))

jest.mock('../../../src/otelRunSpans', () => {
    const actual = jest.requireActual('../../../src/otelRunSpans')
    return {
        ...actual,
        openHarnessRunTrace: (...args: unknown[]) => openHarnessRunTrace(...args)
    }
})

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

const {
    nodeClass: HarnessNode,
    harnessOnEvent,
    storeHarnessImages,
    harnessToolOutput,
    streamStoredImages,
    uploadedImages
} = require('./Harness')
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

describe('Harness node team list', () => {
    it('lists only the active workspace', async () => {
        listedHarnesses.splice(
            0,
            listedHarnesses.length,
            { name: 'own', workspaceId: 'ws-1' },
            { name: 'other', workspaceId: 'ws-2' },
            { name: 'legacy' }
        )
        const node = new HarnessNode()
        const options = await node.loadMethods.listHarnesses({}, { workspaceId: 'ws-1' })
        expect(options.map((option: { name: string }) => option.name)).toEqual(['own'])
        expect(await node.loadMethods.listHarnesses({}, {})).toEqual([])
        listedHarnesses.splice(0, listedHarnesses.length)
    })
})

describe('Harness node workspace refusal', () => {
    const nodeData = { inputs: { harnessName: 'other' } }

    beforeEach(() => {
        assertHarnessWorkspace.mockReset()
        openHarnessRunTrace.mockReset()
        delete process.env.CUTTLELY_OTEL_TRACES
    })

    afterEach(() => {
        assertHarnessWorkspace.mockReset()
        delete process.env.CUTTLELY_OTEL_TRACES
    })

    it('does not open a run trace when the harness is in another team', async () => {
        assertHarnessWorkspace.mockImplementation(() => {
            const error = new Error('Harness "other" belongs to another workspace.') as Error & { code?: string }
            error.code = 'wrong_workspace'
            throw error
        })
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const node = new HarnessNode()
        await expect(
            node.run(nodeData as never, 'How many loaves?', { chatId: 'c1', workspaceId: '22222222-2222-4222-8222-222222222222' })
        ).rejects.toThrow(/another workspace/)
        expect(openHarnessRunTrace).not.toHaveBeenCalled()
    })

    it('hands the caller identity, with the flow key and its harness list, to the access check', async () => {
        assertHarnessWorkspace.mockImplementation(() => {
            const error = new Error('This API key may not run harness "other".') as Error & { code?: string }
            error.code = 'key_not_allowed'
            throw error
        })
        const node = new HarnessNode()
        await expect(
            node.run(nodeData as never, 'How many loaves?', {
                chatId: 'c1',
                workspaceId: 'ws-1',
                harnessCaller: { via: 'api_key', apiKeyId: 'key-1', harnesses: ['bakery'] }
            })
        ).rejects.toMatchObject({ code: 'key_not_allowed' })
        expect(assertHarnessWorkspace).toHaveBeenCalledWith(
            'other',
            expect.objectContaining({ harnessCaller: { via: 'api_key', apiKeyId: 'key-1', harnesses: ['bakery'] } })
        )
    })

    it('refuses a harness name that is a list or an object before any check or run, on a keyless flow too', async () => {
        const node = new HarnessNode()
        for (const harnessName of [['payroll'], { name: 'payroll' }, 7]) {
            const data = { id: 'harness_0', inputs: { harnessName } }
            await expect(
                node.run(data as never, 'Pay everyone', { chatId: 'c1', workspaceId: 'ws-1', harnessCaller: { via: 'flow' } })
            ).rejects.toThrow(/not text/)
            await expect(
                node.init(data as never, '', { chatId: 'c1', workspaceId: 'ws-1', harnessCaller: { via: 'flow' } })
            ).rejects.toThrow(/not text/)
        }
        expect(assertHarnessWorkspace).not.toHaveBeenCalled()
    })
})

describe('Harness node queued run id', () => {
    const WORKSPACE = '11111111-1111-4111-8111-111111111111'
    const nodeData = { inputs: { harnessName: 'bakery' } }
    const externalId = 'run_cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const inlineId = 'run_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    let exporter: { getFinishedSpans: () => Array<{ name: string; attributes: Record<string, unknown> }>; reset: () => void }

    beforeAll(() => {
        const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base')
        const { setCuttlelyTracer } = jest.requireActual('../../../src/otelRunSpans')
        exporter = new InMemorySpanExporter()
        const provider = new BasicTracerProvider()
        provider.addSpanProcessor(new SimpleSpanProcessor(exporter))
        setCuttlelyTracer(() => provider.getTracer('cuttlely'))
    })

    beforeEach(() => {
        exporter.reset()
        queuedRun.mockReset()
        mockHarnessRuns.current = { text: 'Two loaves.' }
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        openHarnessRunTrace.mockImplementation((info: unknown) => jest.requireActual('../../../src/otelRunSpans').openHarnessRunTrace(info))
    })

    afterEach(() => {
        delete process.env.CUTTLELY_OTEL_TRACES
        delete process.env.CUTTLELY_HARNESS_QUEUE
        openHarnessRunTrace.mockReset()
        queuedRun.mockReset()
        queuedRun.mockImplementation(async () => mockHarnessRuns.current)
    })

    function rootAttributes(): Record<string, unknown> | undefined {
        return exporter.getFinishedSpans().find((span) => span.name === 'harness.run')?.attributes
    }

    it('an external queue run puts the saved history id on harness.run', async () => {
        process.env.CUTTLELY_HARNESS_QUEUE = 'external'
        queuedRun.mockImplementation(async () => ({ text: 'Two loaves.', runId: externalId }))
        const node = new HarnessNode()
        const payload = await node.run(nodeData as never, 'How many loaves?', { chatId: 'c1', workspaceId: WORKSPACE })
        expect(rootAttributes()?.['run.id']).toBe(externalId)
        expect(payload).not.toHaveProperty('runId')
    })

    it('an inline queue run keeps the id recorded in this process', async () => {
        process.env.CUTTLELY_HARNESS_QUEUE = 'inline'
        queuedRun.mockImplementation(async (opts) => {
            opts?.onRecorded?.({ id: inlineId })
            return { text: 'Two loaves.', runId: externalId }
        })
        const node = new HarnessNode()
        await node.run(nodeData as never, 'How many loaves?', { chatId: 'c1', workspaceId: WORKSPACE })
        expect(rootAttributes()?.['run.id']).toBe(inlineId)
    })

    it('an external queue failure still puts the saved history id on harness.run', async () => {
        process.env.CUTTLELY_HARNESS_QUEUE = 'external'
        queuedRun.mockImplementation(async () => {
            throw Object.assign(new Error('oven failed'), { runId: externalId })
        })
        const node = new HarnessNode()
        await expect(node.run(nodeData as never, 'How many loaves?', { chatId: 'c1', workspaceId: WORKSPACE })).rejects.toThrow(
            /oven failed/
        )
        expect(rootAttributes()?.['run.id']).toBe(externalId)
        expect(rootAttributes()?.status).toBe('error')
    })

    it('an inline queue failure keeps the id recorded in this process', async () => {
        process.env.CUTTLELY_HARNESS_QUEUE = 'inline'
        queuedRun.mockImplementation(async (opts) => {
            opts?.onRecorded?.({ id: inlineId })
            throw new Error('oven failed')
        })
        const node = new HarnessNode()
        await expect(node.run(nodeData as never, 'How many loaves?', { chatId: 'c1', workspaceId: WORKSPACE })).rejects.toThrow(
            /oven failed/
        )
        expect(rootAttributes()?.['run.id']).toBe(inlineId)
        expect(rootAttributes()?.status).toBe('error')
    })
})

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

    it('stores PDF, DOCX, XLSX and CSV files with their name for the download', async () => {
        const files = [
            {
                type: 'pdf',
                mime: 'application/pdf',
                name: 'reports/q1 report.pdf',
                specialist: 'assets',
                base64: Buffer.from('%PDF-1.7').toString('base64')
            },
            {
                type: 'docx',
                mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                name: 'memo.docx',
                specialist: 'assets',
                base64: Buffer.from('PK').toString('base64')
            },
            {
                type: 'xlsx',
                mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                name: 'table.xlsx',
                specialist: 'assets',
                base64: Buffer.from('PK').toString('base64')
            },
            { type: 'csv', mime: 'text/csv', name: 'orders.csv', specialist: 'assets', base64: Buffer.from('a,b\n').toString('base64') }
        ]
        const stored = await storeHarnessImages(files, { orgId: 'org-1', chatflowid: 'flow-1', chatId: 'chat-1' })
        expect(stored.map((item: { type: string; name?: string }) => [item.type, item.name])).toEqual([
            ['pdf', 'q1_report.pdf'],
            ['docx', 'memo.docx'],
            ['xlsx', 'table.xlsx'],
            ['csv', 'orders.csv']
        ])
        expect(stored[0].data).toMatch(/^FILE-STORAGE::harness_assets_\d+_0_q1_report\.pdf$/)
        expect(addSingleFileToStorage.mock.calls.map((call: unknown[]) => call[0])).toEqual([
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'text/csv'
        ])
    })

    it('takes large PPTX and PNG downloads from the specialist folder through fresh chat and reloaded storage', async () => {
        const os = require('os')
        const fs = require('fs')
        const path = require('path')
        const { execFileSync } = require('child_process')
        // A stored (uncompressed) ZIP with the parts a presentation needs, written by a made-up specialist.
        const zipOf = (names: string[]) => {
            const locals: Buffer[] = []
            const centrals: Buffer[] = []
            let offset = 0
            for (const name of names) {
                const nameBytes = Buffer.from(name, 'utf8')
                const local = Buffer.alloc(30)
                local.writeUInt32LE(0x04034b50, 0)
                local.writeUInt16LE(nameBytes.length, 26)
                const central = Buffer.alloc(46)
                central.writeUInt32LE(0x02014b50, 0)
                central.writeUInt16LE(nameBytes.length, 28)
                central.writeUInt32LE(offset, 42)
                locals.push(local, nameBytes)
                centrals.push(central, nameBytes)
                offset += 30 + nameBytes.length
            }
            const directory = Buffer.concat(centrals)
            const end = Buffer.alloc(22)
            end.writeUInt32LE(0x06054b50, 0)
            end.writeUInt16LE(names.length, 8)
            end.writeUInt16LE(names.length, 10)
            end.writeUInt32LE(directory.length, 12)
            end.writeUInt32LE(offset, 16)
            return Buffer.concat([...locals, directory, end])
        }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pptx-'))
        try {
            // A real deck saved by python-pptx (made-up text), so the bytes are a presentation PowerPoint can open.
            const deck = fs.readFileSync(path.join(__dirname, '__fixtures__', 'q3-deck.pptx'))
            const { deflateSync, crc32 } = require('zlib')
            // A complete, deterministic RGB PNG with uncompressed DEFLATE blocks. The white
            // pixels force // into its base64, exercising the former path-like byte masking.
            const downloadRegressionPng = () => {
                const chunk = (name: string, data: Buffer) => {
                    const type = Buffer.from(name)
                    const header = Buffer.alloc(4)
                    header.writeUInt32BE(data.length)
                    const checksum = Buffer.alloc(4)
                    checksum.writeUInt32BE(crc32(Buffer.concat([type, data])))
                    return Buffer.concat([header, type, data, checksum])
                }
                const ihdr = Buffer.alloc(13)
                ihdr.writeUInt32BE(64, 0)
                ihdr.writeUInt32BE(64, 4)
                ihdr[8] = 8
                ihdr[9] = 2
                const pixels = Buffer.alloc(64 * (1 + 64 * 3), 255)
                for (let row = 0; row < 64; row++) pixels[row * 193] = 0
                return Buffer.concat([
                    Buffer.from('89504e470d0a1a0a', 'hex'),
                    chunk('IHDR', ihdr),
                    chunk('IDAT', deflateSync(pixels, { level: 0 })),
                    chunk('IEND', Buffer.alloc(0))
                ])
            }

            const png = downloadRegressionPng()
            expect(png.length).toBeGreaterThanOrEqual(4096)
            expect(png.toString('base64')).toContain('//')
            fs.writeFileSync(path.join(dir, 'chart.png'), png)
            fs.writeFileSync(path.join(dir, 'q3 deck.pptx'), deck)
            fs.writeFileSync(path.join(dir, 'renamed.pptx'), zipOf(['[Content_Types].xml', 'word/document.xml']))
            const images = path.resolve(__dirname, '../../../../harness/images.mjs')
            const script = `import { turnFiles, turnImages } from ${JSON.stringify(
                images
            )}; process.stdout.write(JSON.stringify([...turnFiles(${JSON.stringify(
                dir
            )}, 0, { specialist: 'assets' }), ...turnImages(${JSON.stringify(dir)}, 0, { specialist: 'assets' })]))`
            const files = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }))
            expect(files.map((file: { name: string; type: string }) => [file.name, file.type])).toEqual([
                ['q3 deck.pptx', 'pptx'],
                ['chart.png', 'png']
            ])
            expect(files[0].mime).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
            const stored = await storeHarnessImages(files, { orgId: 'org-1', chatflowid: 'flow-1', chatId: 'chat-1' })
            expect(stored).toHaveLength(2)
            expect(stored[0].type).toBe('pptx')
            expect(stored[0].name).toBe('q3_deck.pptx')
            expect(stored[0].data).toMatch(/^FILE-STORAGE::harness_assets_\d+_0_q3_deck\.pptx$/)
            const [mime, buffer] = addSingleFileToStorage.mock.calls[0]
            expect(mime).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
            expect(buffer.equals(deck)).toBe(true)
            // Fresh chat storage receives the complete bytes for both downloads.
            expect(Buffer.from(files[0].base64, 'base64').equals(deck)).toBe(true)
            expect(Buffer.from(files[1].base64, 'base64').equals(png)).toBe(true)
            expect(addSingleFileToStorage.mock.calls[1][1].equals(png)).toBe(true)
            // The same bytes go through the real local file storage: the stored name reads back as the deck.
            const realStorage = jest.requireActual('../../../src/storageUtils')
            const previous = { type: process.env.STORAGE_TYPE, path: process.env.BLOB_STORAGE_PATH }
            process.env.STORAGE_TYPE = 'local'
            process.env.BLOB_STORAGE_PATH = path.join(dir, 'storage')
            try {
                addSingleFileToStorage.mockImplementationOnce(realStorage.addSingleFileToStorage)
                addSingleFileToStorage.mockImplementationOnce(realStorage.addSingleFileToStorage)
                const [saved, savedPng] = await storeHarnessImages(files, { orgId: 'org-1', chatflowid: 'flow-1', chatId: 'chat-1' })
                // Model chat reload: only the serialized FILE-STORAGE reference is available.
                const reloadedPng = JSON.parse(JSON.stringify(savedPng))
                const downloadedPng = await realStorage.getFileFromStorage(
                    reloadedPng.data.replace('FILE-STORAGE::', ''),
                    'org-1',
                    'flow-1',
                    'chat-1'
                )
                expect(downloadedPng.equals(png)).toBe(true)
                const reloadedDeck = JSON.parse(JSON.stringify(saved))
                const fileName = reloadedDeck.data.replace('FILE-STORAGE::', '')
                const downloaded = await realStorage.getFileFromStorage(fileName, 'org-1', 'flow-1', 'chat-1')
                expect(downloaded.equals(deck)).toBe(true)
                // The downloaded file still unzips with the presentation part inside.
                const names = execFileSync(
                    process.execPath,
                    [
                        '--input-type=module',
                        '-e',
                        `import { zipEntryNames } from ${JSON.stringify(
                            images
                        )}; import fs from 'node:fs'; process.stdout.write(JSON.stringify(zipEntryNames(fs.readFileSync(0))))`
                    ],
                    { input: downloaded, encoding: 'utf8' }
                )
                expect(JSON.parse(names)).toContain('ppt/presentation.xml')
                expect(saved).toMatchObject({ type: 'pptx', name: 'q3_deck.pptx' })
            } finally {
                if (previous.type === undefined) delete process.env.STORAGE_TYPE
                else process.env.STORAGE_TYPE = previous.type
                if (previous.path === undefined) delete process.env.BLOB_STORAGE_PATH
                else process.env.BLOB_STORAGE_PATH = previous.path
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('skips a file whose MIME type does not match its type', async () => {
        const mismatch = { type: 'pdf', mime: 'text/html', name: 'page.pdf', base64: 'PGgxPg==' }
        expect(await storeHarnessImages([mismatch], { chatflowid: 'flow-1', chatId: 'chat-1' })).toEqual([])
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

describe('Harness token recording', () => {
    const payload = {
        text: 'Loaf is ready.',
        harness: 'bakery',
        agents: [],
        sources: [],
        artifacts: [],
        timings: { routeMs: 1, specialistsMs: 2, handoffMs: 1 },
        report: {
            tokens: { prompt: 4, completion: 3 },
            timings: { routeMs: 1, specialistsMs: 2, handoffMs: 1, profileMs: 0 },
            truncated: []
        },
        trace: {
            route: { model: 'gpt-4.1-mini', tokens: { input_tokens: 4, output_tokens: 2 } },
            specialists: [],
            handoff: { status: 'skipped', tokens: null }
        }
    }

    beforeEach(() => {
        mockHarnessRuns.current = payload
    })

    it('records the tool payload on the chatflow, because the returned text has no token counts', async () => {
        const recorded: Array<Record<string, unknown>> = []
        const node = new HarnessNode()
        const tool = await node.init({ inputs: { harnessName: 'bakery', returnDirect: true } }, '', {
            workspaceId: 'ws-1',
            chatflowid: 'flow-1',
            chatId: 'chat-1',
            appDataSource: { id: 'db' },
            recordTokenUsage: (_dataSource: unknown, input: Record<string, unknown>) => {
                recorded.push(input)
            }
        })
        const answer = typeof tool.func === 'function' ? await tool.func('bake') : await tool.invoke('bake')
        expect(answer).toBe('Loaf is ready.')
        expect(recorded).toEqual([
            {
                workspaceId: 'ws-1',
                flowId: 'flow-1',
                result: payload
            }
        ])
    })

    it('does not record Harness.run, so the ending node is the only writer for that shape', async () => {
        const recorded: unknown[] = []
        const node = new HarnessNode()
        const result = await node.run({ id: 'harness_0', inputs: { harnessName: 'bakery' } }, 'bake', {
            workspaceId: 'ws-1',
            chatflowid: 'flow-1',
            chatId: 'chat-1',
            appDataSource: { id: 'db' },
            recordTokenUsage: () => recorded.push('run')
        })
        expect(recorded).toEqual([])
        expect(result.text).toBe('Loaf is ready.')
        expect(result.harness).toBe('bakery')
        expect(result.harnessPayload).toEqual(payload)
    })
})
