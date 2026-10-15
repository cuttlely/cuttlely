import {
    CHECK_INTRO,
    CHECK_TITLE,
    CHECK_RUNS_TITLE,
    LOADING_UNKNOWN,
    canvasStartType,
    canPickQuestionIds,
    checkKind,
    checkTitle,
    countPickerLabel,
    loadingText,
    COMPARE_COUNTS,
    DEFAULT_COMPARE_COUNT,
    addQuestion,
    canRunCheck,
    capMessage,
    compareListLabel,
    loadFailureMessage,
    inputMeta,
    inputPreview,
    NO_PAST_RUNS,
    noPastRunsMessage,
    caseBadge,
    CHECK_WORDS,
    promoteCheckWords,
    costNote,
    formatMs,
    initialPicks,
    pickedQuestions,
    progressText,
    riskyWarning,
    sideCaption,
    passMarkNumber,
    POLL_MS,
    gatePollBudgetMs,
    pollGateCheck,
    passRateText,
    verdictText,
    stopReasonText,
    summaryText,
    togglePick,
    usageText,
    visibleCases,
    chooseRoom,
    chosenLabel,
    hiddenChosenCount,
    historyReasonText,
    chooseRunBody,
    selectShown,
    toggleHistoryPick,
    typedRoom,
    typedToggleLimit
} from './publishCheck'
import { formatListDateTime } from '@/utils/formatDate'
import * as copy from './publishCheck'

const limits = { maxQuestions: 10, maxQuestionChars: 2000, maxTokens: 100000, maxSeconds: 180 }

describe('how many past questions', () => {
    test('the choices start at 4, and a short history is described in words', () => {
        expect(DEFAULT_COMPARE_COUNT).toBe(4)
        expect(COMPARE_COUNTS).toEqual([4, 10, 25, 50, 100])
        expect(capMessage(4, 10)).toBe('')
        expect(capMessage(50, 37)).toBe('Only 37 past questions available. Comparing all 37.')
        expect(capMessage(10, 1)).toBe('Only 1 past question available. Comparing that question.')
        expect(capMessage(25, 0)).toBe('')
        expect(capMessage(100, 20, true)).toBe('Only 20 distinct past questions in the recent messages we looked at. Comparing all 20.')
        expect(capMessage(10, 2, false, 'run')).toBe('Only 2 past runs available. Comparing all 2.')
        expect(capMessage(10, 1, false, 'run')).toBe('Only 1 past run available. Comparing that run.')
    })
})

