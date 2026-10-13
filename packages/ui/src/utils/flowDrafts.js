// Plain-words decisions for Draft and Publish. The canvas and the dialogs call these
// so a flow with drafts off (mode "live") keeps today's save path.

import { canvasStartType } from './publishCheck'
import { describeDiff, relativeTime } from './versionHistory'

export const STALE_DRAFT_WARNING =
    'Live changed after you started these edits (for example through the API). Publishing replaces those changes.'

export const PUBLISH_INSTANTLY_HELP = 'Every save goes live immediately, like before drafts.'
export const PUBLISH_INSTANTLY_LOCKED = 'Publish or discard the draft before changing this.'

const SKIP_DATA_KEYS = new Set(['selected', 'status', 'nodePack'])

// Draft chrome (the label and Publish) shows only while this flow actually saves to a draft.
// mode "live" covers drafts off, a flow type with no drafts, and Publish instantly.
export const showDraftChrome = (status) => status?.mode === 'draft'

export const showPublishInstantly = (status) => Boolean(status?.enabled) && status.reason !== 'off' && status.reason !== 'type'

const TRIGGER_STARTS = {
    formInput: 'a form',
    webhookTrigger: 'a webhook',
    scheduleInput: 'a schedule'
}

// A form, webhook, or schedule start cannot run a dataset check. Null when the gate can still be met.
export const datasetGateBlock = (type, canvases = []) => {
    if ((type || 'CHATFLOW') !== 'AGENTFLOW') return null
    const starts = (Array.isArray(canvases) ? canvases : [])
        .filter(Boolean)
        .map(canvasStartType)
        .filter((start) => start != null && start !== '')
    if (!starts.length || starts.every((start) => start === 'chatInput')) return null
    const which = starts.map((start) => TRIGGER_STARTS[start]).find(Boolean) || 'something other than a chat message'
    return `A dataset check asks each row as a chat message. This flow starts with ${which}, so it cannot use a dataset. Turn off the passing test set before you publish.`
}

// The passing-test gate is only for chatflows and chat-started agentflows.
export const showPublishGate = (status, type, canvases) => {
    if (!showPublishInstantly(status)) return false
    const kind = type || 'CHATFLOW'
    if (kind !== 'CHATFLOW' && kind !== 'AGENTFLOW') return false
    return !datasetGateBlock(kind, canvases)
}

export const publishInstantlyLocked = (status) => Boolean(status?.draft)

export const draftBadge = (status, now = Date.now()) => {
    if (!showDraftChrome(status)) return null
    if (status.draft) {
        const when = status.draft.updatedDate ? relativeTime(status.draft.updatedDate, now) : ''
        return {
            tone: 'draft',
            text: 'Draft, not live yet',
            short: 'Draft',
            detail: when ? `Saved ${when}` : ''
        }
    }
    return { tone: 'live', text: 'Live', short: 'Live', detail: '' }
}

export const badgeText = (badge, compact) => {
    if (!badge) return ''
    const label = compact ? badge.short : badge.text
    return badge.detail ? `${label} · ${badge.detail}` : label
}

// The canvas string to open. A draft replaces Live on the canvas; Live stays in chatflow.flowData.
export const canvasFlowText = (chatflow, status) => {
    if (status?.mode === 'draft' && typeof status.draft?.flowData === 'string' && status.draft.flowData) return status.draft.flowData
    return typeof chatflow?.flowData === 'string' ? chatflow.flowData : ''
}

// The flow the canvas test chat runs: the draft when there is one (the server runs it there too), otherwise Live.
// A flow saved only as a draft has an empty Live, and the test chat must not call it unready.
export const testChatFlow = (chatflow, status) => (chatflow ? { ...chatflow, flowData: canvasFlowText(chatflow, status) } : chatflow)

// Where a save goes. A new flow is created as today. In draft mode the canvas goes to the draft,
// and a renamed flow still updates the name on Live without sending the canvas (that route writes Live).
export const planCanvasSave = ({ mode, name, savedName, flowData, hasId }) => {
    if (!hasId) return { create: true, live: { name, flowData }, draft: null }
    if (mode !== 'draft') return { create: false, live: { name, flowData }, draft: null }
    return {
        create: false,
        live: name !== savedName ? { name } : null,
        draft: { flowData }
    }
}

export const parseCanvas = (text) => {
    if (typeof text !== 'string' || !text) return null
    try {
        const parsed = JSON.parse(text)
        if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null
        return parsed
    } catch {
        return null
    }
}

const nodeLabel = (node) => node?.data?.label || node?.data?.name || node?.id || 'Node'

const contentFields = (node) => {
    const data = node?.data || {}
    const fields = {}
    for (const [key, value] of Object.entries(data)) {
        if (key === 'inputs' || SKIP_DATA_KEYS.has(key)) continue
        fields[key] = JSON.stringify(value)
    }
    for (const [name, value] of Object.entries(data.inputs || {})) {
        fields[`inputs.${name}`] = JSON.stringify(value)
    }
    return fields
}

const edgeKey = (edge) => JSON.stringify([edge?.source, edge?.sourceHandle, edge?.target, edge?.targetHandle])

