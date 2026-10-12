// Plain-words helpers for the publish check in the Publish dialog: recent questions asked again,
// against Live and the draft, side by side. The check is optional and never blocks Publish.

// The dialog offers these. The server accepts any whole number from 1 to 100 and clamps it.
export const COMPARE_COUNTS = [4, 10, 25, 50, 100]
export const DEFAULT_COMPARE_COUNT = 4
// The same page size as the app's lists (12 rows), then Show more.
export const RESULT_PAGE_SIZE = 12

export const CHECK_TITLE = 'Check recent questions'
export const CHECK_INTRO =
    'Ask recent questions again, on Live and on your draft, and compare the answers before you publish. This is optional.'
export const NO_PAST_RUNS = 'No past runs to replay yet. Run this flow once, then check again.'
export const INPUT_PREVIEW_CHARS = 180
export const CHECK_VARY_NOTE = 'Answers from a model can vary a little between runs, even with no change.'
export const CHECK_CLOSE_NOTE = 'Closing this window or publishing stops a check that is still running.'
export const RUN_ANYWAY_LABEL = 'Run it anyway, including those steps'
export const POLL_MS = 1000
export const DRAFT_CHANGED_NOTE = 'The draft changed after this check ran. Run it again to see answers from the current draft.'

// The words that differ between the publish check (Live against the draft) and the promote check (Live
// against the new version from Dev).
export const CHECK_WORDS = {
    publish: {
        side: 'Draft',
        short: 'draft',
        yours: 'your draft',
        intro: CHECK_INTRO,
        introNew: 'Ask questions on your draft before you publish. Live is empty until the first publish. This is optional.',
        introInputs: 'Run recent inputs again on Live and on your draft, and compare the answers before you publish. This is optional.',
        introInputsNew:
            'Run recent inputs again on your draft before you publish. Live is empty until the first publish. This is optional.',
        emptyLive: 'Empty until the first publish',
        closeNote: CHECK_CLOSE_NOTE,
        optional: 'Publish works with or without a check.',
        changed: DRAFT_CHANGED_NOTE,
        stillCan: 'You can still publish.'
    },
    promote: {
        side: 'From Dev',
        short: 'from Dev',
        yours: 'the version from Dev',
        intro: 'Ask recent questions again, on Live and on the version from Dev, and compare the answers before you promote. This is optional.',
        introNew: 'Ask questions on the version from Dev before you promote. Live is empty until the first promote. This is optional.',
        introInputs:
            'Run recent inputs again on Live and on the version from Dev, and compare the answers before you promote. This is optional.',
        introInputsNew:
            'Run recent inputs again on the version from Dev before you promote. Live is empty until the first promote. This is optional.',
        emptyLive: 'Empty until the first promote',
        closeNote: 'Leaving this page or promoting stops a check that is still running.',
        optional: 'Promote works with or without a check.',
        changed: 'A newer version arrived from Dev after this check ran. Run it again to check it.',
        stillCan: 'You can still promote.'
    }
}

// Fewer past questions than the choice: say so, and compare every one we have.
// `unit` is `run` when the check replays recorded inputs instead of questions. The default keeps the question wording.
export const capMessage = (choice, available, truncated = false, unit = 'question') => {
    const wanted = Number(choice) || 0
    const have = Number(available) || 0
    if (wanted <= 0 || have <= 0 || have >= wanted) return ''
    const noun = unit === 'run' ? 'run' : 'question'
    const nouns = unit === 'run' ? 'runs' : 'questions'
    const comparing = have === 1 ? `Comparing that ${noun}.` : `Comparing all ${have}.`
    if (truncated) {
        const label = have === 1 ? `past ${noun}` : `past ${nouns}`
        const looked = unit === 'run' ? 'recent executions' : 'recent messages'
        return `Only ${have} distinct ${label} in the ${looked} we looked at. ${comparing}`
    }
    if (have === 1) return `Only 1 past ${noun} available. ${comparing}`
    return `Only ${have} past ${nouns} available. ${comparing}`
}