describe('recorded input preview', () => {
    test('shows a compact JSON body, form or schedule question', () => {
        const webhook = JSON.stringify({ webhook: { body: { event: 'bake', loaf: 'rye' }, headers: { authorization: 'nope' }, query: {} } })
        expect(inputPreview(webhook)).toBe('{"event":"bake","loaf":"rye"}')
        expect(inputPreview(JSON.stringify({ form: { loaf: 'rye' } }))).toBe('{"loaf":"rye"}')
        expect(inputPreview(JSON.stringify({ question: 'Run the daily report' }))).toBe('"Run the daily report"')
        const shared = (page, event, token) =>
            JSON.stringify({
                webhook: { body: { event: 'bake' }, query: { page }, headers: { 'x-github-event': event, authorization: token } }
            })
        const first = shared('1', 'push', 'Bearer one')
        const second = shared('2', 'release', 'Bearer sekret')
        expect(inputPreview(second, undefined, [first, second])).toContain('query {"page":"2"}')
        expect(inputPreview(second, undefined, [first, second])).toContain('x-github-event: release')
        expect(inputPreview(second, undefined, [first, second])).toContain('authorization: [REDACTED]')
        expect(inputPreview(second, undefined, [first, second])).not.toContain('sekret')
        const nested = (name, secret) =>
            JSON.stringify({
                webhook: {
                    body: { event: 'bake' },
                    query: { user: { password: 's3cret', name } },
                    headers: { 'x-extra': { user: { password: secret } } }
                }
            })
        const nestedPreview = inputPreview(nested('ada', 'header-secret'), undefined, [
            nested('ada', 'header-secret'),
            nested('bea', 'other-secret')
        ])
        expect(nestedPreview).toContain('[REDACTED]')
        expect(nestedPreview).toContain('ada')
        expect(nestedPreview).not.toContain('s3cret')
        expect(nestedPreview).not.toContain('header-secret')
        const long = JSON.stringify({ form: { note: 'x'.repeat(200) } })
        expect(inputPreview(long, 20).endsWith('…')).toBe(true)
        expect(inputPreview(long, 20).length).toBe(21)
        expect(noPastRunsMessage('form')).toBe(NO_PAST_RUNS.form)
        expect(noPastRunsMessage('webhook')).toBe('No past runs exist yet. Call the webhook once, then check again.')
        expect(noPastRunsMessage('schedule')).toBe('No past runs exist yet. Wait for the schedule, or trigger it once, then check again.')
        expect(noPastRunsMessage('form')).toBe('No past runs exist yet. Submit the form once, then check again.')
        expect(noPastRunsMessage()).toBe('')
        expect(noPastRunsMessage('other')).toBe('')
        expect(checkTitle('questions')).toBe(CHECK_TITLE)
        expect(checkTitle('runs')).toBe(CHECK_RUNS_TITLE)
        expect(checkTitle(null)).toBe('Check')
        expect(loadingText('questions')).toBe('Loading recent questions…')
        expect(loadingText('runs')).toBe('Loading recent runs…')
        expect(loadingText(null)).toBe(LOADING_UNKNOWN)
        const webhookCanvas = JSON.stringify({
            nodes: [{ data: { name: 'startAgentflow', inputs: { startInputType: 'webhookTrigger' } } }]
        })
        const chatCanvas = JSON.stringify({
            nodes: [{ data: { name: 'startAgentflow', inputs: { startInputType: 'chatInput' } } }]
        })
        expect(canvasStartType(webhookCanvas)).toBe('webhookTrigger')
        expect(checkKind('AGENTFLOW', [webhookCanvas, webhookCanvas])).toBe('runs')
        expect(checkKind('AGENTFLOW', [chatCanvas, chatCanvas])).toBe('questions')
        expect(checkKind('CHATFLOW', [chatCanvas])).toBe('questions')
        expect(checkKind('AGENTFLOW', [webhookCanvas, chatCanvas])).toBeNull()
        expect(checkKind('AGENTFLOW', ['{'])).toBeNull()
        expect(checkKind()).toBeNull()
        expect(countPickerLabel({ replayInputs: true, requested: 4, available: 4 })).toBe('Past runs')
        expect(countPickerLabel({ replayInputs: true, requested: 4, available: 2 })).toBe('Requested runs')
        expect(countPickerLabel({ replayInputs: false, requested: 50, available: 37 })).toBe('Requested questions')
        expect(countPickerLabel({ replayInputs: false, requested: 4, available: 10 })).toBe('Past questions')
        const when = formatListDateTime('2026-10-08T11:00:00.000Z')
        expect(inputMeta('webhook', '2026-10-08T11:00:00.000Z')).toBe(`Webhook · ${when}`)
        expect(inputMeta('form', '2026-10-08T11:00:00.000Z')).toBe(`Form · ${when}`)
        expect(inputMeta('schedule', '')).toBe('Schedule')
    })
})

