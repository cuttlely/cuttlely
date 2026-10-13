// Plain-words helpers for the publish check in the Publish dialog: recent questions asked again,
// against Live and the draft, side by side. The check is optional and never blocks Publish.
import { formatListDateTime } from '@/utils/formatDate'

// The dialog offers these. The server accepts any whole number from 1 to 100 and clamps it.
export const COMPARE_COUNTS = [4, 10, 25, 50, 100]
export const DEFAULT_COMPARE_COUNT = 4
// The same page size as the app's lists (12 rows), then Show more.
export const RESULT_PAGE_SIZE = 12

export const CHECK_TITLE = 'Check recent questions'
export const CHECK_RUNS_TITLE = 'Check recent runs'
// Used while the canvases do not say whether this check replays questions or recorded runs.
export const LOADING_UNKNOWN = 'Loading the check…'

const TRIGGER_STARTS = new Set(['formInput', 'webhookTrigger', 'scheduleInput'])

// The Start node's input type, or null when this canvas has no Start node. An empty string means the
// Start node is there and its input type is blank.
export const canvasStartType = (flowData) => {
    if (!flowData) return null
    try {
        const nodes = JSON.parse(flowData)?.nodes
        if (!Array.isArray(nodes)) return null
        const start = nodes.find((node) => node?.data?.name === 'startAgentflow')
        if (!start) return null
        return String(start.data?.inputs?.startInputType || '')
    } catch {
        return null
    }
}

// 'runs' when the canvases that have a Start node share a form, webhook or schedule start.
// 'questions' for a chatflow or a chat-started agentflow. Null when the canvases do not say.
export const checkKind = (type, canvases = []) => {
    if (type && type !== 'AGENTFLOW' && type !== 'CHATFLOW') return null
    const present = (Array.isArray(canvases) ? canvases : [])
        .filter(Boolean)
        .map(canvasStartType)
        .filter((start) => start != null)
    // No type and no Start node: the canvas has not said. Promote hits this until setup returns.
    if (!type && !present.length) return null
    if (type !== 'AGENTFLOW') return 'questions'
    if (!present.length) return null
    if (TRIGGER_STARTS.has(present[0]) && present.every((start) => start === present[0])) return 'runs'
    if (present.every((start) => start === 'chatInput')) return 'questions'
    return null
}

export const checkTitle = (kind) => {
    if (kind === 'runs') return CHECK_RUNS_TITLE
    if (kind === 'questions') return CHECK_TITLE
    // The canvases have not said which noun to use. Do not claim questions or runs.
    return 'Check'
}

export const loadingText = (kind) => {
    if (kind === 'runs') return 'Loading recent runs…'
    if (kind === 'questions') return 'Loading recent questions…'
    return LOADING_UNKNOWN
}

// The setup request failed. An unknown start (From Dev, before the canvas says) does not say questions.
export const loadFailureMessage = (kind) => {
    if (kind === 'runs') return 'Recent runs could not be loaded.'
    if (kind === 'questions') return 'Recent questions could not be loaded.'
    return 'The check could not be loaded.'
}

export const compareListLabel = (replayInputs) => (replayInputs ? 'Runs to compare' : 'Questions to compare')

// The number in the picker is a request. When fewer runs or questions exist, the label says so,
// so "4" is not read as "4 past runs" next to "Only 2 past runs available".
export const countPickerLabel = ({ replayInputs = false, requested = 0, available = 0 } = {}) => {
    const clamped = Number(available) > 0 && Number(requested) > Number(available)
    if (replayInputs) return clamped ? 'Requested runs' : 'Past runs'
    return clamped ? 'Requested questions' : 'Past questions'
}
export const CHECK_INTRO =
    'Ask recent questions again, on Live and on your draft, and compare the answers before you publish. This is optional.'
// Shown when a form, webhook or schedule flow has no execution to run again. Not a refusal.
export const NO_PAST_RUNS = {
    form: 'No past runs exist yet. Submit the form once, then check again.',
    webhook: 'No past runs exist yet. Call the webhook once, then check again.',
    schedule: 'No past runs exist yet. Wait for the schedule, or trigger it once, then check again.'
}

