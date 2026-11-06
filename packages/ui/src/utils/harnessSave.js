import { harnessNameFrom } from './buildWithAI'
import { reservedHarnessNameMessage } from './harnessChatReady'

// The same id rule as packages/harness/store.mjs. A harness file is `${name}.json`.
const HARNESS_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

// An empty live canvas. It has no Harness Prime and no specialist, so the server stores the row
// and does not write a harness file. The real canvas, including selected credentials, goes to the draft.
export const HARNESS_PLACEHOLDER_FLOW = JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } })

const ID_RULE = 'Harness ids use a letter, then letters, numbers, "_" or "-".'

export function harnessNameError(name) {
    const reserved = reservedHarnessNameMessage(name)
    if (reserved) return reserved
    const text = String(name || '').trim()
    if (!text || HARNESS_NAME.test(text)) return ''
    return `Harness name "${text}" is not valid. Use a letter followed by letters, numbers, "_" or "-".`
}

// Shown in the new-harness dialog. A name with spaces or other characters is saved as a safe id.
// A reserved try name stays blocked by harnessNameError / reservedHarnessNameMessage.
export function harnessSaveNameNote(name) {
    const text = String(name || '').trim()
    if (!text || reservedHarnessNameMessage(text) || HARNESS_NAME.test(text)) return ''
    const id = safeHarnessId(text)
    if (!id) return ''
    return `This will be saved as "${id}". ${ID_RULE}`
}

function safeHarnessId(name) {
    const id = harnessNameFrom(name)
    if (!HARNESS_NAME.test(id) || reservedHarnessNameMessage(id)) return ''
    return id
}

function inputNameFromHandle(edge) {
    const handle = String(edge?.targetHandle || '')
    const marker = `${edge?.target}-input-`
    if (!handle.startsWith(marker)) return ''
    return handle.slice(marker.length).split('-')[0]
}

function definitionFor(node, definitions) {
    return (definitions || []).find((item) => item?.name === node?.data?.name)
}

function isChatModel(node, definitions) {
    if (!node?.data) return false
    if (node.data.category === 'Chat Models') return true
    return definitionFor(node, definitions)?.category === 'Chat Models'
}

function credentialIdOf(node) {
    const direct = typeof node?.data?.credential === 'string' ? node.data.credential.trim() : ''
    if (direct) return direct
    const picked = node?.data?.inputs?.FLOWISE_CREDENTIAL_ID
    return typeof picked === 'string' && picked.trim() ? picked.trim() : ''
}

function credentialRequired(node, definitions) {
    const definition = definitionFor(node, definitions)
    if (definition?.credential) return definition.credential.optional !== true
    // The catalog has not named this chat model. Treat a missing credential as not ready
    // so the first save is stored instead of rejected.
    return !definition && node?.data?.category === 'Chat Models'
}

function specialistId(node) {
    const inputs = node?.data?.inputs || {}
    const preset = String(inputs.preset || '')
        .trim()
        .toLowerCase()
    const named = inputs.specialistName || inputs.name || (preset === 'assets' ? 'assets' : '')
    return String(named || '').trim()
}

// Why a new harness cannot go live yet. '' means the roster can be written.
// credential: a required chat-model credential is missing.
// name: a specialist name is not a safe id.
// roster: there is not one Harness Prime, a specialist, and a chat model on Harness Prime.
export function harnessLiveBlock(flowData, nodeDefinitions) {
    let flow
    try {
        flow = typeof flowData === 'string' ? JSON.parse(flowData) : flowData
    } catch {
        return 'roster'
    }
    const nodes = Array.isArray(flow?.nodes) ? flow.nodes : []
    const edges = Array.isArray(flow?.edges) ? flow.edges : []
    const chiefs = nodes.filter((node) => node?.data?.name === 'harnessChief')
    const specialists = nodes.filter((node) => node?.data?.name === 'harnessSpecialist')
    if (chiefs.length !== 1 || specialists.length === 0) return 'roster'
    const chiefId = chiefs[0].id
    const teamIds = new Set([chiefId, ...specialists.map((node) => node.id)])
    const byId = new Map(nodes.map((node) => [node.id, node]))
    let chiefHasModel = false
    let credentialGap = false
    for (const edge of edges) {
        if (!teamIds.has(edge?.target)) continue
        const source = byId.get(edge.source)
        if (!isChatModel(source, nodeDefinitions)) continue
        if (edge.target === chiefId && inputNameFromHandle(edge) !== 'fallbackModel') chiefHasModel = true
        if (credentialRequired(source, nodeDefinitions) && !credentialIdOf(source)) credentialGap = true
    }
    if (!chiefHasModel) return 'roster'
    const specialistIds = specialists.map(specialistId)
    const seenIds = new Set()
    const duplicateName = specialistIds.some((id) => {
        if (!id) return false
        if (seenIds.has(id)) return true
        seenIds.add(id)
        return false
    })
    const badName = duplicateName || specialistIds.some((id) => !HARNESS_NAME.test(id))
    if (badName && credentialGap) return 'both'
    if (badName) return 'name'
    if (credentialGap) return 'credential'
    return ''
}

