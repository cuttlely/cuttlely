import {
    A2A_ANSWER_TRUNCATE_MARK,
    A2A_TASK_CAP_PER_FLOW,
    A2A_TASK_TEXT_MAX_BYTES_DEFAULT,
    A2A_TASK_TEXT_MAX_BYTES_MIN,
    TaskQuestionTooLargeError,
    TaskStoreFullError,
    a2aCallerKey,
    a2aFlowStoredBytes,
    a2aPublicTask,
    a2aTaskStore,
    a2aTaskTextMaxBytes,
    insertA2aTaskForTests,
    isoNow,
    listA2aTasksForTests,
    measureA2aStoredTask,
    resetA2aTaskStore,
    truncateA2aStoredAnswer,
    utf8Bytes
} from './taskStore'

const restoreEnv = (name: string, previous: string | undefined) => {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
}

describe('a2a task store', () => {
    const previousText = process.env.A2A_TASK_TEXT_MAX_BYTES
    const previousBytes = process.env.A2A_TASK_BYTES_PER_FLOW
    const previousCap = process.env.A2A_TASK_CAP_PER_FLOW

    beforeEach(() => {
        resetA2aTaskStore()
        delete process.env.A2A_TASK_TEXT_MAX_BYTES
        delete process.env.A2A_TASK_BYTES_PER_FLOW
        delete process.env.A2A_TASK_CAP_PER_FLOW
    })

    afterAll(() => {
        restoreEnv('A2A_TASK_TEXT_MAX_BYTES', previousText)
        restoreEnv('A2A_TASK_BYTES_PER_FLOW', previousBytes)
        restoreEnv('A2A_TASK_CAP_PER_FLOW', previousCap)
    })

    it('isolates callers and keeps the first final state', () => {
        expect(a2aCallerKey({ id: 'f', apikeyid: 'k' })).toBe('key:k')
        expect(a2aCallerKey({ id: 'f', apikeyid: '' })).toBe('public:f')
        const a = a2aTaskStore.create({ flowId: 'f1', caller: 'key:a', chatId: 'c1', contextId: 'ctx', question: 'q' })
        const other = a2aTaskStore.get('f1', 'key:b', a.task.id)
        expect(other).toBeUndefined()
        a2aTaskStore.finalize(a, { state: 'completed', timestamp: isoNow() }, { answer: 'yes' })
        expect(a2aTaskStore.requestCancel('f1', 'key:a', a.task.id).ok).toBe(false)
        expect(a2aTaskStore.get('f1', 'key:a', a.task.id)?.task.status.state).toBe('completed')
    })

    it('evicts the oldest final task at the cap and refuses when all are open', () => {
        const first = a2aTaskStore.create({ flowId: 'f', caller: 'key:a', chatId: 'c', contextId: 'ctx', question: 'q', now: 1 })
        a2aTaskStore.finalize(first, { state: 'failed', timestamp: isoNow(1) }, undefined, 1)
        for (let i = 0; i < A2A_TASK_CAP_PER_FLOW - 1; i += 1) {
            a2aTaskStore.create({ flowId: 'f', caller: 'key:a', chatId: `c${i}`, contextId: 'ctx', question: 'q', now: i + 2 })
        }
        const next = a2aTaskStore.create({ flowId: 'f', caller: 'key:a', chatId: 'new', contextId: 'ctx', question: 'q', now: 10_000 })
        expect(a2aTaskStore.get('f', 'key:a', first.task.id)).toBeUndefined()
        expect(next.task.id).toBeTruthy()
        resetA2aTaskStore()
        for (let i = 0; i < A2A_TASK_CAP_PER_FLOW; i += 1) {
            a2aTaskStore.create({ flowId: 'f', caller: 'key:a', chatId: `c${i}`, contextId: 'ctx', question: 'q' })
        }
        expect(() => a2aTaskStore.create({ flowId: 'f', caller: 'key:a', chatId: 'x', contextId: 'ctx', question: 'q' })).toThrow(
            TaskStoreFullError
        )
    })

    it('expires rows after one hour and returns completed history oldest first', () => {
        const old = a2aTaskStore.create({ flowId: 'f', caller: 'key:a', chatId: 'c', contextId: 'ctx', question: 'old q', now: 1 })
        a2aTaskStore.finalize(old, { state: 'completed', timestamp: isoNow(1) }, { answer: 'old a' }, 1)
        expect(a2aTaskStore.get('f', 'key:a', old.task.id, 1 + 60 * 60 * 1000 + 1)).toBeUndefined()
        const a = a2aTaskStore.create({ flowId: 'f', caller: 'key:a', chatId: 'c', contextId: 'ctx', question: 'q1', now: 10 })
        const b = a2aTaskStore.create({ flowId: 'f', caller: 'key:a', chatId: 'c', contextId: 'ctx', question: 'q2', now: 20 })
        a2aTaskStore.finalize(a, { state: 'completed', timestamp: isoNow(11) }, { answer: 'a1' }, 11)
        a2aTaskStore.finalize(b, { state: 'completed', timestamp: isoNow(21) }, { answer: 'a2' }, 21)
        expect(a2aTaskStore.listCompletedHistory('f', 'key:a', 'ctx', 21)).toEqual([
            { question: 'q1', answer: 'a1' },
            { question: 'q2', answer: 'a2' }
        ])
    })

    it('stores a keyless test flow under public:flowId', () => {
        insertA2aTaskForTests({
            flowId: 'f',
            caller: 'public:f',
            chatId: 'c',
            contextId: 'ctx',
            question: 'q',
            artifactId: 'art',
            cancelRequested: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            task: { kind: 'task', id: 't1', contextId: 'ctx', status: { state: 'working', timestamp: isoNow() } }
        })
        expect(a2aTaskStore.get('f', 'public:f', 't1')?.task.id).toBe('t1')
    })

    it('rejects a stored question over the per-task byte cap', () => {
        process.env.A2A_TASK_TEXT_MAX_BYTES = '16'
        expect(() =>
            a2aTaskStore.create({ flowId: 'f', caller: 'key:a', chatId: 'c', contextId: 'ctx', question: '12345678901234567' })
        ).toThrow(TaskQuestionTooLargeError)
        try {
            a2aTaskStore.create({ flowId: 'f', caller: 'key:a', chatId: 'c', contextId: 'ctx', question: 'ééééééééé' })
            throw new Error('expected oversize é question to throw')
        } catch (error) {
            expect(error).toBeInstanceOf(TaskQuestionTooLargeError)
            expect((error as TaskQuestionTooLargeError).message).toBe('Question exceeds the 16-byte store limit')
        }
        expect(listA2aTasksForTests()).toHaveLength(0)
        const ok = a2aTaskStore.create({ flowId: 'f', caller: 'key:a', chatId: 'c', contextId: 'ctx', question: '1234567890123456' })
        expect(ok.question).toBe('1234567890123456')
        delete process.env.A2A_TASK_TEXT_MAX_BYTES
        expect(() =>
            a2aTaskStore.create({
                flowId: 'f2',
                caller: 'key:a',
                chatId: 'c',
                contextId: 'ctx',
                question: 'x'.repeat(A2A_TASK_TEXT_MAX_BYTES_DEFAULT + 1)
            })
        ).toThrow(TaskQuestionTooLargeError)
    })

    it('ignores a text cap shorter than the truncation marker and never stores a partial marker', () => {
        process.env.A2A_TASK_TEXT_MAX_BYTES = '8'
        expect(a2aTaskTextMaxBytes()).toBe(A2A_TASK_TEXT_MAX_BYTES_DEFAULT)
        const row = a2aTaskStore.create({ flowId: 'f', caller: 'key:a', chatId: 'c', contextId: 'ctx', question: '123456789' })
        expect(row.question).toBe('123456789')
        const link = '[Download deck.pdf](https://h.example/api/v1/get-upload-file?fileName=deck.pdf&signature=abc)'
        const withLink = truncateA2aStoredAnswer(`${'z'.repeat(400)}\n\n${link}`, 300)
        expect(withLink.endsWith(`[truncated]\n\n${link}`)).toBe(true)
        expect(Buffer.byteLength(withLink)).toBeLessThanOrEqual(300)
        const tiny = truncateA2aStoredAnswer(`${'z'.repeat(400)}\n\n${link}`, 100)
        expect(tiny).not.toContain('https://')
        const inline = truncateA2aStoredAnswer(`${'z'.repeat(60)} see ${link} more`, 120)
        expect(inline).not.toContain('[Download')
        expect(inline.endsWith('[truncated]')).toBe(true)
        expect(truncateA2aStoredAnswer('y'.repeat(40), 8)).toBe('')
        expect(truncateA2aStoredAnswer('y'.repeat(40), 8).includes('[trunc')).toBe(false)
        const marked = truncateA2aStoredAnswer('y'.repeat(40), A2A_TASK_TEXT_MAX_BYTES_MIN)
        expect(marked).toBe(A2A_ANSWER_TRUNCATE_MARK)
        expect(marked.endsWith('[truncated]')).toBe(true)
        expect(utf8Bytes(marked)).toBe(A2A_TASK_TEXT_MAX_BYTES_MIN)
    })

    it('truncates a stored answer over the per-task byte cap and marks the cut', () => {
        process.env.A2A_TASK_TEXT_MAX_BYTES = '24'
        const row = a2aTaskStore.create({ flowId: 'f', caller: 'key:a', chatId: 'c', contextId: 'ctx', question: 'q' })
        a2aTaskStore.finalize(row, { state: 'completed', timestamp: isoNow() }, { answer: 'y'.repeat(80) })
        expect(row.answer?.endsWith('[truncated]')).toBe(true)
        expect(row.answer?.includes(A2A_ANSWER_TRUNCATE_MARK.trim())).toBe(true)
        expect(utf8Bytes(row.answer)).toBeLessThanOrEqual(24)
        expect(row.answer?.length).toBeLessThan(80)
        const publicTask = a2aPublicTask(row)
        expect(publicTask.artifacts?.[0].parts[0].text).toBe(row.answer)
    })

    it('evicts the oldest completed task when a flow is over the byte budget and accounts bytes on insert, update, and evict', () => {
        process.env.A2A_TASK_BYTES_PER_FLOW = '20'
        const t0 = Date.now()
        const first = a2aTaskStore.create({
            flowId: 'f',
            caller: 'key:a',
            chatId: 'c1',
            contextId: 'ctx',
            question: 'q1',
            now: t0
        })
        expect(a2aFlowStoredBytes('f')).toBe(utf8Bytes('q1'))
        a2aTaskStore.finalize(first, { state: 'completed', timestamp: isoNow(t0 + 1) }, { answer: 'a1' }, t0 + 1)
        expect(a2aFlowStoredBytes('f')).toBe(measureA2aStoredTask(first))
        const second = a2aTaskStore.create({
            flowId: 'f',
            caller: 'key:a',
            chatId: 'c2',
            contextId: 'ctx',
            question: 'q2',
            now: t0 + 2
        })
        a2aTaskStore.finalize(second, { state: 'completed', timestamp: isoNow(t0 + 3) }, { answer: 'a2' }, t0 + 3)
        expect(a2aTaskStore.get('f', 'key:a', first.task.id)).toBeDefined()
        const third = a2aTaskStore.create({
            flowId: 'f',
            caller: 'key:a',
            chatId: 'c3',
            contextId: 'ctx',
            question: '1234567890123',
            now: t0 + 4
        })
        expect(a2aTaskStore.get('f', 'key:a', first.task.id)).toBeUndefined()
        expect(a2aTaskStore.get('f', 'key:a', second.task.id)).toBeDefined()
        expect(third.question).toBe('1234567890123')
        const remaining = listA2aTasksForTests().filter((row) => row.flowId === 'f')
        const accounted = remaining.reduce((sum, row) => sum + row.storedBytes, 0)
        expect(a2aFlowStoredBytes('f')).toBe(accounted)
        expect(accounted).toBe(remaining.reduce((sum, row) => sum + measureA2aStoredTask(row), 0))
        a2aTaskStore.remove('f', 'key:a', third.task.id)
        expect(a2aFlowStoredBytes('f')).toBe(measureA2aStoredTask(second))
        a2aTaskStore.remove('f', 'key:a', second.task.id)
        expect(a2aFlowStoredBytes('f')).toBe(0)
    })

    it('shortens a just-finished answer so the flow stays within the byte budget', () => {
        process.env.A2A_TASK_BYTES_PER_FLOW = '20'
        const row = a2aTaskStore.create({ flowId: 'f', caller: 'key:a', chatId: 'c', contextId: 'ctx', question: 'q' })
        a2aTaskStore.finalize(row, { state: 'completed', timestamp: isoNow() }, { answer: 'y'.repeat(80) })
        expect(a2aFlowStoredBytes('f')).toBeLessThanOrEqual(20)
        expect(a2aFlowStoredBytes('f')).toBe(row.storedBytes)
        expect(row.storedBytes).toBe(measureA2aStoredTask(row))
        expect(row.answer?.endsWith('[truncated]')).toBe(true)
        expect(utf8Bytes(row.answer)).toBe(19)
    })

    it('never exceeds the flow budget after finalization when the budget is smaller than question plus answer', () => {
        process.env.A2A_TASK_BYTES_PER_FLOW = '10'
        const question = 'q'
        const answer = 'y'.repeat(20)
        expect(utf8Bytes(question) + utf8Bytes(answer)).toBeGreaterThan(10)
        const row = a2aTaskStore.create({ flowId: 'f', caller: 'key:a', chatId: 'c', contextId: 'ctx', question })
        a2aTaskStore.finalize(row, { state: 'completed', timestamp: isoNow() }, { answer })
        expect(a2aFlowStoredBytes('f')).toBeLessThanOrEqual(10)
        expect(measureA2aStoredTask(row)).toBeLessThanOrEqual(10)
        expect(row.storedBytes).toBeLessThanOrEqual(10)
        expect(utf8Bytes(row.question) + utf8Bytes(row.answer)).toBeLessThanOrEqual(10)
        expect(a2aTaskStore.get('f', 'key:a', row.task.id)).toBeDefined()
    })

    it('stores the answer once and derives artifacts at read time', () => {
        const row = a2aTaskStore.create({ flowId: 'f', caller: 'key:a', chatId: 'c', contextId: 'ctx', question: 'q' })
        a2aTaskStore.finalize(row, { state: 'completed', timestamp: isoNow() }, { answer: 'the only copy' })
        expect(row.answer).toBe('the only copy')
        expect(row.task.artifacts).toBeUndefined()
        const view = a2aPublicTask(row)
        expect(view.artifacts).toEqual([
            {
                artifactId: row.artifactId,
                name: 'answer',
                parts: [{ kind: 'text', text: 'the only copy' }]
            }
        ])
        expect(JSON.stringify(row).split('the only copy')).toHaveLength(2)
        const got = a2aTaskStore.get('f', 'key:a', row.task.id)
        expect(got?.task.artifacts).toBeUndefined()
        expect(a2aPublicTask(got!).artifacts?.[0].parts[0].text).toBe('the only copy')
    })
})
