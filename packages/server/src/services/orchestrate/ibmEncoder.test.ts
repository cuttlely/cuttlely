import { readFileSync } from 'fs'
import path from 'path'
import { z } from 'zod'
import { chatCompletionBody, ibmDeltaFrame, makeIbmEncoder } from './ibmEncoder'

const COMMIT = 'ef50cc58ae'
const fixtures = path.join(__dirname, '__fixtures__')
const stripComment = (row: Record<string, unknown>) => {
    const { $comment: _comment, ...rest } = row
    return rest
}

const deltaSchema = z.object({
    id: z.string(),
    object: z.literal('thread.message.delta'),
    thread_id: z.string(),
    model: z.string(),
    created: z.number().int(),
    choices: z
        .array(
            z.object({
                delta: z.object({
                    role: z.literal('assistant'),
                    content: z.string()
                })
            })
        )
        .min(1)
})

const completionSchema = z.object({
    id: z.string(),
    object: z.literal('chat.completion'),
    created: z.number().int(),
    model: z.string(),
    choices: z.array(
        z.object({
            index: z.number(),
            message: z.object({
                role: z.enum(['user', 'assistant']),
                content: z.string()
            }),
            finish_reason: z.string()
        })
    )
})

const meta = { responseId: 'chatcmpl-1', threadId: 'Ada-01', model: 'cuttlely-flow', created: 1792430000 }

describe(`ibmEncoder (spec.yaml ${COMMIT})`, () => {
    it('encodes a token as a thread.message.delta frame with every required field', () => {
        const encoder = makeIbmEncoder(meta)
        const bytes = encoder({ kind: 'event', payload: { event: 'token', data: 'Hello' } })
        expect(bytes).toBe(ibmDeltaFrame(meta, 'Hello'))
        expect(bytes?.startsWith('event: thread.message.delta\ndata: ')).toBe(true)
        expect(bytes?.endsWith('\n\n')).toBe(true)
        const data = JSON.parse((bytes as string).split('data: ')[1].trim())
        expect(deltaSchema.parse(data).choices[0].delta.content).toBe('Hello')
    })

    it('keeps heartbeats as comments and writes nothing for other events or the final frame', () => {
        const encoder = makeIbmEncoder(meta)
        expect(encoder({ kind: 'comment', text: 'heartbeat' })).toBe(':heartbeat\n\n')
        expect(encoder({ kind: 'event', payload: { event: 'start', data: 'x' } })).toBeNull()
        expect(encoder({ kind: 'event', payload: { event: 'metadata', data: { sessionToken: 'tok' } } })).toBeNull()
        expect(encoder({ kind: 'event', payload: { event: 'error', data: 'secret' } })).toBeNull()
        expect(encoder({ kind: 'final', payload: { event: 'end', data: '[DONE]' } })).toBeNull()
    })

    it('builds a non-stream chat.completion body', () => {
        const body = chatCompletionBody(meta, 'Hello Ada')
        expect(completionSchema.parse(body).choices[0].message.content).toBe('Hello Ada')
    })

    it('re-types the spec.yaml request and response fixtures', () => {
        const requestSchema = z.object({
            model: z.string(),
            stream: z.boolean().optional(),
            messages: z
                .array(
                    z.object({
                        role: z.enum(['user', 'assistant', 'system', 'tool']),
                        content: z.union([z.string(), z.array(z.object({ type: z.literal('text'), text: z.string() }))])
                    })
                )
                .min(1)
        })
        const request = stripComment(JSON.parse(readFileSync(path.join(fixtures, 'chat-completion-request.json'), 'utf8')))
        const response = stripComment(JSON.parse(readFileSync(path.join(fixtures, 'chat-completion-response.json'), 'utf8')))
        const delta = stripComment(JSON.parse(readFileSync(path.join(fixtures, 'thread-message-delta.json'), 'utf8')))
        expect(requestSchema.parse(request).model).toBe('any')
        expect(completionSchema.parse(response).choices[0].message.content).toBe('Hello Ada')
        expect(deltaSchema.parse(delta).choices[0].delta.content).toBe('Hello')
    })
})

describe('makeIbmEncoder artifacts', () => {
    const meta = { responseId: 'chatcmpl-1', threadId: 't-1', model: 'm', created: 1 }
    const frame = { kind: 'event' as const, payload: { event: 'artifacts', data: [{ type: 'png', data: 'FILE-STORAGE::a.png' }] } }

    it('notes artifacts without sending anything, so links never land inside the streamed text', () => {
        const seen: unknown[] = []
        const encoder = makeIbmEncoder(meta, (a) => seen.push(a))
        const tok = (data: string) => encoder({ kind: 'event', payload: { event: 'token', data } } as any)
        const text = (s: string | null) => (s ? deltaSchema.parse(JSON.parse(s.split('data: ')[1])).choices[0].delta.content : '')
        const out = [tok('See ![x](attach'), encoder(frame as any), tok('ment:x.png) done')].map(text)
        expect(out.join('') + encoder.flush()).toBe('See  done')
        expect(seen).toEqual([frame.payload.data])
        expect(makeIbmEncoder(meta)(frame as any)).toBeNull()
    })
})
