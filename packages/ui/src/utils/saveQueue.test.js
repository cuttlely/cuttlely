import {
    CREATE_NOT_CONFIRMED_NOTICE,
    containsBase64Canvas,
    createSaveQueue,
    draftSaveLanded,
    sameLiveCanvas,
    sameSavedCanvas,
    SAVE_CLOCK_SKEW_MS
} from './saveQueue'

const FLOW_A = JSON.stringify({ nodes: [{ id: 'a', data: { name: 'card' } }], edges: [] })
const FLOW_B = JSON.stringify({ nodes: [{ id: 'b', data: { name: 'card' } }], edges: [] })
const FLOW_C = JSON.stringify({ nodes: [{ id: 'c', data: { name: 'card' } }], edges: [] })
const NOW = Date.parse('2026-11-10T12:00:00.000Z')

const noResponse = () => ({ request: {}, response: undefined })
const httpError = (status) => ({ response: { status } })
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const deferred = () => {
    let resolve
    let reject
    const promise = new Promise((done, fail) => {
        resolve = done
        reject = fail
    })
    return { promise, resolve, reject }
}

const status = (hash, flowData = FLOW_A, extra = {}) => ({
    draft: hash === null ? null : { hash, flowData, updatedBy: 'me', updatedDate: new Date(NOW).toISOString(), ...extra }
})

const entry = (overrides = {}) => ({
    kind: 'draft',
    id: 'flow-1',
    rev: 1,
    flowData: FLOW_A,
    liveFlowData: FLOW_C,
    expectedDraftHash: 'base',
    baseDraftUpdatedDate: new Date(NOW - 60_000).toISOString(),
    userId: 'me',
    sentAt: NOW,
    firstAttemptSentAt: NOW,
    lastAttemptSettledAt: NOW,
    onAck: jest.fn(),
    onConflict: jest.fn(),
    onError: jest.fn(),
    ...overrides
})

const makeQueue = (overrides = {}) => {
    const calls = {
        putDraft: jest.fn().mockResolvedValue({ data: status('saved') }),
        getDraftStatus: jest.fn().mockResolvedValue({ data: status('base') }),
        putLive: jest.fn(),
        getLive: jest.fn(),
        sleep: jest.fn().mockResolvedValue(),
        beginReconnect: jest.fn(),
        endReconnect: jest.fn(),
        onExhausted: jest.fn(),
        onCreateStatusWaiting: jest.fn(),
        onResolved: jest.fn(),
        onBusyChange: jest.fn(),
        now: () => NOW,
        random: () => 0.5,
        ...overrides
    }
    return { queue: createSaveQueue(calls), calls }
}

