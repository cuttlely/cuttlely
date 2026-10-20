import {
    A2A_TASK_CAP_PER_FLOW,
    TaskStoreFullError,
    a2aCallerKey,
    a2aTaskStore,
    insertA2aTaskForTests,
    isoNow,
    resetA2aTaskStore
} from './taskStore'

describe('a2a task store', () => {
    beforeEach(() => resetA2aTaskStore())

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
})