describe('questions to check', () => {
    test('suggested questions are ticked up to the limit', () => {
        const list = initialPicks(
            Array.from({ length: 12 }, (_, i) => ({ text: `q${i}` })),
            10
        )
        expect(list).toHaveLength(12)
        expect(pickedQuestions(list)).toHaveLength(10)
        expect(list[11]).toEqual({ text: 'q11', picked: false, added: false, starter: false })
    })

    test('starter questions offered for a new flow stay marked', () => {
        expect(initialPicks([{ text: 'Hi', date: '', starter: true }])).toEqual([{ text: 'Hi', picked: true, added: false, starter: true }])
    })

    test('ticking stops at the limit; unticking always works', () => {
        let list = initialPicks([{ text: 'a' }, { text: 'b' }, { text: 'c' }], 2)
        expect(togglePick(list, 2, 2)).toBe(list)
        list = togglePick(list, 0, 2)
        expect(pickedQuestions(list)).toEqual(['b'])
        list = togglePick(list, 2, 2)
        expect(pickedQuestions(list)).toEqual(['b', 'c'])
        expect(togglePick(list, 9, 2)).toBe(list)
    })

    test('adding your own question: trims, refuses repeats and long text, adds unticked when full', () => {
        const list = initialPicks([{ text: 'What are your hours?' }], 10)
        expect(addQuestion(list, '   ', limits)).toEqual({ list, error: '' })
        expect(addQuestion(list, '  what are   your hours? ', limits).error).toBe('That question is already in the list.')
        expect(addQuestion(list, 'x'.repeat(2001), limits).error).toBe('A question can be at most 2,000 characters.')
        const added = addQuestion(list, ' Do you deliver? ', limits)
        expect(added.error).toBe('')
        expect(added.list[1]).toEqual({ text: 'Do you deliver?', picked: true, added: true })
        const full = addQuestion(list, 'Another one', { ...limits, maxQuestions: 1 })
        expect(full.list[1].picked).toBe(false)
        expect(full.error).toBe('Untick a question first. A check asks at most 1.')
    })
})

describe('cost and risk', () => {
    test('the cost note says it uses the model, costs tokens, and states the caps', () => {
        expect(costNote(limits, 3)).toBe(
            'Each question runs twice, once on Live and once on your draft, so the check uses the model and costs tokens. That is 6 runs for 3 questions. A check stops at 100,000 tokens or 3 minutes, whichever comes first.'
        )
        expect(costNote({ maxTokens: 1000, maxSeconds: 45 }, 1)).toContain(
            'That is 2 runs for 1 question. A check stops at 1,000 tokens or 45 seconds'
        )
        expect(costNote(limits, 0)).not.toContain('That is')
    })

    test('risky steps are named and need run anyway', () => {
        const steps = [
            { id: 'a', label: 'Custom JS Function' },
            { id: 'postProcessing', label: 'Post-processing code' }
        ]
        expect(riskyWarning([])).toBe('')
        expect(riskyWarning(steps)).toContain('could send, write or post something for real: Custom JS Function, Post-processing code.')
        expect(canRunCheck({ picked: 2, riskySteps: steps })).toBe(false)
        expect(canRunCheck({ picked: 2, riskySteps: steps, runAnyway: true })).toBe(true)
        expect(canRunCheck({ picked: 0 })).toBe(false)
        expect(canRunCheck({ picked: 1, running: true })).toBe(false)
        expect(canRunCheck({ picked: 1, unavailable: { code: 'no-draft' } })).toBe(false)
        expect(canRunCheck({ picked: 1 })).toBe(true)
    })
})

