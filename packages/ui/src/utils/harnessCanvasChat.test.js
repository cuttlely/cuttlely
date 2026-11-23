import fs from 'fs'
import path from 'path'
import {
    acceptChatSubmit,
    harnessCanvasRunPath,
    harnessRunPath,
    HARNESS_BUSY_MESSAGE,
    harnessResponseError,
    harnessBusyNotice,
    keepUnsentHarnessMessage
} from './harnessCanvasChat'

describe('harness canvas chat', () => {
    it('recognizes a busy 409, including a streamed refusal, without hiding other conflicts', () => {
        const error = harnessResponseError(409, JSON.stringify({ message: HARNESS_BUSY_MESSAGE }))
        expect(error.status).toBe(409)
        expect(error.message).toBe(HARNESS_BUSY_MESSAGE)
        expect(harnessBusyNotice(error)).toBe(HARNESS_BUSY_MESSAGE)
        expect(harnessBusyNotice({ code: 'busy', message: HARNESS_BUSY_MESSAGE })).toBe(HARNESS_BUSY_MESSAGE)
        expect(harnessBusyNotice({ response: { status: 409, data: { message: HARNESS_BUSY_MESSAGE } } })).toBe(HARNESS_BUSY_MESSAGE)
        expect(harnessBusyNotice(harnessResponseError(409, '{"message":"Harness changed. Retry."}'))).toBe('')
        expect(harnessBusyNotice(harnessResponseError(500, HARNESS_BUSY_MESSAGE))).toBe('')
    })

    it('keeps a refused user message and attachments marked not sent beside a notice', () => {
        const messages = [{ type: 'userMessage', message: 'Keep me', fileUploads: [{ name: 'example.txt' }] }]
        expect(keepUnsentHarnessMessage(messages, 'Keep me', HARNESS_BUSY_MESSAGE)).toEqual([
            { ...messages[0], notSent: true },
            { type: 'apiMessage', message: HARNESS_BUSY_MESSAGE, notice: true }
        ])
        expect(messages[0].notSent).toBeUndefined()
    })

    it('the Try it view keeps the question and shows a busy refusal as an info notice', async () => {
        const source = fs.readFileSync(path.join(__dirname, '../views/harnesses/HarnessHome.jsx'), 'utf8')
        const body = source.slice(source.indexOf('    const send ='), source.indexOf('    const problem ='))
        const states = { question: 'Keep this question' }
        const dependencies = {
            question: states.question,
            name: 'bakery',
            running: false,
            harness: { chatflowId: 'flow' },
            setSubmittedQuestion: jest.fn(),
            setRunning: (value) => {
                states.running = value
            },
            setOutput: jest.fn(),
            setRunError: (value) => {
                states.error = value
            },
            setRunNotice: (value) => {
                states.notice = value
            },
            setLiveTrace: (value) => {
                states.trace = value
            },
            emptyTrace: () => ({}),
            AbortController,
            abortRef: { current: null },
            chatIdRef: { current: 'same' },
            baseURL: '',
            harnessCanvasRunPath,
            harnessRunPath,
            harnessResponseError,
            harnessBusyNotice,
            fetchEventSource: async (_url, options) =>
                options.onopen({
                    ok: false,
                    status: 409,
                    headers: { get: () => 'application/json' },
                    text: async () => JSON.stringify({ message: HARNESS_BUSY_MESSAGE })
                }),
            failTrace: jest.fn(),
            reloadRuns: jest.fn()
        }
        const send = new Function(...Object.keys(dependencies), body + '\nreturn send')(...Object.values(dependencies))
        await send()
        expect(states).toEqual({ question: 'Keep this question', running: false, error: '', notice: HARNESS_BUSY_MESSAGE, trace: null })
        expect(source).toMatch(/<Alert severity='info' role='status'>\s*{runNotice}\s*<\/Alert>/)
    })
    it('keeps the external runs route on the published harness', () => {
        expect(harnessRunPath('chief-of-staff')).toBe('/api/v1/harnesses/chief-of-staff/runs')
        expect(harnessRunPath('a b')).toBe('/api/v1/harnesses/a%20b/runs')
    })

    it('posts the canvas chat and Try it to the internal draft route', () => {
        expect(harnessCanvasRunPath('flow-1')).toBe('/api/v1/internal-prediction/flow-1')
        const chat = fs.readFileSync(path.join(__dirname, '../views/chatmessage/ChatMessage.jsx'), 'utf8')
        const home = fs.readFileSync(path.join(__dirname, '../views/harnesses/HarnessHome.jsx'), 'utf8')
        expect(chat).toContain('harnessCanvasRunPath(chatflowId)')
        expect(chat).toContain('fetchHarnessRun(chatflowid, input)')
        expect(home).toContain('harnessCanvasRunPath(harness.chatflowId)')
        expect(home).toContain('harnessRunPath(name)')
    })

    it('accepts one Enter and ignores a second while a send is in flight', () => {
        expect(acceptChatSubmit({ key: 'Enter', text: 'VACUUM INTO x' })).toBe(true)
        expect(acceptChatSubmit({ key: 'Enter', text: 'VACUUM INTO x', busy: true })).toBe(false)
        expect(acceptChatSubmit({ key: 'Enter', text: 'VACUUM INTO x', shiftKey: true })).toBe(false)
        expect(acceptChatSubmit({ key: 'Enter', text: '   ' })).toBe(false)
        expect(acceptChatSubmit({ key: 'a', text: 'VACUUM INTO x' })).toBe(false)
    })
})
