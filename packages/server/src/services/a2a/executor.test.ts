jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}))

import { AppError } from '../../errors/appError'
import { classifyOutcome, isHumanInputResult, resolveContext } from './executor'
import { a2aTaskStore, isoNow, resetA2aTaskStore } from './taskStore'

describe('A2A executor helpers', () => {
    beforeEach(() => resetA2aTaskStore())

    it('detects a human-input pause from waitingForApproval, not a bare action field', () => {
        expect(isHumanInputResult({ text: 'hi', action: {} })).toBe(false)
        expect(isHumanInputResult({ text: 'hi', action: { type: 'approve' } })).toBe(true)
        expect(isHumanInputResult({ text: 'hi' })).toBe(false)
    })

    it('resolves context from contextId, then taskId, then referenceTaskIds, then a new id', () => {
        const flow = { id: 'f', apikeyid: 'k' }
        const stored = a2aTaskStore.create({ flowId: 'f', caller: 'key:k', chatId: 'c', contextId: 'from-task', question: 'q' })
        expect(resolveContext({ flow, caller: 'key:k', parsed: { question: 'q', contextId: 'direct' } }).ctxSrc).toBe('context')
        expect(resolveContext({ flow, caller: 'key:k', parsed: { question: 'q', taskId: stored.task.id } })).toEqual({
            contextId: 'from-task',
            ctxSrc: 'task'
        })
        expect(
            resolveContext({
                flow,
                caller: 'key:k',
                parsed: { question: 'q', referenceTaskIds: ['missing', stored.task.id] }
            })
        ).toEqual({ contextId: 'from-task', ctxSrc: 'ref' })
        expect(resolveContext({ flow, caller: 'key:k', parsed: { question: 'q' } }).ctxSrc).toBe('new')
    })

    it('classifies cancel, disconnect, failure, and success in that order', () => {
        const row = a2aTaskStore.create({ flowId: 'f', caller: 'key:k', chatId: 'c', contextId: 'ctx', question: 'q' })
        row.cancelRequested = true
        expect(classifyOutcome({ row, result: { text: 'late' } }).kind).toBe('canceled')
        row.cancelRequested = false
        const aborted = { aborted: true } as AbortSignal
        expect(classifyOutcome({ row, signal: aborted, result: { text: 'late' } }).kind).toBe('disconnected')
        expect(classifyOutcome({ row, error: new AppError(500, 'secret-raw') }).kind).toBe('failed')
        expect(classifyOutcome({ row, result: { text: 'Hello', action: { type: 'approve' } } })).toEqual({
            kind: 'failed',
            text: 'This flow needs human input, which this endpoint does not support (code human_input_unsupported).'
        })
        expect(classifyOutcome({ row, result: { text: 'Hello' } })).toEqual({ kind: 'completed', text: 'Hello' })
        expect(isoNow(0)).toBe('1970-01-01T00:00:00.000Z')
    })
})