// Compact JSON for a recorded input. Webhook rows show the body. A plain schedule question is shown as JSON text.
export const inputPreview = (text, max = INPUT_PREVIEW_CHARS) => {
    let value = text
    try {
        value = JSON.parse(text)
    } catch {
        /* show the stored text */
    }
    const payload = value && typeof value === 'object' ? value.webhook?.body ?? value.form ?? value.question ?? value : value
    const shown = typeof payload === 'string' ? JSON.stringify(payload) : JSON.stringify(payload)
    if (!shown) return '(empty input)'
    return shown.length > max ? `${shown.slice(0, max)}…` : shown
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

const number = (n) => Number(n || 0).toLocaleString('en-US')

// Tick every suggested question, up to the limit.
// A new flow nobody has asked anything offers its starter questions instead; they are marked as such.
export const initialPicks = (questions = [], max = 10) =>
    questions.map((q, index) => ({ text: q.text, picked: index < max, added: false, starter: Boolean(q.starter) }))

export const pickedQuestions = (list = []) => list.filter((q) => q.picked).map((q) => q.text)

export const togglePick = (list, index, max = 10) => {
    const target = list[index]
    if (!target) return list
    if (!target.picked && pickedQuestions(list).length >= max) return list
    return list.map((q, i) => (i === index ? { ...q, picked: !q.picked } : q))
}

// Adds your own question. Returns the new list, or an error to show under the box.
export const addQuestion = (list, text, { maxQuestions = 10, maxQuestionChars = 2000 } = {}) => {
    const value = String(text || '').trim()
    if (!value) return { list, error: '' }
    if (value.length > maxQuestionChars) return { list, error: `A question can be at most ${number(maxQuestionChars)} characters.` }
    const key = value.toLowerCase().replace(/\s+/g, ' ')
    if (list.some((q) => q.text.toLowerCase().replace(/\s+/g, ' ') === key)) return { list, error: 'That question is already in the list.' }
    const room = pickedQuestions(list).length < maxQuestions
    return {
        list: [...list, { text: value, picked: room, added: true }],
        error: room ? '' : `Untick a question first. A check asks at most ${maxQuestions}.`
    }
}

export const minutes = (seconds) => {
    const s = Number(seconds || 0)
    if (s < 60) return plural(s, 'second', 'seconds')
    const m = Math.round((s / 60) * 10) / 10
    return plural(m, 'minute', 'minutes')
}

// With an empty Live (never published) each question runs once, on the draft.
// `unit` is `run` when each row is a recorded input. The default keeps the question wording.
export const costNote = (limits = {}, picked = 0, words = CHECK_WORDS.publish, liveEmpty = false, unit = 'question') => {
    const one = unit === 'run' ? 'recorded input' : 'question'
    const many = unit === 'run' ? 'recorded inputs' : 'questions'
    if (liveEmpty) {
        const once = picked ? ` That is ${plural(picked, 'run', 'runs')}.` : ''
        return `Live is empty, so each ${one} runs once, on ${words.yours}, and the check costs tokens.${once} A check stops at ${number(
            limits.maxTokens
        )} tokens or ${minutes(limits.maxSeconds)}, whichever comes first.`
    }
    const runs = picked * 2
    const runsText = picked ? ` That is ${plural(runs, 'run', 'runs')} for ${plural(picked, one, many)}.` : ''
    return `Each ${one} runs twice, once on Live and once on ${
        words.yours
    }, so the check uses the model and costs tokens.${runsText} A check stops at ${number(limits.maxTokens)} tokens or ${minutes(
        limits.maxSeconds
    )}, whichever comes first.`
}

export const riskyWarning = (steps = []) =>
    steps.length
        ? `This flow has steps that could send, write or post something for real: ${steps
              .map((s) => s.label)
              .join(', ')}. The check would repeat them, so it skips this flow unless you choose to run it anyway.`
        : ''

export const canRunCheck = ({ picked = 0, riskySteps = [], runAnyway = false, running = false, unavailable = null }) =>
    !unavailable && !running && picked > 0 && (riskySteps.length === 0 || runAnyway)

export const formatMs = (ms) => {
    if (ms == null) return ''
    return `${(Math.max(1, Math.round(ms / 100)) / 10).toFixed(1)} s`
}

// "44 tokens, 0.7 s" under each answer.
export const sideCaption = (side) => {
    if (!side) return ''
    const parts = []
    if (side.tokens != null) parts.push(plural(side.tokens, 'token', 'tokens'))
    if (side.ms != null) parts.push(formatMs(side.ms))
    return parts.join(', ')
}

export const caseBadge = (c, liveEmpty = false) => {
    if (liveEmpty) {
        if (!c?.draft) return { label: 'Waiting', color: 'default' }
        return c.draft.error ? { label: 'Error', color: 'error' } : { label: 'Answered', color: 'success' }
    }
    if (!c?.live || !c?.draft) return { label: 'Waiting', color: 'default' }
    if (c.live.error || c.draft.error) return { label: 'Error', color: 'error' }
    return c.same ? { label: 'Same', color: 'success' } : { label: 'Changed', color: 'warning' }
}

export const progressText = (check) => {
    if (!check) return ''
    const done = Math.min(Number(check.completed) || 0, Number(check.total) || 0)
    return `Asked ${done} of ${check.total}…`
}

const tokenChange = (live, draft, side) => {
    if (live == null || draft == null) return ''
    const delta = Number(draft) - Number(live)
    if (!delta) return ''
    const amount = number(Math.abs(delta))
    return delta < 0 ? ` (${side} used ${amount} fewer)` : ` (${side} used ${amount} more)`
}

const timeChange = (live, draft, side) => {
    if (live == null || draft == null) return ''
    const delta = Number(draft) - Number(live)
    if (!delta) return ''
    const amount = formatMs(Math.abs(delta))
    return delta < 0 ? ` (${side} was ${amount} faster)` : ` (${side} was ${amount} slower)`
}

export const stopReasonText = (reason) => {
    if (reason === 'tokens') return 'Stopped at the token limit. These are the questions answered so far.'
    if (reason === 'time') return 'Stopped at the time limit. These are the questions answered so far.'
    if (reason === 'stopped') return 'You stopped the check. These are the questions answered so far.'
    return ''
}

export const summaryText = (check, words = CHECK_WORDS.publish) => {
    const s = check?.summary
    if (check?.liveEmpty) {
        if (!s || !s.ran) return check.status === 'running' ? '' : `No question was answered on ${words.yours}.`
        const answered = s.ran - (s.errors || 0)
        return `${answered} of ${s.ran} answered on ${words.yours}${s.errors ? `, ${s.errors} had an error` : ''}.`
    }
    if (!s || !s.ran) return check?.status === 'running' ? '' : 'No question was answered by both versions.'
    const parts = []
    if (s.changed) parts.push(`${s.changed} of ${s.ran} answered differently`)
    if (s.same) parts.push(`${s.same} of ${s.ran} answered the same`)
    if (s.errors) parts.push(`${s.errors} had an error`)
    return `${parts.join(', ')}.`
}

export const usageText = (check, words = CHECK_WORDS.publish) => {
    const s = check?.summary
    if (!s || !s.ran) return ''
    if (check.liveEmpty) return `Tokens: ${words.short} ${number(s.draftTokens)}. Typical time: ${formatMs(s.draftMedianMs)}.`
    // Token and time differences come from the totals already measured. There is no price for this check, so no cost.
    return `Tokens: Live ${number(s.liveTokens)}, ${words.short} ${number(s.draftTokens)}${tokenChange(
        s.liveTokens,
        s.draftTokens,
        words.side
    )}. Typical time: Live ${formatMs(s.liveMedianMs)}, ${words.short} ${formatMs(s.draftMedianMs)}${timeChange(
        s.liveMedianMs,
        s.draftMedianMs,
        words.side
    )}.`
}

// Which questions to show in the results: the ones answered, then the rest while running.
export const visibleCases = (check) => (check?.cases || []).filter((c) => c.live || c.draft || check.status === 'running')