describe('results', () => {
    const live = { text: 'MANGO', error: null, tokens: 44, ms: 657 }
    const draft = { text: 'PAPAYA', error: null, tokens: 45, ms: 1525 }

    test('times and captions', () => {
        expect(formatMs(657)).toBe('0.7 s')
        expect(formatMs(20)).toBe('0.1 s')
        expect(formatMs(1525)).toBe('1.5 s')
        expect(formatMs(null)).toBe('')
        expect(sideCaption(live)).toBe('44 tokens, 0.7 s')
        expect(sideCaption({ text: 'x', tokens: 1, ms: 100 })).toBe('1 token, 0.1 s')
        expect(sideCaption({ text: null, error: 'Stopped.', tokens: null, ms: 300 })).toBe('0.3 s')
        expect(sideCaption(null)).toBe('')
    })

    test('badges per question', () => {
        expect(caseBadge({ live, draft, same: false }).label).toBe('Changed')
        expect(caseBadge({ live, draft: live, same: true }).label).toBe('Same')
        expect(caseBadge({ live, draft: { ...draft, text: null, error: 'Took too long, so it was stopped.' }, same: false }).label).toBe(
            'Error'
        )
        expect(caseBadge({ live, draft: null, same: null }).label).toBe('Waiting')
    })

    test('progress, summary, usage and stop reasons in plain words', () => {
        const running = {
            status: 'running',
            total: 4,
            completed: 1,
            cases: [
                { question: 'a', live, draft },
                { question: 'b', live: null, draft: null }
            ]
        }
        expect(progressText(running)).toBe('Asked 1 of 4…')
        expect(progressText(running, 'run')).toBe('Ran 1 of 4…')
        expect(progressText({ status: 'running', total: 2, completed: 2 })).toBe('Asked 2 of 2…')
        expect(progressText({ status: 'running', total: 2, completed: 2 }, 'run')).toBe('Ran 2 of 2…')
        expect(visibleCases(running)).toHaveLength(2)
        const done = {
            status: 'done',
            cases: [
                { question: 'a', live, draft },
                { question: 'b', live: null, draft: null }
            ],
            summary: { ran: 4, same: 1, changed: 2, errors: 1, liveTokens: 1840, draftTokens: 188, liveMedianMs: 605, draftMedianMs: 524 }
        }
        expect(visibleCases(done)).toHaveLength(1)
        expect(summaryText(done)).toBe('2 of 4 answered differently, 1 of 4 answered the same, 1 had an error.')
        expect(usageText(done)).toBe(
            'Tokens: Live 1,840, draft 188 (Draft used 1,652 fewer). Typical time: Live 0.6 s, draft 0.5 s (Draft was 0.1 s faster).'
        )
        const priced = {
            ...done,
            summary: {
                ...done.summary,
                liveEstimatedCostUsd: 0.0012,
                draftEstimatedCostUsd: null,
                livePrice: 'known',
                draftPrice: 'no price'
            },
            cases: [{ question: 'a', live: { ...live, estimatedCostUsd: 0.0012, price: 'known' }, draft }]
        }
        expect(usageText(priced)).toContain('Estimated cost: Live estimated $0.0012, draft no price.')
        expect(sideCaption(priced.cases[0].live)).toBe('44 tokens, 0.7 s, estimated $0.0012')
        expect(summaryText({ status: 'stopped', summary: { ran: 0 } })).toBe('No question was answered by both versions.')
        expect(summaryText({ status: 'stopped', summary: { ran: 0 } }, CHECK_WORDS.publish, 'run')).toBe(
            'No recorded input was answered by both versions.'
        )
        expect(usageText({ summary: { ran: 0 } })).toBe('')
        expect(usageText(done, CHECK_WORDS.promote)).toBe(
            'Tokens: Live 1,840, from Dev 188 (From Dev used 1,652 fewer). Typical time: Live 0.6 s, from Dev 0.5 s (From Dev was 0.1 s faster).'
        )
        expect(promoteCheckWords('Dev')).toBe(CHECK_WORDS.promote)
        expect(promoteCheckWords('dev').side).toBe('From Dev')
        expect(promoteCheckWords().side).toBe('From Dev')
        const staging = promoteCheckWords('Staging')
        expect(staging.side).toBe('From Staging')
        expect(staging.short).toBe('from Staging')
        expect(staging.yours).toBe('the version from Staging')
        expect(staging.intro).not.toContain('Dev')
        expect(staging.changed).toBe('A newer version arrived from Staging after this check ran. Run it again to check it.')
        expect(usageText(done, staging)).toContain('From Staging')
        expect(passRateText({ summary: { scores: { draft: { passed: 1, failed: 0, errored: 0, passRate: 100 } } } }, staging)).toEqual([
            'From Staging pass rate: 100% (1 passed, 0 failed, 0 errored).'
        ])
        expect(stopReasonText('tokens')).toBe('Stopped at the token limit. These are the questions answered so far.')
        expect(stopReasonText('time')).toBe('Stopped at the time limit. These are the questions answered so far.')
        expect(stopReasonText('stopped')).toBe('You stopped the check. These are the questions answered so far.')
        expect(stopReasonText('tokens', 'run')).toBe('Stopped at the token limit. These are the runs answered so far.')
        expect(stopReasonText('time', 'run')).toBe('Stopped at the time limit. These are the runs answered so far.')
        expect(stopReasonText('stopped', 'run')).toBe('You stopped the check. These are the runs answered so far.')
        expect(stopReasonText(null)).toBe('')
        expect(stopReasonText(null, 'run')).toBe('')
        expect(compareListLabel(false)).toBe('Questions to compare')
        expect(compareListLabel(true)).toBe('Runs to compare')
        expect(loadFailureMessage('questions')).toBe('Recent questions could not be loaded.')
        expect(loadFailureMessage('runs')).toBe('Recent runs could not be loaded.')
        expect(loadFailureMessage(null)).toBe('The check could not be loaded.')
    })

    test('a flow never published runs each question once, on the draft', () => {
        expect(costNote(limits, 3, CHECK_WORDS.publish, true)).toMatch(
            /^Live is empty, so each question runs once, on your draft, and the check costs tokens\. That is 3 runs\./
        )
        const check = {
            status: 'done',
            liveEmpty: true,
            summary: { ran: 3, same: 0, changed: 0, errors: 1, liveTokens: 0, draftTokens: 900, liveMedianMs: null, draftMedianMs: 1200 }
        }
        expect(summaryText(check)).toBe('2 of 3 answered on your draft, 1 had an error.')
        expect(usageText(check)).toBe('Tokens: draft 900. Typical time: 1.2 s.')
        expect(caseBadge({ live: null, draft: { text: 'Hi' } }, true)).toEqual({ label: 'Answered', color: 'success' })
        expect(caseBadge({ live: null, draft: { error: 'boom' } }, true)).toEqual({ label: 'Error', color: 'error' })
        expect(caseBadge({ live: null, draft: null }, true)).toEqual({ label: 'Waiting', color: 'default' })
        expect(summaryText({ status: 'done', liveEmpty: true, summary: { ran: 0 } })).toBe('No question was answered on your draft.')
        expect(summaryText({ status: 'done', liveEmpty: true, summary: { ran: 0 } }, CHECK_WORDS.publish, 'run')).toBe(
            'No recorded input was answered on your draft.'
        )
        expect(summaryText({ status: 'done', liveEmpty: true, summary: { ran: 0 } }, CHECK_WORDS.promote, 'run')).toBe(
            'No recorded input was answered on the version from Dev.'
        )
    })

    test('a pass rate line is shown per side when evaluators ran', () => {
        const scores = {
            live: { passed: 1, failed: 1, errored: 0, passRate: 50 },
            draft: { passed: 2, failed: 0, errored: 0, passRate: 100 }
        }
        expect(passRateText({ summary: { scores } })).toEqual([
            'Live pass rate: 50% (1 passed, 1 failed, 0 errored).',
            'Draft pass rate: 100% (2 passed, 0 failed, 0 errored).'
        ])
        expect(passRateText({ liveEmpty: true, summary: { scores } }, CHECK_WORDS.publish)).toEqual([
            'Draft pass rate: 100% (2 passed, 0 failed, 0 errored).'
        ])
        expect(passRateText({ summary: { ran: 1 } })).toEqual([])
        expect(verdictText({})).toBe('')
        expect(
            verdictText({
                verdict: { result: 'failed', threshold: 100, passRate: 50, passed: 1, failed: 0, errored: 1 }
            })
        ).toBe('failed at 50% (threshold 100%). 1 passed, 0 failed, 1 errored.')
        expect(canRunCheck({ source: 'dataset', datasetId: '', picked: 0 })).toBe(false)
        expect(canRunCheck({ source: 'dataset', datasetId: 'ds-1', picked: 0 })).toBe(true)
    })

    test('copy is plain words, with no section mark and no engineering terms', () => {
        const text = Object.values(copy)
            .filter((v) => typeof v === 'string')
            .concat(Object.values(NO_PAST_RUNS))
            .join(' ')
        expect(CHECK_TITLE).toBe('Check recent questions')
        expect(CHECK_RUNS_TITLE).toBe('Check recent runs')
        expect(CHECK_INTRO).toContain('This is optional.')
        expect(passMarkNumber('')).toBeNull()
        expect(passMarkNumber('   ')).toBeNull()
        expect(passMarkNumber('1.5')).toBeNull()
        expect(passMarkNumber(101)).toBeNull()
        expect(passMarkNumber('0')).toBe(0)
        expect(passMarkNumber(0)).toBe(0)
        expect(passMarkNumber('80')).toBe(80)
        expect(text.includes('\u00a7')).toBe(false)
        expect(/\b(git|commit|branch|sha|replay|endpoint|API)\b/i.test(text)).toBe(false)
    })
})