// Only the three sentences the server returns. A missing source has no fourth sentence.
export const noPastRunsMessage = (source) => NO_PAST_RUNS[source] || ''

export const REPLAY_SOURCE_LABEL = { form: 'Form', webhook: 'Webhook', schedule: 'Schedule' }

// "Webhook · Oct 8, 2026, 11:00 AM" above a recorded input. Either half can stand alone.
export const inputMeta = (source, date) => {
    const label = REPLAY_SOURCE_LABEL[source] || ''
    const when = formatListDateTime(date)
    if (label && when) return `${label} · ${when}`
    return label || when
}
export const INPUT_PREVIEW_CHARS = 180
export const CHECK_VARY_NOTE = 'Answers from a model can vary a little between runs, even with no change.'
export const CHECK_CLOSE_NOTE = 'Closing this window or publishing stops a check that is still running.'
export const RUN_ANYWAY_LABEL = 'Run it anyway, including those steps'
export const POLL_MS = 1000

// A blank field is not 0. Only a whole number from 0 to 100 is a pass mark.
export const passMarkNumber = (value) => {
    if (typeof value === 'number') {
        if (!Number.isInteger(value) || value < 0 || value > 100) return null
        return value
    }
    const text = String(value ?? '').trim()
    if (!/^\d+$/.test(text)) return null
    const whole = Number(text)
    if (whole > 100) return null
    return whole
}
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
            'Run recent inputs from this server again, on Live and on the version from Dev, and compare the answers before you promote. This is optional.',
        introInputsNew:
            'Run recent inputs from this server again on the version from Dev before you promote. Live is empty until the first promote. This is optional.',
        emptyLive: 'Empty until the first promote',
        closeNote: 'Leaving this page or promoting stops a check that is still running.',
        optional: 'Promote works with or without a check.',
        changed: 'A newer version arrived from Dev after this check ran. Run it again to check it.',
        stillCan: 'You can still promote.'
    }
}

