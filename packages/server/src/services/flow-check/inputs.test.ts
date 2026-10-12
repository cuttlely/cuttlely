import { applyPreviews, canonicalJson, isVolatileHeader, recordedDraft, recordedQuestion, replayFromQuestion } from './inputs'

const execution = (output: unknown) =>
    JSON.stringify([
        {
            nodeId: 'startAgentflow_0',
            nodeLabel: 'Start',
            data: { name: 'startAgentflow', output },
            status: 'FINISHED'
        }
    ])

describe('recorded inputs', () => {
    test('a form payload is the form object, and key order does not make a new input', () => {
        const first = recordedQuestion(execution({ form: { loaf: 'rye', count: 2 } }), 'formInput')
        const second = recordedQuestion(execution({ form: { count: 2, loaf: 'rye' } }), 'formInput')
        expect(first).toBe(second)
        expect(JSON.parse(first as string)).toEqual({ form: { count: 2, loaf: 'rye' } })
        expect(recordedQuestion(execution({ question: 'hello' }), 'formInput')).toBeNull()
    })

    test('a webhook input is the recorded payload, including a body stored as JSON text', () => {
        const text = recordedQuestion(
            execution({ webhook: JSON.stringify({ body: { event: 'bake' }, query: { page: '1' }, headers: { 'x-bakery': '1' } }) }),
            'webhookTrigger'
        )
        expect(JSON.parse(text as string).webhook.body).toEqual({ event: 'bake' })
        expect(recordedQuestion(execution({ question: 'hello' }), 'webhookTrigger')).toBeNull()
        expect(recordedQuestion('not json', 'webhookTrigger')).toBeNull()
    })

    test('a real form run stores name: value lines, and a schedule form uses the same shape', () => {
        const form = recordedQuestion(execution({ form: 'loaf: millet\nnote: fresh' }), 'formInput')
        const again = recordedQuestion(execution({ form: 'note: fresh\nloaf: millet' }), 'formInput')
        expect(JSON.parse(form as string)).toEqual({ form: { loaf: 'millet', note: 'fresh' } })
        expect(again).toBe(form)
        expect(recordedQuestion(execution({ form: 'loaf: millet' }), 'formInput')).toBe(
            recordedQuestion(execution({ form: { loaf: 'millet' } }), 'formInput')
        )
        expect(JSON.parse(recordedQuestion(execution({ form: 'team: bakery' }), 'scheduleInput') as string)).toEqual({
            form: { team: 'bakery' }
        })
        expect(recordedDraft(execution({ form: 'not a form line' }), 'formInput')).toBeNull()
        expect(recordedDraft(execution({ form: '' }), 'scheduleInput')).toBeNull()
    })

    test('a schedule input is the form, else the trigger text, including the empty-input sentinel', () => {
        expect(JSON.parse(recordedQuestion(execution({ form: { team: 'bakery' } }), 'scheduleInput') as string)).toEqual({
            form: { team: 'bakery' }
        })
        expect(JSON.parse(recordedQuestion(execution({ question: 'Run the daily report' }), 'scheduleInput') as string)).toEqual({
            question: 'Run the daily report'
        })
        expect(JSON.parse(recordedQuestion(execution({ form: {}, question: ' ' }), 'scheduleInput') as string)).toEqual({ question: ' ' })
    })
})

const webhookRow = (webhook: Record<string, unknown>) => recordedDraft(execution({ webhook }), 'webhookTrigger')