describe('a gate run poll', () => {
    test('follows the server time limit, including 1800 seconds', () => {
        expect(gatePollBudgetMs({ maxSeconds: 1800 })).toBe(1800 * 1000 + POLL_MS)
        expect(gatePollBudgetMs({ maxSeconds: 180 })).toBe(180 * 1000 + POLL_MS)
        expect(gatePollBudgetMs(undefined)).toBe(1800 * 1000 + POLL_MS)
        expect(gatePollBudgetMs({ maxSeconds: 0 })).toBe(1800 * 1000 + POLL_MS)
    })

    test('keeps polling past 200 reads while the check is still running', async () => {
        let reads = 0
        const view = await pollGateCheck({
            view: { status: 'running', limits: { maxSeconds: 1800 } },
            now: () => 0,
            sleep: async () => {},
            read: async () => {
                reads += 1
                return reads < 250 ? { status: 'running', limits: { maxSeconds: 1800 } } : { status: 'done', id: 'c1' }
            }
        })
        expect(reads).toBe(250)
        expect(view).toEqual({ status: 'done', id: 'c1' })
    })

    test('stops at the server time limit, and a closed dialog stops polling without another read', async () => {
        let reads = 0
        const start = 1000
        let clock = start
        const limited = await pollGateCheck({
            view: { status: 'running', limits: { maxSeconds: 10 } },
            pollMs: 1000,
            now: () => clock,
            sleep: async () => {
                clock += 1000
            },
            read: async () => {
                reads += 1
                return { status: 'running', limits: { maxSeconds: 10 } }
            }
        })
        expect(limited.status).toBe('running')
        expect(reads).toBe(11)
        expect(clock).toBe(start + 11 * 1000)

        let afterClose = 0
        const closed = await pollGateCheck({
            view: { status: 'running', id: 'c1', limits: { maxSeconds: 1800 } },
            now: () => 0,
            sleep: async () => {},
            shouldStop: () => true,
            read: async () => {
                afterClose += 1
                return { status: 'done' }
            }
        })
        expect(afterClose).toBe(0)
        expect(closed).toEqual({ status: 'running', id: 'c1', limits: { maxSeconds: 1800 } })
    })
})