const DRAFT_WHY = {
    credential: 'Select a credential on each chat model that needs one, then Publish. Credentials you already chose stay on this draft.',
    name: 'Specialist names must be unique ids: a letter, then letters, numbers, "_" or "-". Then Publish.',
    both: 'Select a credential on each chat model that needs one, and give every specialist a unique id: a letter, then letters, numbers, "_" or "-". Then Publish. Credentials you already chose stay on this draft.',
    roster: 'Add one Harness Prime, at least one specialist, and a chat model on Harness Prime, then Publish.'
}

export const INCOMPLETE_DRAFTS_OFF_MESSAGE =
    'This harness is not ready to go Live, and drafts are off on this server. Finish the roster (credentials and unique specialist ids), then save again.'

export function draftSaveWasTurnedOff(error) {
    if (error?.response?.status !== 409) return false
    const data = error.response.data
    const message = typeof data === 'string' ? data : data?.message
    return message === 'Drafts are off on this server.' || message === INCOMPLETE_DRAFTS_OFF_MESSAGE
}

// With drafts off, an incomplete harness cannot be kept as Live. Refuse with a clear message so the cards stay on the canvas.
export function planHarnessDraftFallback({ flowData, nodeDefinitions, draftsOff }) {
    if (!draftsOff) return null
    const block = harnessLiveBlock(flowData, nodeDefinitions)
    if (!block) return null
    return { error: INCOMPLETE_DRAFTS_OFF_MESSAGE }
}

// Where the first save of a new harness goes.
// A reserved try name is refused. Any other name is stored as a safe id.
// A roster that is not runnable yet is stored as a draft only on an empty live canvas, so a selected
// credential is kept and nothing goes Live yet. A complete roster still goes live. Publish and the
// harness file write keep the credential and name checks. When drafts are off, an incomplete roster is refused.
export function planNewHarnessSave({ name, flowData, nodeDefinitions, draftsOff = false }) {
    const typed = String(name || '').trim()
    const reserved = reservedHarnessNameMessage(typed)
    if (reserved) return { error: reserved }
    let id = typed
    let adjusted = false
    if (!HARNESS_NAME.test(typed)) {
        id = safeHarnessId(typed)
        if (!id) return { error: harnessNameError(typed) || `Harness name "${typed}" is not valid. ${ID_RULE}` }
        adjusted = id !== typed
    }
    const block = harnessLiveBlock(flowData, nodeDefinitions)
    const savedAs = adjusted ? `Saved as "${id}". ${ID_RULE}` : ''
    if (!block) {
        return { name: id, adjusted, liveFlowData: flowData, draftFlowData: null, notice: savedAs }
    }
    if (draftsOff) {
        return { error: INCOMPLETE_DRAFTS_OFF_MESSAGE }
    }
    const notice = [`Saved as a draft. ${DRAFT_WHY[block] || DRAFT_WHY.roster}`, savedAs].filter(Boolean).join(' ')
    return {
        name: id,
        adjusted,
        liveFlowData: HARNESS_PLACEHOLDER_FLOW,
        draftFlowData: flowData,
        notice
    }
}