describe('webhook distinctness and masking', () => {
    test('volatile headers do not make a second input, and they are not kept', () => {
        for (const name of [
            'date',
            'user-agent',
            'content-length',
            'x-request-id',
            'x-forwarded-for',
            'forwarded',
            'traceparent',
            'x-hub-signature-256',
            'x-slack-request-timestamp'
        ]) {
            expect(isVolatileHeader(name)).toBe(true)
        }
        expect(isVolatileHeader('x-github-event')).toBe(false)
        const quiet = webhookRow({ body: { event: 'bake' }, query: { page: '1' }, headers: { 'X-GitHub-Event': 'push' } })
        const noisy = webhookRow({
            body: { event: 'bake' },
            query: { page: '1' },
            headers: {
                'x-github-event': 'push',
                date: 'Mon, 12 Oct 2026 10:00:00 GMT',
                'user-agent': 'Hookshot',
                'content-length': '42',
                'x-request-id': 'req-1',
                'x-forwarded-for': '203.0.113.5',
                forwarded: 'for=203.0.113.5',
                traceparent: '00-abc',
                'x-hub-signature-256': 'sha256=secret-signature',
                'x-slack-request-timestamp': '1720000000'
            }
        })
        expect(quiet?.key).toBe(noisy?.key)
        const text = noisy?.text || ''
        for (const secret of ['Hookshot', 'req-1', '203.0.113.5', 'sha256=secret-signature', '1720000000', '00-abc']) {
            expect(text).not.toContain(secret)
        }
        expect(JSON.parse(text).webhook.headers['x-github-event']).toBe('push')
    })

    test('a different query or behavior header stays, and a shared body shows what differs', () => {
        const rows = applyPreviews(
            [
                webhookRow({ body: { event: 'bake' }, query: { page: '1' }, headers: { 'x-github-event': 'push' } }),
                webhookRow({
                    body: { event: 'bake' },
                    query: { page: '2', token: 'super-secret-token' },
                    headers: { 'x-github-event': 'release', authorization: 'Bearer sekret', cookie: 'session=abc' }
                }),
                webhookRow({ body: { event: 'close' }, query: {}, headers: { authorization: 'Bearer other-secret' } })
            ].filter((row): row is NonNullable<typeof row> => Boolean(row))
        )
        expect(rows.map((row) => row.key)).toHaveLength(3)
        expect(new Set(rows.map((row) => row.key)).size).toBe(3)
        expect(rows[0].preview).toContain('{"event":"bake"}')
        expect(rows[0].preview).toContain('query {"page":"1"}')
        expect(rows[0].preview).toContain('x-github-event: push')
        expect(rows[1].preview).toContain('query ')
        expect(rows[1].preview).toContain('"page":"2"')
        expect(rows[1].preview).toContain('authorization: [REDACTED]')
        expect(rows[1].preview).toContain('x-github-event: release')
        const hidden = ['super-secret-token', 'Bearer sekret', 'session=abc', 'Bearer other-secret']
        for (const row of rows) {
            for (const secret of hidden) {
                expect(row.text).not.toContain(secret)
                expect(row.preview).not.toContain(secret)
            }
        }
        expect(rows[1].text).toContain('[REDACTED]')
        expect(rows[2].preview).toBe('{"event":"close"}')
        expect(rows[2].text).toContain('"authorization":"[REDACTED]"')
    })

    test('masks cookie, token, secret, key, password and signature query values', () => {
        const row = webhookRow({
            body: { event: 'bake' },
            query: { token: 'tok-1', api_key: 'key-1', password: 'pw-1', client_secret: 'sec-1', signature: 'sig-1' },
            headers: { cookie: 'session=raw-cookie', 'x-api-key': 'raw-key' }
        })
        for (const secret of ['tok-1', 'key-1', 'pw-1', 'sec-1', 'sig-1', 'raw-cookie', 'raw-key']) {
            expect(row?.text).not.toContain(secret)
            expect(row?.preview).not.toContain(secret)
        }
        expect(row?.text).toContain('[REDACTED]')
        expect(row?.key).not.toContain('[REDACTED]')
        expect(row?.key).toContain('tok-1')
    })
})

describe('replayFromQuestion', () => {
    test('rebuilds the input and the chat type that start expects', () => {
        expect(replayFromQuestion('When is the rye ready?', null)).toMatchObject({
            incoming: { question: 'When is the rye ready?' },
            chatType: 'INTERNAL'
        })
        const form = canonicalJson({ form: { loaf: 'rye' } })
        expect(replayFromQuestion(form, 'formInput').incoming.question).toBeUndefined()
        expect(replayFromQuestion(form, 'formInput')).toMatchObject({ incoming: { form: { loaf: 'rye' } }, chatType: 'INTERNAL' })
        const webhook = canonicalJson({ webhook: { body: { event: 'bake' }, headers: {}, query: {} } })
        expect(replayFromQuestion(webhook, 'webhookTrigger')).toMatchObject({
            incoming: { webhook: { body: { event: 'bake' } } },
            chatType: 'WEBHOOK'
        })
        expect(replayFromQuestion(canonicalJson({ question: 'Run the daily report' }), 'scheduleInput')).toMatchObject({
            incoming: { question: 'Run the daily report' },
            chatType: 'SCHEDULED'
        })
        expect(replayFromQuestion(canonicalJson({ form: { team: 'bakery' } }), 'scheduleInput')).toMatchObject({
            incoming: { form: { team: 'bakery' } },
            chatType: 'SCHEDULED'
        })
    })

    test('refuses a trigger question that is not the recorded input', () => {
        expect(() => replayFromQuestion('not json', 'webhookTrigger')).toThrow(/could not be read/)
        expect(() => replayFromQuestion(canonicalJson({ question: 'hi' }), 'formInput')).toThrow(/could not be read/)
    })
})
