jest.mock('@/api/flowDrafts', () => ({
    __esModule: true,
    default: { getCheckSetup: jest.fn(), startCheck: jest.fn(), getCheck: jest.fn(), stopCheck: jest.fn() }
}))

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import { PublishCheckView } from './PublishCheck'
import { CHECK_WORDS, initialPicks } from '@/utils/publishCheck'

const limits = { maxQuestions: 10, maxQuestionChars: 2000, maxTokens: 100000, maxSeconds: 180 }
const noop = () => {}
const render = (props) =>
    renderToStaticMarkup(
        createElement(
            ThemeProvider,
            { theme: createTheme() },
            createElement(PublishCheckView, {
                setup: { unavailable: null, questions: [], riskySteps: [], limits, check: null },
                loading: false,
                loadError: '',
                list: [],
                newQuestion: '',
                addError: '',
                runAnyway: false,
                check: null,
                starting: false,
                error: '',
                onToggle: noop,
                onNewQuestion: noop,
                onAdd: noop,
                onRunAnyway: noop,
                onRun: noop,
                onStop: noop,
                ...props
            })
        )
    )

const live = { text: 'MANGO', error: null, tokens: 44, ms: 657 }
const draft = { text: 'PAPAYA', error: null, tokens: 45, ms: 525 }