// Same shape the history panel describes, from the two canvases: Live, then the draft.
export const diffCanvases = (liveText, draftText) => {
    const empty = { added: [], removed: [], changed: [], moved: [], edgesChanged: false, renamed: null }
    const live = parseCanvas(liveText)
    const draft = parseCanvas(draftText)
    if (!live || !draft) return empty
    const before = new Map(live.nodes.map((node) => [node?.id, node]))
    const after = new Map(draft.nodes.map((node) => [node?.id, node]))
    const added = []
    const removed = []
    const changed = []
    const moved = []
    for (const [id, node] of after) {
        if (!id) continue
        const old = before.get(id)
        if (!old) {
            added.push({ id, label: nodeLabel(node) })
            continue
        }
        const oldFields = contentFields(old)
        const newFields = contentFields(node)
        const keys = new Set([...Object.keys(oldFields), ...Object.keys(newFields)])
        const fields = [...keys].filter((key) => oldFields[key] !== newFields[key]).sort()
        if (fields.length) changed.push({ id, label: nodeLabel(node), fields })
        if (JSON.stringify(old.position ?? null) !== JSON.stringify(node.position ?? null)) moved.push(id)
    }
    for (const [id, node] of before) {
        if (id && !after.has(id)) removed.push({ id, label: nodeLabel(node) })
    }
    const liveEdges = live.edges.map(edgeKey).sort().join('\n')
    const draftEdges = draft.edges.map(edgeKey).sort().join('\n')
    return {
        added,
        removed,
        changed,
        moved,
        edgesChanged: liveEdges !== draftEdges,
        renamed: null
    }
}

export const publishChangeLines = (liveText, draftText) => {
    const draft = parseCanvas(draftText)
    return describeDiff(diffCanvases(liveText, draftText), 'previous', draft?.nodes || [])
}

const canvasString = (value) => (typeof value === 'string' && value.trim() ? value : '')

// A canvas string the cards can be replaced with. Blank, missing, or not a canvas is ignored,
// so a summary that omitted flowData cannot wipe the cards.
export const canvasTextToApply = (text) => {
    const value = canvasString(text)
    if (!value || !parseCanvas(value)) return null
    return value
}

// The publish and rollback responses name the flow without its canvas. Keep the record we had
// and set flowData to the canvas that just became Live.
export const chatflowAfterLive = (previous, incoming, liveCanvas) => {
    const flowData = canvasString(incoming?.flowData) || canvasString(liveCanvas) || canvasString(previous?.flowData)
    const next = { ...(previous || {}), ...(incoming || {}) }
    if (flowData) next.flowData = flowData
    return next
}

// After Publish: flowData is the draft that went Live (or the canvas the server saved).
// A newer draft saved during publish is what the canvas shows; otherwise the cards show Live.
export const canvasAfterPublish = (previous, response, draftFlowData) => {
    const chatflow = chatflowAfterLive(previous, response?.chatflow, draftFlowData)
    return { chatflow, apply: canvasTextToApply(response?.status?.draft?.flowData || chatflow?.flowData) }
}

// Discard puts Live back on the canvas. No Live canvas means leave the cards alone.
export const canvasAfterDiscard = (chatflow) => canvasTextToApply(chatflow?.flowData)

// After Roll back with no draft, the canvas becomes the version that is Live.
// fetchedFlowData is GET /api/v1/chatflows/:id when the response left the canvas out.
export const canvasAfterRollback = (previous, response, fetchedFlowData) => {
    const kept = Boolean(response?.status?.draft)
    const live = kept ? undefined : response?.chatflow?.flowData || fetchedFlowData
    const chatflow = chatflowAfterLive(previous, response?.chatflow, live)
    return { chatflow, apply: kept ? null : canvasTextToApply(chatflow?.flowData) }
}

// A pipeline publish lists the structural diff and does not replay questions.
export const showsPublishCheck = (type) => type !== 'ETL'

export const PIPELINE_PREVIEW_NOTE = 'Preview uses this canvas and does not write to the store.'

export const PIPELINE_RUN_DIRTY =
    'Save your changes first. A save stores a draft. Preview uses this canvas and does not write to the store.'

export const PIPELINE_RUN_DRAFT =
    'This run uses the published pipeline and writes to the store. The draft is not included until you Publish. Preview uses the draft and does not write.'

export const publishBody = (stale, replaceLiveChanges) => (stale && replaceLiveChanges ? { overwriteLiveChanges: true } : {})

export const publishResultMessage = (data = {}) => {
    if (data.unchanged) return { message: 'Already live. Nothing new to publish.', variant: 'info' }
    if (data.recorded === false) {
        const reason = data.historyError ? ` ${data.historyError}` : ''
        return { message: `Published, but history could not record it.${reason}`, variant: 'warning' }
    }
    const title = data.version?.title
    if (title) return { message: `Published. ${title}`, variant: 'success' }
    return { message: 'Published.', variant: 'success' }
}

export const apiErrorMessage = (error, fallback) => {
    const data = error?.response?.data
    if (data && typeof data === 'object' && typeof data.message === 'string' && data.message) return data.message
    if (typeof data === 'string' && data) return data
    return fallback
}

export const rollbackLabel = (compact) => (compact ? 'Roll back' : 'Roll back Live to this version')

export const restorePrompt = (draftMode) => {
    if (draftMode) {
        return {
            title: 'Open this version as your draft?',
            body: 'This opens on the canvas as your draft. Live is unchanged until you publish. Nothing in history is erased.',
            confirm: 'Open as draft',
            button: 'Open as draft',
            shortButton: 'As draft'
        }
    }
    return {
        title: 'Restore this version?',
        body: 'The flow goes back to this version and is live right away. Nothing in history is erased: the restore is saved as a new version, so you can undo it the same way.',
        confirm: 'Restore',
        button: 'Restore this version',
        shortButton: 'Restore'
    }
}