describe('save queue core', () => {
    test('keeps one write in flight and sends only the latest pending snapshot', async () => {
        const first = deferred()
        const { queue, calls } = makeQueue({
            putDraft: jest
                .fn()
                .mockReturnValueOnce(first.promise)
                .mockResolvedValue({ data: status('h2') })
        })
        queue.enqueue(entry({ flowData: FLOW_A }))
        queue.enqueue(entry({ rev: 2, flowData: FLOW_B }))
        queue.enqueue(entry({ rev: 3, flowData: FLOW_C }))
        expect(calls.putDraft).toHaveBeenCalledTimes(1)
        first.resolve({ data: status('h1', FLOW_A) })
        await flush()
        expect(calls.putDraft).toHaveBeenCalledTimes(2)
        expect(calls.putDraft.mock.calls[1][1]).toBe(FLOW_C)
        expect(calls.putDraft.mock.calls[1][2].expectedDraftHash).toBe('h1')
    })

    test('leaves revision matching to the acknowledgement callback', async () => {
        let editRev = 2
        let dirty = true
        const save = entry({ rev: 1, onAck: jest.fn(() => (dirty = save.rev === editRev ? false : dirty)) })
        const { queue } = makeQueue()
        queue.enqueue(save)
        await flush()
        expect(dirty).toBe(true)
        editRev = 1
        queue.enqueue(save)
        await flush()
        expect(dirty).toBe(false)
    })

    test('stops on a draft conflict and opens review', async () => {
        const conflict = { response: { status: 409, data: { code: 'DRAFT_CHANGED', savedBy: { id: 'other' } } } }
        const save = entry()
        const { queue, calls } = makeQueue({ putDraft: jest.fn().mockRejectedValue(conflict) })
        queue.enqueue(save)
        await flush()
        expect(calls.putDraft).toHaveBeenCalledTimes(1)
        expect(save.onConflict).toHaveBeenCalledTimes(1)
        expect(calls.getDraftStatus).not.toHaveBeenCalled()
    })

    test('retries a no-response draft burst three times with the same payload and base', async () => {
        const save = entry()
        const putDraft = jest.fn().mockRejectedValue(noResponse())
        const { queue, calls } = makeQueue({ putDraft })
        queue.enqueue(save)
        await flush()
        expect(putDraft).toHaveBeenCalledTimes(4)
        expect(new Set(putDraft.mock.calls.map((call) => call[1]))).toEqual(new Set([FLOW_A]))
        expect(new Set(putDraft.mock.calls.map((call) => call[2].expectedDraftHash))).toEqual(new Set(['base']))
        expect(calls.sleep).toHaveBeenCalledTimes(3)
        expect(calls.sleep.mock.calls.map(([delay]) => delay)).toEqual([300, 1000, 3000])
        expect(calls.getDraftStatus).toHaveBeenCalledTimes(4)
        expect(calls.onExhausted).toHaveBeenCalledTimes(1)
    })

    test.each([500, 502, 503, 504])('does not retry HTTP %s', async (code) => {
        const save = entry()
        const { queue, calls } = makeQueue({ putDraft: jest.fn().mockRejectedValue(httpError(code)) })
        queue.enqueue(save)
        await flush()
        expect(calls.putDraft).toHaveBeenCalledTimes(1)
        expect(calls.getDraftStatus).not.toHaveBeenCalled()
        expect(save.onError).toHaveBeenCalledTimes(1)
    })

    test('reconciles a lost response as landed without another write', async () => {
        const save = entry()
        const stored = status('stored', FLOW_A)
        const { queue, calls } = makeQueue({
            putDraft: jest.fn().mockRejectedValue(noResponse()),
            getDraftStatus: jest.fn().mockResolvedValue({ data: stored })
        })
        queue.enqueue(save)
        await flush()
        expect(calls.putDraft).toHaveBeenCalledTimes(1)
        expect(save.onAck).toHaveBeenCalledWith(stored, expect.objectContaining({ reconciled: true }))
        expect(calls.onExhausted).not.toHaveBeenCalled()
    })

    test('rejects recent content from another tab and opens review through the replay guard', async () => {
        const save = entry()
        const other = status('other', FLOW_B)
        const { queue } = makeQueue({
            putDraft: jest.fn().mockRejectedValue(noResponse()),
            getDraftStatus: jest.fn().mockResolvedValue({ data: other })
        })
        queue.enqueue(save)
        await flush()
        expect(save.onAck).not.toHaveBeenCalled()
        expect(save.onConflict).toHaveBeenCalledTimes(1)
    })

    test('never accepts a missing draft as proof that the save landed', () => {
        expect(draftSaveLanded({ draft: null }, entry({ flowData: FLOW_C, liveFlowData: FLOW_C }))).toBe(false)
        expect(draftSaveLanded({ draft: null }, entry({ flowData: FLOW_A, liveFlowData: FLOW_C }))).toBe(false)
    })

    test('replays from a missing draft only when both the stored and sent bases are empty', async () => {
        const save = entry({ expectedDraftHash: null, flowData: FLOW_C, liveFlowData: FLOW_C })
        const cleared = status(null)
        const { queue, calls } = makeQueue({
            putDraft: jest.fn().mockRejectedValueOnce(noResponse()).mockResolvedValueOnce({ data: cleared }),
            getDraftStatus: jest.fn().mockResolvedValue({ data: cleared })
        })
        queue.enqueue(save)
        await flush()
        expect(calls.putDraft).toHaveBeenCalledTimes(2)
        expect(save.onAck).toHaveBeenCalledWith(cleared, expect.objectContaining({ reconciled: false }))
        expect(save.onConflict).not.toHaveBeenCalled()
        expect(calls.onExhausted).not.toHaveBeenCalled()
    })

    test('requires the clock allowance even when the stored draft is newer than the base', async () => {
        const near = status('stored', FLOW_A, { updatedDate: new Date(NOW - SAVE_CLOCK_SKEW_MS + 1).toISOString() })
        const tooOld = status('stored', FLOW_A, { updatedDate: new Date(NOW - SAVE_CLOCK_SKEW_MS - 1).toISOString() })
        const save = entry({ baseDraftUpdatedDate: new Date(NOW - SAVE_CLOCK_SKEW_MS - 2).toISOString() })
        expect(draftSaveLanded(near, entry(), NOW)).toBe(true)
        expect(draftSaveLanded(tooOld, save, NOW)).toBe(false)

        const { queue, calls } = makeQueue({
            putDraft: jest.fn().mockRejectedValue(noResponse()),
            getDraftStatus: jest.fn().mockResolvedValue({ data: tooOld })
        })
        queue.enqueue(save)
        await flush()
        expect(calls.putDraft).toHaveBeenCalledTimes(1)
        expect(save.onAck).not.toHaveBeenCalled()
        expect(save.onConflict).toHaveBeenCalledTimes(1)
    })

    test('rejects a matching file draft saved after the attempt window', async () => {
        const fileFlow = JSON.stringify({
            nodes: [{ id: 'a', data: { inputs: { file: 'data:text/plain;base64,QQ==,filename:a.txt' } } }],
            edges: []
        })
        const later = status('later', fileFlow, { updatedDate: new Date(NOW + SAVE_CLOCK_SKEW_MS + 1).toISOString() })
        const save = entry({ flowData: fileFlow, hasBase64: true })
        const { queue, calls } = makeQueue({
            putDraft: jest.fn().mockRejectedValue(noResponse()),
            getDraftStatus: jest.fn().mockResolvedValue({ data: later })
        })

        queue.enqueue(save)
        await flush()
        expect(calls.putDraft).toHaveBeenCalledTimes(1)
        expect(save.onAck).not.toHaveBeenCalled()
        expect(save.onConflict).toHaveBeenCalledTimes(1)
    })

    test('ignores only stored node-pack metadata during canvas comparison', () => {
        const stamped = JSON.stringify({ nodes: [{ id: 'a', data: { name: 'card', nodePack: 'pack' } }], edges: [] })
        expect(sameSavedCanvas(FLOW_A, stamped)).toBe(true)
        expect(sameSavedCanvas(FLOW_B, stamped)).toBe(false)
        const nested = JSON.stringify({ nodes: [{ id: 'a', data: { name: 'card', inputs: { nodePack: 'person-value' } } }], edges: [] })
        expect(sameSavedCanvas(FLOW_A, nested)).toBe(false)
    })

    test('reconciles a file canvas before every replay and accepts rewritten upload paths', async () => {
        const fileFlow = JSON.stringify({
            nodes: [{ id: 'a', data: { category: 'Document Loaders', inputs: { file: 'data:text/plain;base64,QQ==,filename:a.txt' } } }],
            edges: []
        })
        const storedFlow = JSON.stringify({
            nodes: [{ id: 'a', data: { category: 'Document Loaders', inputs: { file: 'flow-1/draft-x-a.txt' } } }],
            edges: []
        })
        const save = entry({ flowData: fileFlow })
        const stored = status('stored', storedFlow)
        const { queue, calls } = makeQueue({
            putDraft: jest.fn().mockRejectedValue(noResponse()),
            getDraftStatus: jest.fn().mockResolvedValue({ data: stored })
        })
        expect(containsBase64Canvas(fileFlow)).toBe(true)
        queue.enqueue(save)
        await flush()
        expect(calls.putDraft).toHaveBeenCalledTimes(1)
        expect(calls.getDraftStatus).toHaveBeenCalledTimes(1)
        expect(save.onAck).toHaveBeenCalledWith(stored, expect.objectContaining({ reconciled: true, hasBase64: true }))
    })

    test('finds file data in every node input', () => {
        const nested = JSON.stringify({
            nodes: [{ id: 'a', data: { category: 'Chat Models', inputs: { options: { file: 'data:text/plain;base64,QQ==' } } } }],
            edges: []
        })
        expect(containsBase64Canvas(nested)).toBe(true)
        expect(containsBase64Canvas(FLOW_A)).toBe(false)
    })

    test('waits after a file reconciliation read gets no response', async () => {
        const fileFlow = JSON.stringify({
            nodes: [{ id: 'a', data: { inputs: { file: 'data:text/plain;base64,QQ==,filename:a.txt' } } }],
            edges: []
        })
        const { queue, calls } = makeQueue({
            putDraft: jest.fn().mockRejectedValue(noResponse()),
            getDraftStatus: jest.fn().mockRejectedValue(noResponse())
        })
        queue.enqueue(entry({ flowData: fileFlow }))
        await flush()
        expect(calls.putDraft).toHaveBeenCalledTimes(1)
        expect(queue.getState().state).toBe('waiting')
    })

    test('continues a canvas retry burst when reconciliation reads get no response', async () => {
        const save = entry()
        const { queue, calls } = makeQueue({
            putDraft: jest.fn().mockRejectedValue(noResponse()),
            getDraftStatus: jest.fn().mockRejectedValue(noResponse())
        })
        queue.enqueue(save)
        await flush()
        expect(calls.putDraft).toHaveBeenCalledTimes(4)
        expect(calls.getDraftStatus).toHaveBeenCalledTimes(4)
        expect(queue.getState().state).toBe('waiting')
    })

    test('keeps an ambiguous draft waiting after a reconciliation HTTP error', async () => {
        const save = entry()
        const { queue, calls } = makeQueue({
            putDraft: jest.fn().mockRejectedValue(noResponse()),
            getDraftStatus: jest.fn().mockRejectedValue(httpError(500))
        })
        queue.enqueue(save)
        await flush()
        expect(calls.putDraft).toHaveBeenCalledTimes(1)
        expect(save.onError).not.toHaveBeenCalled()
        expect(calls.onExhausted).toHaveBeenCalledTimes(1)
        expect(queue.getState().state).toBe('waiting')
    })

    test('resumes only while the draft base is unchanged', async () => {
        const save = entry()
        const { queue, calls } = makeQueue({ putDraft: jest.fn().mockRejectedValue(noResponse()) })
        queue.enqueue(save)
        await flush()
        calls.putDraft.mockResolvedValueOnce({ data: status('saved') })
        queue.retry()
        await flush()
        expect(calls.getDraftStatus).toHaveBeenCalledTimes(5)
        expect(calls.putDraft).toHaveBeenCalledTimes(5)
    })

    test('a replay guard with no response stays waiting', async () => {
        const { queue, calls } = makeQueue({ putDraft: jest.fn().mockRejectedValue(noResponse()) })
        queue.enqueue(entry())
        await flush()
        calls.getDraftStatus.mockRejectedValueOnce(noResponse())
        queue.retry()
        await flush()
        expect(queue.getState().state).toBe('waiting')
        expect(calls.putDraft).toHaveBeenCalledTimes(4)
        expect(calls.onExhausted).toHaveBeenCalledTimes(2)
    })

    test('a changed draft base on resume opens review without another write', async () => {
        const save = entry()
        const getDraftStatus = jest.fn().mockResolvedValue({ data: status('base') })
        const { queue, calls } = makeQueue({ putDraft: jest.fn().mockRejectedValue(noResponse()), getDraftStatus })
        queue.enqueue(save)
        await flush()
        getDraftStatus.mockResolvedValueOnce({ data: status('other', FLOW_B, { updatedBy: 'other' }) })
        queue.retry()
        await flush()
        expect(calls.putDraft).toHaveBeenCalledTimes(4)
        expect(save.onConflict).toHaveBeenCalledTimes(1)
    })

    test('reconciles a Live write and retries once only when its base is unchanged', async () => {
        const liveEntry = {
            kind: 'live',
            id: 'flow-1',
            body: { name: 'Name', flowData: FLOW_A },
            baseUpdatedDate: 'base-date',
            onAck: jest.fn(),
            onChanged: jest.fn(),
            onError: jest.fn()
        }
        const putLive = jest
            .fn()
            .mockRejectedValueOnce(noResponse())
            .mockResolvedValueOnce({ data: { ...liveEntry.body, updatedDate: 'saved' } })
        const { queue, calls } = makeQueue({
            putLive,
            getLive: jest.fn().mockResolvedValue({ data: { name: 'Old', flowData: FLOW_B, updatedDate: 'base-date' } })
        })
        queue.enqueue(liveEntry)
        await flush()
        expect(putLive).toHaveBeenCalledTimes(2)
        expect(calls.getLive).toHaveBeenCalledTimes(1)
        expect(liveEntry.onAck).toHaveBeenCalledTimes(1)
    })

    test('acks equal Live content and reports changed content without a blind replay', async () => {
        const equal = entry({ kind: 'live', body: { name: 'Name', flowData: FLOW_A }, baseUpdatedDate: 'base', onChanged: jest.fn() })
        const first = makeQueue({
            putLive: jest.fn().mockRejectedValue(noResponse()),
            getLive: jest.fn().mockResolvedValue({ data: { ...equal.body, updatedDate: 'base' } })
        })
        first.queue.enqueue(equal)
        await flush()
        expect(first.calls.putLive).toHaveBeenCalledTimes(1)
        expect(equal.onAck).toHaveBeenCalledTimes(1)

        const changed = entry({ kind: 'live', body: { name: 'Name', flowData: FLOW_A }, baseUpdatedDate: 'base', onChanged: jest.fn() })
        const second = makeQueue({
            putLive: jest.fn().mockRejectedValue(noResponse()),
            getLive: jest.fn().mockResolvedValue({ data: { name: 'Other', flowData: FLOW_B, updatedDate: 'new' } })
        })
        second.queue.enqueue(changed)
        await flush()
        expect(second.calls.putLive).toHaveBeenCalledTimes(1)
        expect(changed.onChanged).toHaveBeenCalledTimes(1)
    })

    test('matches a Live file write after storage replaces its body', async () => {
        const sent = JSON.stringify({
            nodes: [{ id: 'a', data: { inputs: { file: 'data:text/plain;base64,QQ==,filename:a.txt' } } }],
            edges: []
        })
        const stored = JSON.stringify({
            nodes: [{ id: 'a', data: { inputs: { file: 'FILE-STORAGE::["a.txt"]' } } }],
            edges: []
        })
        expect(sameLiveCanvas(sent, stored)).toBe(true)
        const liveEntry = {
            kind: 'live',
            id: 'flow-1',
            body: { name: 'Name', flowData: sent },
            baseUpdatedDate: 'base',
            onAck: jest.fn(),
            onChanged: jest.fn(),
            onError: jest.fn()
        }
        const { queue, calls } = makeQueue({
            putLive: jest.fn().mockRejectedValue(noResponse()),
            getLive: jest.fn().mockResolvedValue({ data: { name: 'Name', flowData: stored, updatedDate: 'saved' } })
        })
        queue.enqueue(liveEntry)
        await flush()
        expect(calls.putLive).toHaveBeenCalledTimes(1)
        expect(liveEntry.onAck).toHaveBeenCalledTimes(1)
        expect(liveEntry.onChanged).not.toHaveBeenCalled()
    })

    test('retries a nested file write when only its name matches at the base time', async () => {
        const sent = JSON.stringify({
            nodes: [{ id: 'a', data: { inputs: { options: { file: 'data:text/plain;base64,QkJC,filename:notes.txt' } } } }],
            edges: []
        })
        const stored = JSON.stringify({
            nodes: [{ id: 'a', data: { inputs: { options: { file: 'FILE-STORAGE::["notes.txt"]' } } } }],
            edges: []
        })
        const liveEntry = {
            kind: 'live',
            id: 'flow-1',
            body: { name: 'Name', flowData: sent },
            baseUpdatedDate: 'base',
            onAck: jest.fn(),
            onChanged: jest.fn(),
            onError: jest.fn()
        }
        const putLive = jest
            .fn()
            .mockRejectedValueOnce(noResponse())
            .mockResolvedValueOnce({ data: { ...liveEntry.body, updatedDate: 'saved' } })
        const { queue } = makeQueue({
            putLive,
            getLive: jest.fn().mockResolvedValue({ data: { name: 'Name', flowData: stored, updatedDate: 'base' } })
        })

        expect(sameLiveCanvas(sent, stored)).toBe(true)
        queue.enqueue(liveEntry)
        await flush()
        expect(putLive).toHaveBeenCalledTimes(2)
        expect(liveEntry.onAck).toHaveBeenCalledTimes(1)
        expect(liveEntry.onChanged).not.toHaveBeenCalled()
    })

    test('advances a pending Live base before its write starts', async () => {
        const firstWrite = deferred()
        const beforeWrite = jest.fn().mockResolvedValue(true)
        const latest = {
            kind: 'live',
            id: 'flow-1',
            body: { name: 'Name', flowData: FLOW_B },
            baseUpdatedDate: 'base',
            beforeWrite,
            onAck: jest.fn(),
            onChanged: jest.fn(),
            onError: jest.fn()
        }
        const putLive = jest
            .fn()
            .mockReturnValueOnce(firstWrite.promise)
            .mockRejectedValueOnce(noResponse())
            .mockResolvedValueOnce({ data: { ...latest.body, updatedDate: 'latest' } })
        const { queue } = makeQueue({
            putLive,
            getLive: jest.fn().mockResolvedValue({ data: { name: 'Name', flowData: FLOW_A, updatedDate: 'first' } })
        })
        queue.enqueue({
            ...latest,
            body: { name: 'Name', flowData: FLOW_A },
            beforeWrite: undefined,
            onAck: jest.fn(),
            onChanged: jest.fn(),
            onError: jest.fn()
        })
        queue.enqueue(latest)
        firstWrite.resolve({ data: { name: 'Name', flowData: FLOW_A, updatedDate: 'first' } })
        await flush()
        await flush()

        expect(beforeWrite).toHaveBeenCalledWith('first')
        expect(putLive).toHaveBeenCalledTimes(3)
        expect(latest.onChanged).not.toHaveBeenCalled()
        expect(latest.onAck).toHaveBeenCalledTimes(1)
    })

    test('serializes a name update before a full Live save', async () => {
        const nameRequest = deferred()
        const beforeWrite = jest.fn().mockResolvedValue(true)
        const liveEntry = {
            kind: 'live',
            id: 'flow-1',
            body: { name: 'Current name', flowData: FLOW_B },
            baseUpdatedDate: 'base',
            beforeWrite,
            onAck: jest.fn(),
            onChanged: jest.fn(),
            onError: jest.fn()
        }
        const { queue, calls } = makeQueue({
            putLive: jest.fn().mockResolvedValue({ data: { ...liveEntry.body, updatedDate: 'canvas-time' } })
        })
        queue.enqueue({
            kind: 'nonReplay',
            internal: true,
            send: jest.fn().mockReturnValue(nameRequest.promise),
            onAck: jest.fn(),
            onError: jest.fn()
        })
        queue.enqueue(liveEntry)
        expect(calls.putLive).not.toHaveBeenCalled()

        nameRequest.resolve({ data: { name: 'Current name', flowData: FLOW_A, updatedDate: 'name-time' } })
        await flush()
        await flush()

        expect(beforeWrite).toHaveBeenCalledWith('name-time')
        expect(calls.putLive).toHaveBeenCalledWith('flow-1', liveEntry.body)
        expect(liveEntry.onAck).toHaveBeenCalledTimes(1)
    })

    test('keeps an unresolved Live write waiting and reconciles before resume', async () => {
        const liveEntry = {
            kind: 'live',
            id: 'flow-1',
            body: { name: 'Name', flowData: FLOW_A },
            baseUpdatedDate: 'base',
            onAck: jest.fn(),
            onChanged: jest.fn(),
            onError: jest.fn()
        }
        const putLive = jest.fn().mockRejectedValue(noResponse())
        const getLive = jest.fn().mockResolvedValue({ data: { name: 'Old', flowData: FLOW_B, updatedDate: 'base' } })
        const { queue } = makeQueue({ putLive, getLive })
        queue.enqueue(liveEntry)
        await flush()
        expect(putLive).toHaveBeenCalledTimes(2)
        expect(queue.getState().state).toBe('waiting')

        const order = []
        getLive.mockImplementationOnce(async () => {
            order.push('get')
            return { data: { name: 'Old', flowData: FLOW_B, updatedDate: 'base' } }
        })
        putLive.mockImplementationOnce(async () => {
            order.push('put')
            return { data: { ...liveEntry.body, updatedDate: 'saved' } }
        })
        queue.retry()
        await flush()
        expect(order).toEqual(['get', 'put'])
        expect(liveEntry.onAck).toHaveBeenCalledTimes(1)
    })

    test('allows one Live write after each guarded read', async () => {
        const liveEntry = {
            kind: 'live',
            id: 'flow-1',
            body: { name: 'Name', flowData: FLOW_A },
            baseUpdatedDate: 'base',
            onAck: jest.fn(),
            onChanged: jest.fn(),
            onError: jest.fn()
        }
        const { queue, calls } = makeQueue({
            putLive: jest.fn().mockRejectedValue(noResponse()),
            getLive: jest.fn().mockResolvedValue({ data: { name: 'Old', flowData: FLOW_B, updatedDate: 'base' } })
        })
        queue.enqueue(liveEntry)
        await flush()
        expect(calls.putLive).toHaveBeenCalledTimes(2)
        queue.retry()
        await flush()
        expect(calls.putLive).toHaveBeenCalledTimes(3)
        expect(queue.getState().state).toBe('waiting')
    })

    test('keeps a Live snapshot waiting when its preflight gets no response', async () => {
        const liveEntry = {
            kind: 'live',
            id: 'flow-1',
            body: { name: 'Name', flowData: FLOW_A },
            baseUpdatedDate: 'base',
            beforeWrite: jest.fn().mockRejectedValue(noResponse()),
            onAck: jest.fn(),
            onChanged: jest.fn(),
            onError: jest.fn()
        }
        const { queue, calls } = makeQueue()
        queue.enqueue(liveEntry)
        await flush()
        expect(calls.putLive).not.toHaveBeenCalled()
        expect(calls.onExhausted).toHaveBeenCalledTimes(1)
        expect(queue.getState().state).toBe('waiting')
    })

    test('blocks every later create after an unanswered create without showing the retry notice', async () => {
        const create = { kind: 'create', send: jest.fn().mockRejectedValue(noResponse()), onAck: jest.fn(), onError: jest.fn() }
        const { queue, calls } = makeQueue()
        queue.enqueue(create)
        await flush()
        queue.retry()
        await flush()
        expect(create.send).toHaveBeenCalledTimes(1)
        expect(calls.onExhausted).not.toHaveBeenCalled()
        expect(create.onError).toHaveBeenCalledWith(
            expect.objectContaining({ message: CREATE_NOT_CONFIRMED_NOTICE, createNotConfirmed: true })
        )
        expect(queue.getState().state).toBe('idle')
        expect(queue.getState().createBlocked).toBe(true)
    })

    test('drops a queued creation after an unanswered creation request', async () => {
        const request = deferred()
        const firstSend = jest.fn().mockReturnValue(request.promise)
        const queuedSend = jest.fn().mockResolvedValue({ data: { id: 'created-2' } })
        const first = { kind: 'create', send: firstSend, onAck: jest.fn(), onError: jest.fn() }
        const queued = { kind: 'create', send: queuedSend, onAck: jest.fn(), onError: jest.fn() }
        const { queue, calls } = makeQueue()

        queue.enqueue(first)
        queue.enqueue(queued)
        request.reject(noResponse())
        await flush()
        expect(firstSend).toHaveBeenCalledTimes(1)
        expect(queuedSend).not.toHaveBeenCalled()
        expect(queue.getState().state).toBe('idle')
        expect(calls.onExhausted).not.toHaveBeenCalled()

        queue.enqueue(queued)
        await flush()
        expect(queuedSend).not.toHaveBeenCalled()
        expect(queued.onError).toHaveBeenCalledWith(
            expect.objectContaining({ message: CREATE_NOT_CONFIRMED_NOTICE, createNotConfirmed: true })
        )
    })

    test('retries a created flow status before leaving a Retry action', async () => {
        const unknown = new Error('mode pending')
        unknown.saveModeUnknown = true
        const afterCreate = jest.fn().mockRejectedValue(unknown)
        const create = {
            kind: 'create',
            send: jest.fn().mockResolvedValue({ data: { id: 'created-1', flowData: FLOW_A } }),
            afterCreate,
            onAck: jest.fn(),
            onError: jest.fn()
        }
        const { queue, calls } = makeQueue()

        queue.enqueue(create)
        await flush()
        expect(create.send).toHaveBeenCalledTimes(1)
        expect(create.onAck).not.toHaveBeenCalled()
        expect(queue.getState().state).toBe('waiting')
        expect(calls.onExhausted).not.toHaveBeenCalled()
        expect(calls.onCreateStatusWaiting).toHaveBeenCalledTimes(1)
        expect(calls.sleep.mock.calls.map(([delay]) => delay)).toEqual([300, 1000, 3000])
        expect(afterCreate).toHaveBeenCalledTimes(4)
        expect(calls.onBusyChange).toHaveBeenLastCalledWith(false)

        afterCreate.mockResolvedValue(null)
        queue.retry()
        await flush()
        expect(create.send).toHaveBeenCalledTimes(1)
        expect(afterCreate).toHaveBeenCalledTimes(5)
        expect(create.onAck).toHaveBeenCalledTimes(1)
        expect(queue.getState().state).toBe('idle')
    })

    test('uses one create and saves the latest queued snapshot to its returned id', async () => {
        const firstRequest = deferred()
        let editRev = 2
        let dirty = true
        const firstCreate = {
            kind: 'create',
            rev: 1,
            send: jest.fn().mockReturnValue(firstRequest.promise),
            onAck: jest.fn((_created, details) => {
                if (!details.willContinue && editRev === 1) dirty = false
            }),
            onError: jest.fn()
        }
        const secondCreate = {
            kind: 'create',
            rev: 2,
            flowData: FLOW_B,
            send: jest.fn(),
            onError: jest.fn(),
            afterCreate: jest.fn((created) =>
                entry({
                    id: created.id,
                    rev: 2,
                    flowData: FLOW_B,
                    onAck: jest.fn(() => {
                        if (editRev === 2) dirty = false
                    })
                })
            )
        }
        const { queue, calls } = makeQueue({ putDraft: jest.fn().mockResolvedValue({ data: status('saved', FLOW_B) }) })
        queue.enqueue(firstCreate)
        queue.enqueue(secondCreate)
        firstRequest.resolve({ data: { id: 'created-1', name: 'Created', flowData: FLOW_A } })
        await flush()
        await flush()
        expect(firstCreate.send).toHaveBeenCalledTimes(1)
        expect(secondCreate.send).not.toHaveBeenCalled()
        expect(firstCreate.onAck).toHaveBeenCalledWith(expect.objectContaining({ id: 'created-1' }), { willContinue: true })
        expect(secondCreate.afterCreate).toHaveBeenCalledWith(expect.objectContaining({ id: 'created-1' }), { fromPending: true })
        expect(calls.putDraft).toHaveBeenCalledTimes(1)
        expect(calls.putDraft).toHaveBeenCalledWith('created-1', FLOW_B, expect.any(Object))
        expect(dirty).toBe(false)
    })

    test('keeps an internal continuation separate from the latest user snapshot', async () => {
        const firstRequest = deferred()
        const nameSend = jest.fn().mockResolvedValue({ data: { id: 'flow-1' } })
        const latest = entry({ rev: 2, flowData: FLOW_B })
        const { queue, calls } = makeQueue({
            putDraft: jest
                .fn()
                .mockReturnValueOnce(firstRequest.promise)
                .mockResolvedValueOnce({ data: status('latest', FLOW_B) })
        })
        const first = entry({
            onAck: jest.fn(() => {
                queue.enqueue({ kind: 'nonReplay', internal: true, send: nameSend, onAck: jest.fn(), onError: jest.fn() })
            })
        })
        queue.enqueue(first)
        queue.enqueue(latest)
        firstRequest.resolve({ data: status('first', FLOW_A) })
        await flush()
        await flush()
        expect(nameSend).toHaveBeenCalledTimes(1)
        expect(calls.putDraft).toHaveBeenCalledTimes(2)
        expect(calls.putDraft.mock.calls[1][1]).toBe(FLOW_B)
        expect(latest.onAck).toHaveBeenCalledTimes(1)
    })

    test('runs a confirmed Live write before a newer pending snapshot', async () => {
        const firstWrite = deferred()
        const order = []
        const latest = {
            kind: 'live',
            id: 'flow-1',
            body: { name: 'Latest', flowData: FLOW_C },
            baseUpdatedDate: 'changed',
            onAck: jest.fn(),
            onChanged: jest.fn(),
            onError: jest.fn()
        }
        let queue
        const old = {
            kind: 'live',
            id: 'flow-1',
            body: { name: 'Old', flowData: FLOW_A },
            baseUpdatedDate: 'base',
            onAck: jest.fn(),
            onError: jest.fn(),
            onChanged: jest.fn(() => {
                queue.enqueue({
                    ...old,
                    internal: true,
                    baseUpdatedDate: 'changed',
                    onChanged: jest.fn()
                })
            })
        }
        const made = makeQueue({
            putLive: jest
                .fn()
                .mockReturnValueOnce(firstWrite.promise)
                .mockImplementationOnce(async () => {
                    order.push('confirmed')
                    return { data: { ...old.body, updatedDate: 'confirmed' } }
                })
                .mockImplementationOnce(async () => {
                    order.push('latest')
                    return { data: { ...latest.body, updatedDate: 'latest' } }
                }),
            getLive: jest.fn().mockResolvedValue({ data: { name: 'Other', flowData: FLOW_B, updatedDate: 'changed' } })
        })
        queue = made.queue
        queue.enqueue(old)
        queue.enqueue(latest)
        firstWrite.reject(noResponse())
        await flush()
        await flush()
        expect(order).toEqual(['confirmed', 'latest'])
        expect(latest.onAck).toHaveBeenCalledTimes(1)
    })

    test('acknowledges an internal settings continuation before clearing its revision', async () => {
        const settingsRequest = deferred()
        let dirty = true
        const settingsSend = jest.fn().mockReturnValue(settingsRequest.promise)
        const { queue } = makeQueue()
        const first = entry({
            onAck: jest.fn(() => {
                queue.enqueue({
                    kind: 'nonReplay',
                    internal: true,
                    send: settingsSend,
                    onAck: jest.fn(() => {
                        dirty = false
                    }),
                    onError: jest.fn()
                })
            })
        })

        queue.enqueue(first)
        await flush()
        expect(settingsSend).toHaveBeenCalledTimes(1)
        expect(dirty).toBe(true)

        settingsRequest.resolve({ data: { id: 'flow-1' } })
        await flush()
        expect(dirty).toBe(false)
    })

    test('stops callbacks and further attempts after disposal', async () => {
        const pending = deferred()
        const save = entry()
        const { queue, calls } = makeQueue({ putDraft: jest.fn().mockReturnValue(pending.promise) })
        queue.enqueue(save)
        queue.dispose()
        pending.resolve({ data: status('saved') })
        await flush()
        expect(save.onAck).not.toHaveBeenCalled()
        expect(calls.onResolved).not.toHaveBeenCalled()
        expect(queue.getState().state).toBe('stopped')
    })
})