describe('PublishCheckView', () => {
    test('marks the starter questions of a new flow', () => {
        const html = render({ list: initialPicks([{ text: 'What are your hours?', date: '', starter: true }]) })
        expect(html).toContain('What are your hours?')
        expect(html).toContain('(starter question)')
    })

    test('lists the recent questions, the add box, the cost note and Run check', () => {
        const html = render({ list: initialPicks([{ text: 'What are your hours?' }, { text: 'Do you deliver?' }]) })
        expect(html).toContain('Check recent questions')
        expect(html).toContain('What are your hours?')
        expect(html).toContain('Do you deliver?')
        expect(html.match(/data-testid="check-question"/g)).toHaveLength(2)
        expect(html).toContain('Add your own question')
        expect(html).toContain('uses the model and costs tokens. That is 4 runs for 2 questions.')
        expect(html).toContain('data-testid="check-run"')
        expect(html).toContain('Run check')
        expect(html).toContain('Publish works with or without a check.')
    })

    test('no history yet asks for a question', () => {
        const html = render({})
        expect(html).toContain('No one has asked this flow anything yet. Add a question to check.')
        expect(html).not.toContain('No past runs to replay yet')
        expect(html).toContain('Add your own question')
        expect(html).toContain('Past questions')
    })

    test('a webhook flow shows recorded inputs in place of questions, with the same Changed label', () => {
        const question = JSON.stringify({
            webhook: { body: { event: 'bake', loaf: 'rye' }, headers: { 'x-bakery': '1' }, query: {} }
        })
        const html = render({
            setup: {
                unavailable: null,
                replayInputs: true,
                questions: [{ text: question, date: '2026-10-08T10:00:00.000Z' }],
                pastCount: 1,
                pastTruncated: false,
                riskySteps: [],
                limits,
                liveEmpty: false,
                check: null
            },
            list: [],
            check: {
                id: 'c1',
                status: 'done',
                total: 1,
                completed: 1,
                stopReason: null,
                draftChanged: false,
                liveEmpty: false,
                cases: [{ question, live, draft, same: false }],
                summary: { ran: 1, same: 0, changed: 1, errors: 0, liveTokens: 44, draftTokens: 45, liveMedianMs: 657, draftMedianMs: 525 }
            }
        })
        expect(html).toContain('Run recent inputs again on Live and on your draft')
        expect(html).toContain('{&quot;event&quot;:&quot;bake&quot;,&quot;loaf&quot;:&quot;rye&quot;}')
        expect(html).not.toContain('Add your own question')
        expect(html).toContain('Past runs')
        expect(html).not.toContain('Past questions')
        expect(html).toContain('Changed')
        expect(html).toContain('MANGO')
        expect(html).toContain('PAPAYA')
        expect(html).toContain('recorded input')
    })

    test('no past runs says so, and the chat empty state does not', () => {
        const html = render({
            setup: {
                unavailable: null,
                replayInputs: true,
                questions: [],
                pastCount: 0,
                riskySteps: [{ id: 'http', label: 'Send the order' }],
                limits,
                check: null
            }
        })
        expect(html).toContain('No past runs to replay yet. Run this flow once, then check again.')
        expect(html).toContain('Send the order')
        expect(html).not.toContain('Add your own question')
        expect(html).not.toContain('No one has asked this flow anything yet.')
    })

    test('risky steps show the warning and the run anyway choice', () => {
        const html = render({
            setup: { unavailable: null, questions: [], riskySteps: [{ id: 'p', label: 'Post-processing code' }], limits, check: null },
            list: initialPicks([{ text: 'Hi' }])
        })
        expect(html).toContain('data-testid="check-risky"')
        expect(html).toContain('Post-processing code')
        expect(html).toContain('Run it anyway, including those steps')
    })

    test('a running check shows progress and Stop instead of Run', () => {
        const check = {
            id: 'c1',
            status: 'running',
            total: 2,
            completed: 1,
            stopReason: null,
            draftChanged: false,
            cases: [
                { question: 'Hi', live, draft, same: false },
                { question: 'Hello', live: null, draft: null, same: null }
            ],
            summary: { ran: 1 }
        }
        const html = render({ list: initialPicks([{ text: 'Hi' }, { text: 'Hello' }]), check })
        expect(html).toContain('Asked 1 of 2…')
        expect(html).toContain('data-testid="check-stop"')
        expect(html).not.toContain('data-testid="check-run"')
        expect(html).toContain('Closing this window or publishing stops a check that is still running.')
        expect(html).toContain('Waiting…')
    })

    test('results show Live and Draft side by side with tokens and time', () => {
        const check = {
            id: 'c1',
            status: 'stopped',
            stopReason: 'tokens',
            total: 2,
            completed: 1,
            draftChanged: true,
            cases: [
                { question: 'What is your code word?', live, draft, same: false },
                { question: 'Unasked', live: null, draft: null, same: null }
            ],
            summary: { ran: 1, same: 0, changed: 1, errors: 0, liveTokens: 44, draftTokens: 45, liveMedianMs: 657, draftMedianMs: 525 }
        }
        const html = render({ list: initialPicks([{ text: 'What is your code word?' }]), check })
        expect(html).toContain('1 of 1 answered differently.')
        expect(html).toContain(
            'Tokens: Live 44, draft 45 (Draft used 1 more). Typical time: Live 0.7 s, draft 0.5 s (Draft was 0.1 s faster).'
        )
        expect(html).toContain('Stopped at the token limit.')
        expect(html).toContain('The draft changed after this check ran.')
        expect(html.match(/data-testid="check-case"/g)).toHaveLength(1)
        expect(html).toContain('MANGO')
        expect(html).toContain('PAPAYA')
        expect(html).toContain('44 tokens, 0.7 s')
        expect(html).toContain('45 tokens, 0.5 s')
        expect(html).toContain('Changed')
        expect(html).toContain('Run check again')
        expect(html).not.toContain('Unasked')
    })

    test('unavailable flows say why; drafts off shows nothing', () => {
        const type = render({
            setup: {
                unavailable: { code: 'type', message: 'The check works on chatflows and agentflows.' },
                questions: [],
                riskySteps: [],
                limits
            }
        })
        expect(type).toContain('The check works on chatflows and agentflows.')
        expect(type).not.toContain('data-testid="check-run"')
        expect(render({ setup: { unavailable: { code: 'off', message: 'Drafts are off on this server.' }, limits } })).toBe('')
    })

    test('loading and load errors never block publishing', () => {
        expect(render({ loading: true, setup: null })).toContain('Loading recent questions…')
        expect(render({ loadError: 'Recent questions could not be loaded.', setup: null })).toContain(
            'Recent questions could not be loaded. You can still publish.'
        )
    })

    test('the past-question picker offers 4, 10, 25, 50 and 100, and caps a short history', () => {
        const html = render({
            count: 50,
            setup: {
                unavailable: null,
                questions: [],
                pastCount: 37,
                pastTruncated: false,
                riskySteps: [],
                limits,
                check: null
            },
            list: []
        })
        expect(html).toContain('data-testid="compare-count"')
        expect(html).toContain('Past questions')
        for (const n of [4, 10, 25, 50, 100]) expect(html).toContain(`value="${n}"`)
        expect(html).toContain('Only 37 past questions available. Comparing all 37.')
        expect(html).toContain('That is 74 runs for 37 questions.')
        expect(html).not.toContain('$')
    })

    test('a long result shows the totals first and the next page on Show more', () => {
        const cases = Array.from({ length: 13 }, (_, i) => ({
            question: `Question ${i}`,
            live,
            draft,
            same: i % 2 === 0
        }))
        const html = render({
            list: [],
            check: {
                id: 'long',
                status: 'done',
                total: 13,
                completed: 13,
                stopReason: null,
                draftChanged: false,
                cases,
                summary: {
                    ran: 13,
                    same: 7,
                    changed: 6,
                    errors: 0,
                    liveTokens: 130,
                    draftTokens: 140,
                    liveMedianMs: 500,
                    draftMedianMs: 400
                }
            }
        })
        expect(html).toContain('data-testid="check-summary"')
        expect(html).toContain('6 of 13 answered differently')
        expect(html.indexOf('data-testid="check-summary"')).toBeLessThan(html.indexOf('data-testid="check-case"'))
        expect(html.match(/data-testid="check-case"/g)).toHaveLength(12)
        expect(html).toContain('data-testid="check-results-more"')
        expect(html).toContain('Show more')
        expect(html).not.toContain('Question 12')
    })

    test('on the promote page it speaks of the version from Dev, not a draft', () => {
        const html = render({ list: initialPicks([{ text: 'What are your hours?' }]), words: CHECK_WORDS.promote })
        expect(html).toContain('on the version from Dev')
        expect(html).toContain('Promote works with or without a check.')
        expect(html).not.toContain('Publish works with or without a check.')
    })
})
