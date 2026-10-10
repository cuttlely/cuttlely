// Use the person's own model key by default wherever Cuttlely needs a chat model: Build with AI, a model card's
// credential, and a harness template. A key is only ever picked by its id; nothing here reads a key.

import { normalizeNodeData } from './normalizeCanvasFlow'

const FLOWISE_CREDENTIAL_ID = 'FLOWISE_CREDENTIAL_ID'

// A small, quick model where we know one, most used providers first. Otherwise the card's own default.
export const PREFERRED_CHAT_MODELS = [
    ['chatOpenAI', 'gpt-4.1-mini'],
    ['chatAnthropic', 'claude-haiku-4-5'],
    ['chatXAI', 'grok-4.7'],
    ['chatGoogleGenerativeAI', 'gemini-2.5-flash'],
    ['chatMistralAI', undefined],
    ['groqChat', 'llama-3.3-70b-versatile'],
    ['chatDeepseek', 'deepseek-flash'],
    ['chatOpenRouter', undefined]
]

export const credentialNamesOf = (component) => {
    const own = component?.credential?.credentialNames
    if (Array.isArray(own)) return own
    const param = (component?.inputParams || []).find((item) => item?.type === 'credential')
    return Array.isArray(param?.credentialNames) ? param.credentialNames : []
}

const isChatModel = (component) => component?.category === 'Chat Models' && !/deprecat/i.test(String(component?.badge || ''))

// The keys that fit a card, by credential type.
export const keysFor = (component, credentials = []) => {
    const names = credentialNamesOf(component)
    return names.length ? credentials.filter((credential) => names.includes(credential?.credentialName)) : []
}

// The one key that fits, or '' when none or several do (then the person picks).
export const onlyFit = (keys = []) => (keys.length === 1 && keys[0]?.id ? keys[0].id : '')

const defaultModelName = (component) => {
    const input = (component?.inputs || component?.inputParams || []).find((item) => item?.name === 'modelName')
    return typeof input?.default === 'string' && input.default ? input.default : undefined
}

// Chat models the person has a key for, preferred ones first. Empty when they have no chat model key yet.
export const modelsForKeys = (components = [], credentials = []) => {
    const fits = components.filter((component) => isChatModel(component) && keysFor(component, credentials).length > 0)
    const rank = (component) => {
        const index = PREFERRED_CHAT_MODELS.findIndex(([name]) => name === component.name)
        return index === -1 ? PREFERRED_CHAT_MODELS.length : index
    }
    return [...fits].sort((a, b) => rank(a) - rank(b))
}

// The chat model to start with: the first preferred card the person has a key for, with that key when it is the
// only one that fits. Null when they have no chat model key.
export const modelForKeys = (components = [], credentials = []) => {
    const [component] = modelsForKeys(components, credentials)
    if (!component) return null
    const preferred = PREFERRED_CHAT_MODELS.find(([name]) => name === component.name)
    return {
        component,
        credential: onlyFit(keysFor(component, credentials)),
        modelName: preferred?.[1] || defaultModelName(component)
    }
}

const hasCredential = (data) => Boolean(data?.credential || data?.inputs?.[FLOWISE_CREDENTIAL_ID])

const uniqueId = (name, taken) => {
    let index = 0
    while (taken.has(`${name}_${index}`)) index += 1
    return `${name}_${index}`
}

// A harness template ships with a chat model card that has no key. Give it the person's key: when they have a key
// for the card as it is, fill in the key if exactly one fits; when they have none for it but have a key for
// another chat model, swap the card for that model (same place, same links). Returns the flow and what changed.
export const templateWithYourKey = (flow, specs, credentials = []) => {
    const changed = []
    if (!flow || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges) || !credentials.length) return { flow, changed }
    const byName = specs instanceof Map ? specs : new Map((specs || []).map((spec) => [spec.name, spec]))
    const components = [...byName.values()]
    const taken = new Set(flow.nodes.map((node) => node?.id))
    for (const node of flow.nodes) {
        const data = node?.data
        const spec = byName.get(data?.name)
        if (!data || !isChatModel(spec || data) || hasCredential(data)) continue
        const own = keysFor(spec, credentials)
        if (own.length) {
            const id = onlyFit(own)
            if (id) {
                data.credential = id
                data.inputs = { ...(data.inputs || {}), [FLOWISE_CREDENTIAL_ID]: id }
                changed.push({ from: data.label || data.name, to: data.label || data.name })
            }
            continue
        }
        const pick = modelForKeys(components, credentials)
        if (!pick) continue
        const oldId = node.id
        const newId = uniqueId(pick.component.name, taken)
        taken.add(newId)
        const inputs = pick.modelName ? { modelName: pick.modelName } : {}
        if (pick.credential) inputs[FLOWISE_CREDENTIAL_ID] = pick.credential
        node.id = newId
        // A full card (fields and handles) from the catalog, so it shows and connects even before the canvas has its own catalog.
        node.data = normalizeNodeData(
            {
                id: newId,
                label: pick.component.label,
                name: pick.component.name,
                version: pick.component.version,
                type: pick.component.type,
                category: pick.component.category,
                inputs,
                ...(pick.credential ? { credential: pick.credential } : {})
            },
            pick.component
        )
        const output = node.data.outputAnchors?.[0]
        const sourceHandle = output?.options?.[0]?.id || output?.id
        for (const edge of flow.edges) {
            if (edge?.source === oldId) {
                edge.source = newId
                if (sourceHandle) edge.sourceHandle = sourceHandle
                else delete edge.sourceHandle
            }
            if (edge?.target === oldId) {
                edge.target = newId
                edge.targetHandle = ''
            }
            if (typeof edge?.id === 'string') edge.id = edge.id.split(oldId).join(newId)
        }
        changed.push({
            from: data.label || data.name,
            to: pick.component.label,
            modelName: pick.modelName,
            keyPicked: Boolean(pick.credential)
        })
    }
    return { flow, changed }
}

// One line for the person after a template changed.
export const templateKeyNote = (changed = []) => {
    const swap = changed.find((item) => item.from !== item.to)
    if (swap) {
        const model = swap.modelName ? ` (${swap.modelName})` : ''
        const key = swap.keyPicked ? 'with your key' : 'pick your key on the card'
        return `This template now uses ${swap.to}${model} instead of ${swap.from}, ${key}. Save to keep it.`
    }
    return changed.length ? 'Your key is filled in on the chat model card. Save to keep it.' : ''
}
