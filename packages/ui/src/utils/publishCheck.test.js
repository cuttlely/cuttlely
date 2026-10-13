import {
    CHECK_INTRO,
    CHECK_TITLE,
    COMPARE_COUNTS,
    DEFAULT_COMPARE_COUNT,
    addQuestion,
    canRunCheck,
    capMessage,
    caseBadge,
    CHECK_WORDS,
    costNote,
    formatMs,
    initialPicks,
    pickedQuestions,
    progressText,
    riskyWarning,
    sideCaption,
    passRateText,
    stopReasonText,
    summaryText,
    togglePick,
    usageText,
    visibleCases
} from './publishCheck'
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
        expect(progressText({ status: 'running', total: 2, completed: 2 })).toBe('Asked 2 of 2…')
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
        expect(summaryText({ status: 'stopped', summary: { ran: 0 } })).toBe('No question was answered by both versions.')
        expect(usageText({ summary: { ran: 0 } })).toBe('')
        expect(usageText(done, CHECK_WORDS.promote)).toBe(
            'Tokens: Live 1,840, from Dev 188 (From Dev used 1,652 fewer). Typical time: Live 0.6 s, from Dev 0.5 s (From Dev was 0.1 s faster).'
        )
        expect(stopReasonText('tokens')).toContain('token limit')
        expect(stopReasonText('time')).toContain('time limit')
        expect(stopReasonText('stopped')).toContain('You stopped the check')
        expect(stopReasonText(null)).toBe('')
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
        expect(canRunCheck({ source: 'dataset', datasetId: '', picked: 0 })).toBe(false)
        expect(canRunCheck({ source: 'dataset', datasetId: 'ds-1', picked: 0 })).toBe(true)
    })

    test('copy is plain words, with no section mark and no engineering terms', () => {
        const text = Object.values(copy)
            .filter((v) => typeof v === 'string')
            .join(' ')
        expect(CHECK_TITLE).toBe('Check recent questions')
        expect(CHECK_INTRO).toContain('This is optional.')
        expect(text.includes('\u00a7')).toBe(false)
        expect(/\b(git|commit|branch|sha|replay|endpoint|API)\b/i.test(text)).toBe(false)
    })
})