// The saved Dev and Prod pair keeps the From Dev column. A named list names the previous environment.
export const promoteCheckWords = (sourceTitle) => {
    const from = !sourceTitle || String(sourceTitle).toLowerCase() === 'dev' ? 'Dev' : String(sourceTitle)
    if (from === 'Dev') return CHECK_WORDS.promote
    const named = (text) => text.replaceAll('Dev', from)
    const words = CHECK_WORDS.promote
    return {
        side: named(words.side),
        short: named(words.short),
        yours: named(words.yours),
        intro: named(words.intro),
        introNew: named(words.introNew),
        introInputs: named(words.introInputs),
        introInputsNew: named(words.introInputsNew),
        emptyLive: words.emptyLive,
        closeNote: words.closeNote,
        optional: words.optional,
        changed: named(words.changed),
        stillCan: words.stillCan
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

const SENSITIVE_PARTS = ['authorization', 'cookie', 'token', 'secret', 'key', 'password', 'signature']

const isSensitiveKey = (name) => {
    const key = String(name || '').toLowerCase()
    return SENSITIVE_PARTS.some((part) => key.includes(part))
}

const maskValue = (value) => {
    if (Array.isArray(value)) return value.map((item) => maskValue(item))
    if (value && typeof value === 'object') return maskBag(value)
    return value
}

const maskBag = (bag) => {
    const masked = {}
    for (const [key, value] of Object.entries(bag || {})) masked[key] = isSensitiveKey(key) ? '[REDACTED]' : maskValue(value)
    return masked
}

const parseInput = (text) => {
    try {
        return JSON.parse(text)
    } catch {
        return null
    }
}

// Compact JSON for a recorded input. Webhook rows show the body. When `siblings` share that body,
// the line also shows the query or the header names that differ. Sensitive values are masked.
export const inputPreview = (text, max = INPUT_PREVIEW_CHARS, siblings) => {
    const value = parseInput(text)
    if (!value || typeof value !== 'object' || !value.webhook) {
        const payload = value && typeof value === 'object' ? value.form ?? value.question ?? value : value ?? text
        const shown = typeof payload === 'string' ? JSON.stringify(payload) : JSON.stringify(payload)
        if (!shown) return '(empty input)'
        return shown.length > max ? `${shown.slice(0, max)}…` : shown
    }
    const bodyText = JSON.stringify(value.webhook.body === undefined ? {} : value.webhook.body)
    const group = (Array.isArray(siblings) ? siblings : [])
        .map(parseInput)
        .filter((item) => item && item.webhook && JSON.stringify(item.webhook.body === undefined ? {} : item.webhook.body) === bodyText)
    let shown = bodyText
    if (group.length > 1) {
        const queryText = JSON.stringify(maskBag(value.webhook.query))
        const queryDiffers = group.some((item) => JSON.stringify(maskBag(item.webhook.query)) !== queryText)
        const names = new Set()
        for (const item of group) {
            const keys = new Set([...Object.keys(value.webhook.headers || {}), ...Object.keys(item.webhook.headers || {})])
            for (const key of keys) {
                if (JSON.stringify((value.webhook.headers || {})[key]) !== JSON.stringify((item.webhook.headers || {})[key])) names.add(key)
            }
        }
        const parts = [bodyText]
        if (queryDiffers) parts.push(`query ${queryText}`)
        if (names.size) {
            const headers = [...names].sort().map((name) => {
                const entry = (value.webhook.headers || {})[name]
                if (entry === undefined) return name
                const shownEntry = maskValue(entry)
                return isSensitiveKey(name)
                    ? `${name}: [REDACTED]`
                    : `${name}: ${typeof shownEntry === 'string' ? shownEntry : JSON.stringify(shownEntry)}`
            })
            parts.push(`headers ${headers.join(', ')}`)
        }
        shown = parts.join(' ')
    }
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

export const canRunCheck = ({
    picked = 0,
    riskySteps = [],
    runAnyway = false,
    running = false,
    unavailable = null,
    source = 'recent',
    datasetId = ''
}) => !unavailable && !running && (source === 'dataset' ? Boolean(datasetId) : picked > 0) && (riskySteps.length === 0 || runAnyway)

export const formatMs = (ms) => {
    if (ms == null) return ''
    return `${(Math.max(1, Math.round(ms / 100)) / 10).toFixed(1)} s`
}

// US dollars. Small estimates keep enough digits to tell $0.0004 from zero.
export const formatUsd = (value) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return ''
    if (n === 0) return '$0'
    const abs = Math.abs(n)
    if (abs >= 0.01) return `$${n.toFixed(2)}`
    return `$${n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}`
}

export const estimatePhrase = (usd, price) => {
    if (price === 'no price') return 'no price'
    if (price === 'partial') {
        const money = formatUsd(usd)
        return money ? `estimated ${money} (some models have no price)` : 'no price'
    }
    if (price === 'known') {
        const money = formatUsd(usd)
        return money ? `estimated ${money}` : ''
    }
    return ''
}

// "44 tokens, 0.7 s, estimated $0.0012" under each answer. The dollar figure is an estimate.
export const sideCaption = (side) => {
    if (!side) return ''
    const parts = []
    if (side.tokens != null) parts.push(plural(side.tokens, 'token', 'tokens'))
    if (side.ms != null) parts.push(formatMs(side.ms))
    const estimate = estimatePhrase(side.estimatedCostUsd, side.price)
    if (estimate) parts.push(estimate)
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

export const progressText = (check, unit = 'question') => {
    if (!check) return ''
    const done = Math.min(Number(check.completed) || 0, Number(check.total) || 0)
    const verb = unit === 'run' ? 'Ran' : 'Asked'
    return `${verb} ${done} of ${check.total}…`
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

export const stopReasonText = (reason, unit = 'question') => {
    const answered = unit === 'run' ? 'runs' : 'questions'
    if (reason === 'tokens') return `Stopped at the token limit. These are the ${answered} answered so far.`
    if (reason === 'time') return `Stopped at the time limit. These are the ${answered} answered so far.`
    if (reason === 'stopped') return `You stopped the check. These are the ${answered} answered so far.`
    return ''
}

export const summaryText = (check, words = CHECK_WORDS.publish, unit = 'question') => {
    const s = check?.summary
    const none = unit === 'run' ? 'recorded input' : 'question'
    if (check?.liveEmpty) {
        if (!s || !s.ran) return check.status === 'running' ? '' : `No ${none} was answered on ${words.yours}.`
        const answered = s.ran - (s.errors || 0)
        return `${answered} of ${s.ran} answered on ${words.yours}${s.errors ? `, ${s.errors} had an error` : ''}.`
    }
    if (!s || !s.ran) return check?.status === 'running' ? '' : `No ${none} was answered by both versions.`
    const parts = []
    if (s.changed) parts.push(`${s.changed} of ${s.ran} answered differently`)
    if (s.same) parts.push(`${s.same} of ${s.ran} answered the same`)
    if (s.errors) parts.push(`${s.errors} had an error`)
    return `${parts.join(', ')}.`
}

const estimateClause = (usd, price, label) => {
    const phrase = estimatePhrase(usd, price)
    return phrase ? `${label} ${phrase}` : ''
}

// One line per side. Absent when the check did not use evaluators.
export const passRateText = (check, words = CHECK_WORDS.publish) => {
    const scores = check?.summary?.scores
    if (!scores) return []
    const line = (label, side) => {
        if (!side) return ''
        const rate = side.passRate == null ? 'no scored answers' : `${side.passRate}%`
        return `${label} pass rate: ${rate} (${side.passed} passed, ${side.failed} failed, ${side.errored} errored).`
    }
    const lines = []
    if (!check.liveEmpty) {
        const live = line('Live', scores.live)
        if (live) lines.push(live)
    }
    const draft = line(words.side, scores.draft)
    if (draft) lines.push(draft)
    return lines
}

// The draft-side pass or fail. Empty when the check did not use a dataset, or it has not finished.
export const verdictText = (check) => {
    const verdict = check?.verdict
    if (!verdict) return ''
    const rate = verdict.passRate == null ? 'unscored' : `${verdict.passRate}%`
    const word = verdict.result === 'passed' ? 'passed' : 'failed'
    return `${word} at ${rate} (threshold ${verdict.threshold}%). ${verdict.passed} passed, ${verdict.failed} failed, ${verdict.errored} errored.`
}

export const usageText = (check, words = CHECK_WORDS.publish) => {
    const s = check?.summary
    if (!s || !s.ran) return ''
    const draftEstimate = estimateClause(s.draftEstimatedCostUsd, s.draftPrice, words.short)
    if (check.liveEmpty) {
        const base = `Tokens: ${words.short} ${number(s.draftTokens)}. Typical time: ${formatMs(s.draftMedianMs)}.`
        return draftEstimate ? `${base} Estimated cost: ${draftEstimate}.` : base
    }
    const liveEstimate = estimateClause(s.liveEstimatedCostUsd, s.livePrice, 'Live')
    const costs = [liveEstimate, draftEstimate].filter(Boolean).join(', ')
    const base = `Tokens: Live ${number(s.liveTokens)}, ${words.short} ${number(s.draftTokens)}${tokenChange(
        s.liveTokens,
        s.draftTokens,
        words.side
    )}. Typical time: Live ${formatMs(s.liveMedianMs)}, ${words.short} ${formatMs(s.draftMedianMs)}${timeChange(
        s.liveMedianMs,
        s.draftMedianMs,
        words.side
    )}.`
    return costs ? `${base} Estimated cost: ${costs}.` : base
}

// Which questions to show in the results: the ones answered, then the rest while running.
export const visibleCases = (check) => (check?.cases || []).filter((c) => c.live || c.draft || check.status === 'running')
