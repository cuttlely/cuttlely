import { canonicalJson, recordedQuestion, replayFromQuestion } from './inputs'

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