describe('who can choose stored questions', () => {
    const chatStart = JSON.stringify({
        nodes: [{ data: { name: 'startAgentflow', inputs: { startInputType: 'chatInput' } } }]
    })
    const formStart = JSON.stringify({
        nodes: [{ data: { name: 'startAgentflow', inputs: { startInputType: 'formInput' } } }]
    })

    test('a harness and a recorded-input start cannot pick ids', () => {
        expect(canPickQuestionIds('CHATFLOW', [])).toBe(true)
        expect(canPickQuestionIds('AGENTFLOW', [chatStart, chatStart])).toBe(true)
        expect(canPickQuestionIds('HARNESS', [])).toBe(false)
        expect(canPickQuestionIds('AGENTFLOW', [formStart, formStart])).toBe(false)
    })
})

describe('choosing stored questions', () => {
    const loaf = (id, text, extra = {}) => ({ id, text, replayable: true, ...extra })

    test('select all shown stops at the cap and leaves a file question alone', () => {
        const items = [
            loaf('a', 'rye'),
            loaf('b', 'wheat'),
            loaf('c', 'scan', { replayable: false, reason: 'files' }),
            loaf('d', 'sourdough')
        ]
        const selected = selectShown({ items, selected: [loaf('a', 'rye')], cap: 2, typedPicked: 0 })
        expect(selected.map((item) => item.id)).toEqual(['a', 'b'])
        const full = selectShown({ items, selected, cap: 2, typedPicked: 0 })
        expect(full).toEqual(selected)
        expect(chosenLabel(2, 100)).toBe('2 of 100 chosen')
        expect(historyReasonText('files')).toContain('file')
        expect(historyReasonText('length')).toContain('2,000')
    })

    test('typed questions share the cap with or without a stored question', () => {
        expect(typedRoom({ cap: 100, selectedCount: 0, typedPicked: 10 })).toBe(90)
        expect(typedRoom({ cap: 100, selectedCount: 1, typedPicked: 10 })).toBe(89)
        expect(chooseRoom({ cap: 100, selectedCount: 98, typedPicked: 2 })).toBe(0)
        const kept = toggleHistoryPick({
            item: loaf('z', 'extra'),
            selected: [loaf('a', 'rye')],
            cap: 3,
            typedPicked: 2
        })
        expect(kept).toHaveLength(1)
        const added = toggleHistoryPick({ item: loaf('z', 'extra'), selected: [], cap: 3, typedPicked: 1 })
        expect(added.map((item) => item.id)).toEqual(['z'])
        const removed = toggleHistoryPick({ item: loaf('z', 'extra'), selected: added, cap: 3, typedPicked: 1 })
        expect(removed).toEqual([])
        expect(hiddenChosenCount([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }])).toBe(1)
    })

    test('switching from the count picker with more than 10 typed questions sends an empty id list', () => {
        const typed = Array.from({ length: 11 }, (_, index) => ({ text: `loaf ${index}`, picked: true, added: true }))
        const questions = typed.map((item) => item.text)
        expect(typedToggleLimit({ cap: 100, selectedCount: 0 })).toBe(100)
        const opened = togglePick([...typed, { text: 'one more', picked: false, added: true }], typed.length, typedToggleLimit())
        expect(opened.at(-1).picked).toBe(true)
        expect(chooseRunBody({ selected: [], questions })).toEqual({ questionIds: [], questions })
    })

    test('ticking a stored question uses the shared cap, and unticking it restores the full cap', () => {
        const stored = loaf('chat:a', 'rye loaf')
        const typed = Array.from({ length: 99 }, (_, index) => ({ text: `loaf ${index}`, picked: true, added: true }))
        const extra = { text: 'one more loaf', picked: false, added: true }
        const ticked = toggleHistoryPick({ item: stored, selected: [], cap: 100, typedPicked: typed.length })
        expect(ticked).toEqual([{ id: stored.id, text: stored.text }])
        expect(typedToggleLimit({ cap: 100, selectedCount: ticked.length })).toBe(99)
        const blocked = togglePick([...typed, extra], typed.length, typedToggleLimit({ cap: 100, selectedCount: ticked.length }))
        expect(blocked.at(-1).picked).toBe(false)
        const unticked = toggleHistoryPick({ item: stored, selected: ticked, cap: 100, typedPicked: typed.length })
        expect(unticked).toEqual([])
        expect(typedToggleLimit({ cap: 100, selectedCount: unticked.length })).toBe(100)
        const allowed = togglePick([...typed, extra], typed.length, typedToggleLimit({ cap: 100, selectedCount: unticked.length }))
        expect(allowed.at(-1).picked).toBe(true)
        expect(chooseRunBody({ selected: unticked, questions: allowed.filter((item) => item.picked).map((item) => item.text) })).toEqual({
            questionIds: [],
            questions: allowed.filter((item) => item.picked).map((item) => item.text)
        })
    })
})
