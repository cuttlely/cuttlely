jest.mock('@/api/flowDrafts', () => ({
    __esModule: true,
    default: { getCheckSetup: jest.fn(), startCheck: jest.fn(), getCheck: jest.fn(), stopCheck: jest.fn() }
}))
jest.mock('@/api/dataset', () => ({ __esModule: true, default: { getAllDatasets: jest.fn() } }))
jest.mock('@/api/evaluators', () => ({ __esModule: true, default: { getAllEvaluators: jest.fn() } }))
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPermission: () => false }) }))

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import { PublishCheckView } from './PublishCheck'
import { formatListDateTime } from '@/utils/formatDate'
import { CHECK_WORDS, initialPicks, noPastRunsMessage } from '@/utils/publishCheck'

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

const openingTag = (html, testId) => {
    const marker = `data-testid="${testId}"`
    const at = html.indexOf(marker)
    if (at < 0) return ''
    const start = html.lastIndexOf('<', at)
    const end = html.indexOf('>', at)
    return html.slice(start, end + 1)
}

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
        expect(html).not.toContain('Questions from')
    })

    test('a flow that cannot pick ids does not offer Choose questions', () => {
        const html = render({ canChooseQuestions: false, questionMode: 'choose' })
        expect(html).not.toContain('data-testid="choose-questions"')
        expect(html).toContain('Past questions')
    })

    test('Choose questions lists stored rows, greys out a file question, and keeps the count picker', () => {
        const html = render({
            canChooseQuestions: true,
            questionMode: 'choose',
            setup: {
                unavailable: null,
                questions: [{ text: 'Do you have rye loaves today?' }],
                pastCount: 1,
                riskySteps: [],
                limits,
                check: null
            },
            historyItems: [
                { id: 'chat:a', text: 'Do you have rye loaves today?', source: 'chat', date: '2026-10-08T16:12:03.000Z', replayable: true },
                {
                    id: 'chat:b',
                    text: 'See the scan',
                    source: 'api',
                    date: '2026-10-08T15:00:00.000Z',
                    replayable: false,
                    reason: 'files'
                }
            ],
            historyHasMore: true,
            selectedQuestions: [{ id: 'chat:a', text: 'Do you have rye loaves today?' }],
            list: [{ text: 'Is the rye starter ready?', picked: true, added: true }]
        })
        expect(html).toContain('Choose questions')
        expect(html).toContain('aria-pressed="true"')
        expect(html).toContain('2 of 10 chosen')
        expect(html).toContain('Do you have rye loaves today?')
        expect(html).toContain('See the scan')
        expect(html).toContain('Sent with a file, so it cannot be replayed.')
        expect(html).toContain('Select all shown')
        expect(html).toContain('Load more questions')
        expect(html).toContain('Search questions')
        expect(html).toContain('Question source')
        expect(html).toContain('Canvas chat')
        expect(html).toContain('API')
        expect(html).not.toContain('Replayed input')
        expect(html).not.toContain('Shared link')
        expect(html).not.toContain('Embed')
        expect(html).toContain('From date (UTC)')
        expect(html).toContain('data-testid="compare-count"')
        expect(html).toContain('disabled=""')
        expect(html).not.toContain('data-testid="compare-question"')
        expect(html).toContain('A hand-picked check does not unblock Publish. Only a dataset can be the passing test set.')
        expect(html).not.toContain('Save as dataset')
    })

    test('Save as dataset is offered when the role can create a dataset and a question is ticked', () => {
        const html = render({
            canChooseQuestions: true,
            questionMode: 'choose',
            canSaveDataset: true,
            datasetName: 'Saturday questions',
            historyItems: [
                { id: 'chat:a', text: 'Do you have rye loaves today?', source: 'chat', date: '2026-10-08T16:12:03.000Z', replayable: true }
            ],
            selectedQuestions: [{ id: 'chat:a', text: 'Do you have rye loaves today?' }]
        })
        expect(html).toContain('Save as dataset')
        expect(html).toContain('Real messages can contain personal data. Check the question and the expected answer before saving.')
        expect(html).toContain('Saturday questions')
        expect(openingTag(html, 'save-as-dataset')).not.toContain('disabled')
        const unnamed = render({
            canChooseQuestions: true,
            questionMode: 'choose',
            canSaveDataset: true,
            datasetName: '  ',
            selectedQuestions: [{ id: 'chat:a', text: 'Do you have rye loaves today?' }]
        })
        expect(openingTag(unnamed, 'save-as-dataset')).toContain('disabled')
    })

    test('Choose questions with nothing ticked and nothing typed disables Run check', () => {
        const pastSetup = {
            unavailable: null,
            questions: [{ text: 'Do you have rye loaves today?' }],
            pastCount: 4,
            riskySteps: [],
            limits,
            check: null
        }
        const historyItems = [
            { id: 'chat:a', text: 'Do you have rye loaves today?', source: 'chat', date: '2026-10-08T16:12:03.000Z', replayable: true }
        ]
        const empty = render({
            canChooseQuestions: true,
            questionMode: 'choose',
            setup: pastSetup,
            historyItems,
            selectedQuestions: [],
            list: initialPicks([{ text: 'What are your hours?', starter: true }]),
            newQuestion: ''
        })
        expect(empty).toContain('aria-pressed="true"')
        expect(empty).toContain('0 of 10 chosen')
        expect(openingTag(empty, 'check-run')).toContain('disabled')
        expect(empty).toContain('Run check')

        const counted = render({
            canChooseQuestions: true,
            questionMode: 'count',
            setup: pastSetup,
            list: [],
            newQuestion: ''
        })
        expect(openingTag(counted, 'check-run')).not.toContain('disabled')

        const ticked = render({
            canChooseQuestions: true,
            questionMode: 'choose',
            setup: pastSetup,
            historyItems,
            selectedQuestions: [{ id: 'chat:a', text: 'Do you have rye loaves today?' }],
            list: [],
            newQuestion: ''
        })
        expect(openingTag(ticked, 'check-run')).not.toContain('disabled')

        const typed = render({
            canChooseQuestions: true,
            questionMode: 'choose',
            setup: pastSetup,
            historyItems,
            selectedQuestions: [],
            list: [{ text: 'Is the rye starter ready?', picked: true, added: true }],
            newQuestion: ''
        })
        expect(openingTag(typed, 'check-run')).not.toContain('disabled')
    })

    test('no history yet asks for a question', () => {
        const html = render({})
        expect(html).toContain('No one has asked this flow anything yet. Add a question to check.')
        expect(html).not.toContain('No past runs exist yet')
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
                replaySource: 'webhook',
                questions: [{ text: question, date: '2026-10-08T10:00:00.000Z', source: 'webhook' }],
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
                cases: [{ question, source: 'webhook', date: '2026-10-08T10:00:00.000Z', live, draft, same: false }],
                summary: { ran: 1, same: 0, changed: 1, errors: 0, liveTokens: 44, draftTokens: 45, liveMedianMs: 657, draftMedianMs: 525 }
            }
        })
        expect(html).toContain('Check recent runs')
        expect(html).not.toContain('Check recent questions')
        expect(html).toContain('Runs to compare')
        expect(html).not.toContain('Questions to compare')
        expect(html).toContain('Run recent inputs again on Live and on your draft')
        expect(html).toContain('Requested runs')
        expect(html).toContain('Only 1 past run available. Comparing that run.')
        expect(html).toContain(`Webhook · ${formatListDateTime('2026-10-08T10:00:00.000Z')}`)
        expect(html).toContain('{&quot;event&quot;:&quot;bake&quot;,&quot;loaf&quot;:&quot;rye&quot;}')
        expect(html).not.toContain('sekret')
        expect(html).not.toContain('Add your own question')
        expect(html).not.toContain('Past runs')
        expect(html).not.toContain('Past questions')
        expect(html).toContain('Changed')
        expect(html).toContain('MANGO')
        expect(html).toContain('PAPAYA')
        expect(html).toContain('recorded input')
    })

    test('a form input shows Form and when it was recorded', () => {
        const recorded = '2026-10-08T08:30:00.000Z'
        const html = render({
            setup: {
                unavailable: null,
                replayInputs: true,
                replaySource: 'form',
                questions: [{ text: '{"form":{"loaf":"rye"}}', preview: '{"loaf":"rye"}', date: recorded, source: 'form' }],
                pastCount: 1,
                riskySteps: [],
                limits,
                check: null
            },
            list: []
        })
        expect(html).toContain('Check recent runs')
        expect(html).toContain(`Form · ${formatListDateTime(recorded)}`)
        expect(html).toContain('{&quot;loaf&quot;:&quot;rye&quot;}')
        expect(html).toContain('Requested runs')
    })

    test('on promote, recorded inputs are described as this server’s and still show source and time', () => {
        const recorded = '2026-10-08T11:04:00.000Z'
        const html = render({
            words: CHECK_WORDS.promote,
            setup: {
                unavailable: null,
                replayInputs: true,
                replaySource: 'webhook',
                questions: [
                    {
                        text: '{"webhook":{"body":{"event":"order"}}}',
                        preview: '{"event":"order"} headers authorization: [REDACTED]',
                        date: recorded,
                        source: 'webhook'
                    }
                ],
                pastCount: 1,
                riskySteps: [],
                limits,
                check: null
            },
            list: []
        })
        expect(html).toContain('from this server')
        expect(html).toContain(`Webhook · ${formatListDateTime(recorded)}`)
        expect(html).toContain('authorization: [REDACTED]')
        expect(html).toContain('Promote works with or without a check.')
        expect(html).not.toContain('Publish works with or without a check.')
    })

    test('a shared webhook body shows the supplied preview and not a secret', () => {
        const html = render({
            setup: {
                unavailable: null,
                replayInputs: true,
                questions: [
                    {
                        text: '{"webhook":{"body":{"event":"bake"},"headers":{"authorization":"[REDACTED]"}}}',
                        preview: '{"event":"bake"} query {"page":"2"} headers authorization: [REDACTED]',
                        source: 'webhook',
                        date: '2026-10-08T11:00:00.000Z'
                    }
                ],
                pastCount: 1,
                riskySteps: [],
                limits,
                check: null
            },
            list: []
        })
        expect(html).toContain(
            '{&quot;event&quot;:&quot;bake&quot;} query {&quot;page&quot;:&quot;2&quot;} headers authorization: [REDACTED]'
        )
        expect(html).toContain(`Webhook · ${formatListDateTime('2026-10-08T11:00:00.000Z')}`)
        expect(html).not.toContain('Bearer')
        expect(html).not.toContain('sekret')
    })

    test('no past runs says how to create one, and the risky-step gate still shows', () => {
        const empty = (source) =>
            render({
                setup: {
                    unavailable: null,
                    replayInputs: true,
                    replaySource: source,
                    questions: [],
                    pastCount: 0,
                    riskySteps: [{ id: 'http', label: 'Send the order' }],
                    limits,
                    check: null
                }
            })
        for (const source of ['form', 'webhook', 'schedule']) {
            const html = empty(source)
            expect(html).toContain(noPastRunsMessage(source))
            expect(html).toContain('Send the order')
            expect(html).toContain('Run it anyway, including those steps')
            expect(html).not.toContain('Add your own question')
            expect(html).not.toContain('No one has asked this flow anything yet.')
            expect(html).not.toContain('The check asks questions')
        }
    })

    test('the past-run picker offers the same counts as past questions', () => {
        const recorded = new Date('2026-10-08T09:15:00.000Z').toISOString()
        const html = render({
            count: 10,
            setup: {
                unavailable: null,
                replayInputs: true,
                replaySource: 'schedule',
                questions: [{ text: '{"question":"daily"}', preview: '"daily"', date: recorded, source: 'schedule' }],
                pastCount: 1,
                riskySteps: [],
                limits: { ...limits, maxQuestions: 100 },
                check: null
            },
            list: []
        })
        expect(html).toContain('Check recent runs')
        expect(html).toContain('data-testid="compare-count"')
        expect(html).toContain('Requested runs')
        expect(html).not.toContain('Past runs')
        expect(html).not.toContain('Past questions')
        for (const n of [4, 10, 25, 50, 100]) expect(html).toContain(`value="${n}"`)
        expect(html).toContain('value="10"')
        expect(html).toContain('Only 1 past run available. Comparing that run.')
        expect(html).toContain(`Schedule · ${formatListDateTime(recorded)}`)
        expect(html).toContain('&quot;daily&quot;')
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

    test('the risky-step warning keeps its icon and checkbox visible in dark mode', () => {
        const props = {
            setup: { unavailable: null, questions: [], riskySteps: [{ id: 'p', label: 'Post-processing code' }], limits, check: null },
            list: initialPicks([{ text: 'Hi' }])
        }
        const dark = render({ ...props, isDarkMode: true })
        expect(dark).toContain('rgba(255, 167, 38, 0.08)')
        expect(dark).toContain('rgba(255, 167, 38, 0.95)')
        expect(render(props)).not.toContain('rgba(255, 167, 38, 0.08)')
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
        expect(html).toContain('Stopped at the token limit. These are the questions answered so far.')
    })

    test('a runs check uses runs and recorded-input wording for progress, stop, and an empty summary', () => {
        const running = render({
            setup: { unavailable: null, replayInputs: true, replaySource: 'webhook', questions: [], pastCount: 0, riskySteps: [], limits },
            check: {
                id: 'c1',
                status: 'running',
                total: 2,
                completed: 1,
                stopReason: null,
                draftChanged: false,
                liveEmpty: false,
                cases: [{ question: '{"webhook":{"body":{}}}', live, draft, same: false }],
                summary: { ran: 0 }
            }
        })
        expect(running).toContain('Ran 1 of 2…')
        expect(running).not.toContain('Asked 1 of 2…')
        const stopped = render({
            setup: { unavailable: null, replayInputs: true, replaySource: 'form', questions: [], pastCount: 0, riskySteps: [], limits },
            check: {
                id: 'c2',
                status: 'stopped',
                stopReason: 'stopped',
                total: 2,
                completed: 0,
                draftChanged: false,
                liveEmpty: false,
                cases: [],
                summary: { ran: 0 }
            }
        })
        expect(stopped).toContain('You stopped the check. These are the runs answered so far.')
        expect(stopped).toContain('No recorded input was answered by both versions.')
        expect(stopped).not.toContain('questions answered so far')
        expect(stopped).not.toContain('No question was answered')
        const emptyLive = render({
            setup: {
                unavailable: null,
                replayInputs: true,
                replaySource: 'schedule',
                questions: [],
                pastCount: 0,
                riskySteps: [],
                limits,
                liveEmpty: true
            },
            check: {
                id: 'c3',
                status: 'done',
                stopReason: 'time',
                total: 1,
                completed: 0,
                draftChanged: false,
                liveEmpty: true,
                cases: [],
                summary: { ran: 0 }
            }
        })
        expect(emptyLive).toContain('Stopped at the time limit. These are the runs answered so far.')
        expect(emptyLive).toContain('No recorded input was answered on your draft.')
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
        expect(type).toContain('>Check<')
        expect(type).not.toContain('Check recent questions')
        expect(type).not.toContain('data-testid="check-run"')
        const settled = render({
            loading: false,
            checkKind: null,
            setup: {
                unavailable: {
                    code: 'start',
                    message: 'The check asks questions, so it works on agentflows that start with a chat message.'
                },
                replayInputs: false,
                questions: [],
                riskySteps: [],
                limits,
                check: null
            }
        })
        expect(settled).toContain('The check asks questions, so it works on agentflows that start with a chat message.')
        expect(settled).toContain('>Check<')
        expect(settled).not.toContain('Check recent questions')
        expect(settled).not.toContain('Check recent runs')
        expect(render({ setup: { unavailable: { code: 'off', message: 'Drafts are off on this server.' }, limits } })).toBe('')
    })

    test('loading uses the canvas hint, and an unknown start does not say questions or runs', () => {
        const unknown = render({ loading: true, setup: null })
        expect(unknown).toContain('Loading the check…')
        expect(unknown).toContain('data-testid="check-title"')
        expect(unknown).not.toContain('Check recent questions')
        expect(unknown).not.toContain('Check recent runs')
        expect(unknown).not.toContain('Loading recent questions…')
        expect(unknown).not.toContain('Loading recent runs…')
        const runs = render({ loading: true, setup: null, checkKind: 'runs' })
        expect(runs).toContain('Check recent runs')
        expect(runs).toContain('Loading recent runs…')
        expect(runs).not.toContain('Check recent questions')
        const questions = render({ loading: true, setup: null, checkKind: 'questions' })
        expect(questions).toContain('Check recent questions')
        expect(questions).toContain('Loading recent questions…')
        expect(questions).not.toContain('Check recent runs')
        expect(render({ loadError: 'Recent questions could not be loaded.', setup: null })).toContain(
            'Recent questions could not be loaded. You can still publish.'
        )
        const reason = 'Publish needs a passing test set at 100%. There is no result for this draft yet.'
        const gated = render({ loadError: 'Recent questions could not be loaded.', setup: null, gateNote: reason })
        expect(gated).toContain(reason)
        expect(gated).not.toContain('You can still publish.')
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
                limits: { ...limits, maxQuestions: 100 },
                check: null
            },
            list: []
        })
        expect(html).toContain('data-testid="compare-count"')
        expect(html).toContain('Questions to compare')
        expect(html).not.toContain('Runs to compare')
        expect(html).toContain('Requested questions')
        expect(html).not.toContain('Past questions')
        for (const n of [4, 10, 25, 50, 100]) expect(html).toContain(`value="${n}"`)
        expect(html).toContain('Only 37 past questions available. Comparing all 37.')
        expect(html).toContain('That is 74 runs for 37 questions.')
        expect(html).not.toContain('$')
    })

    test('the picker and the hand-pick cap follow the counts from setup', () => {
        const choose = (maxQuestions, counts, count) =>
            render({
                count,
                canChooseQuestions: true,
                questionMode: 'choose',
                setup: {
                    unavailable: null,
                    questions: [{ text: 'Do you have rye loaves today?' }],
                    pastCount: 1,
                    riskySteps: [],
                    limits: { ...limits, maxQuestions, defaultQuestions: 4, counts },
                    check: null
                },
                historyItems: [],
                selectedQuestions: [],
                list: []
            })
        const below = choose(40, [4, 10, 25, 40], 4)
        for (const n of [4, 10, 25, 40]) expect(below).toContain(`value="${n}"`)
        expect(below).not.toContain('value="50"')
        expect(below).not.toContain('value="100"')
        expect(below).toContain('0 of 40 chosen')
        const above = choose(200, [4, 10, 25, 50, 100, 200], 100)
        for (const n of [4, 10, 25, 50, 100, 200]) expect(above).toContain(`value="${n}"`)
        expect(above).toContain('0 of 200 chosen')
        expect(above).not.toContain('value="500"')
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

    test('a dataset and evaluators are a choice, with a score chip and a pass rate', () => {
        const hidden = render({ list: initialPicks([{ text: 'Hi' }]) })
        expect(hidden).not.toContain('data-testid="check-question-source"')
        const html = render({
            canUseDatasets: true,
            canUseEvaluators: true,
            source: 'dataset',
            datasetId: 'ds-1',
            datasets: [{ id: 'ds-1', name: 'Bakery questions', rowCount: 2 }],
            evaluators: [{ id: 'ev-1', name: 'Mentions mango' }],
            evaluatorIds: ['ev-1'],
            list: [],
            check: {
                id: 'c1',
                status: 'done',
                total: 1,
                completed: 1,
                stopReason: null,
                draftChanged: false,
                cases: [
                    {
                        question: 'Do you have gluten-free bread today?',
                        expected: 'Yes, every day.',
                        live: { ...live, scores: [{ id: 'ev-1', name: 'Mentions mango', result: 'Fail' }] },
                        draft: { ...draft, scores: [{ id: 'ev-1', name: 'Mentions mango', result: 'Pass' }] },
                        same: false
                    }
                ],
                summary: {
                    ran: 1,
                    same: 0,
                    changed: 1,
                    errors: 0,
                    liveTokens: 44,
                    draftTokens: 45,
                    liveMedianMs: 657,
                    draftMedianMs: 525,
                    scores: {
                        live: { passed: 0, failed: 1, errored: 0, passRate: 0 },
                        draft: { passed: 1, failed: 0, errored: 0, passRate: 100 }
                    }
                }
            }
        })
        expect(html).toContain('data-testid="check-question-source"')
        expect(html).toContain('Recent questions')
        expect(html).toContain('A dataset')
        expect(html).toContain('Bakery questions')
        expect(html).toContain('data-testid="check-evaluator"')
        expect(html).toContain('Mentions mango')
        expect(html).toContain('Expected: Yes, every day.')
        expect(html).toContain('Mentions mango: Fail')
        expect(html).toContain('Mentions mango: Pass')
        expect(html).toContain('Live pass rate: 0%')
        expect(html).toContain('Draft pass rate: 100%')
        expect(html).not.toContain('data-testid="compare-count"')
    })

    test('on the promote page it speaks of the version from Dev, not a draft', () => {
        const html = render({ list: initialPicks([{ text: 'What are your hours?' }]), words: CHECK_WORDS.promote })
        expect(html).toContain('on the version from Dev')
        expect(html).toContain('Promote works with or without a check.')
        expect(html).not.toContain('Publish works with or without a check.')
    })

    test('with the gate on, the optional lines are the gate reason', () => {
        const reason = 'Publish needs a passing test set at 100%. There is no result for this draft yet.'
        const html = render({
            list: initialPicks([{ text: 'What are your hours?' }]),
            source: 'dataset',
            canUseDatasets: true,
            datasetId: 'ds-1',
            datasets: [{ id: 'ds-1', name: 'Bakery questions' }],
            gateNote: reason
        })
        expect(html).toContain(reason)
        expect(html).not.toContain('This is optional.')
        expect(html).not.toContain('Publish works with or without a check.')
    })
})
