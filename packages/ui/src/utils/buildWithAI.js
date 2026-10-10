// Plain-words decisions for Build with AI, shared by every canvas.

export const BUILD_BUTTON = 'Build with AI'

export const BUILD_PROMPTS = {
    workflow: 'Describe your workflow',
    harness: 'Describe your team',
    etl: 'Describe your data',
    chat: 'Describe your assistant'
}

export const BUILD_EXAMPLES = {
    workflow: [
        'An agent that searches the web and writes a short report',
        'Sort each customer message into billing, technical or other, and answer each kind differently',
        'Draft a reply, let a person approve it, then send it'
    ],
    harness: [
        'A research team: one specialist searches our notes, another writes a short summary',
        'A trip planning team with an itinerary planner and a budget specialist who uses a calculator',
        'A writing team with an outliner, a drafter and an editor'
    ],
    etl: [
        'Index the product catalog CSV so people can search products by what they do',
        'Keep the markdown guides in a folder searchable, in small chunks',
        'Index a git repository so people can ask where things live in the code'
    ],
    chat: [
        'A math helper that uses a calculator for sums, percentages and tips',
        'A support assistant that answers only from a few product facts I give it',
        'A study buddy that remembers our conversation and quizzes me'
    ]
}

const MODEL_KEY = 'cuttlely.builderModel'
const FLOWISE_CREDENTIAL_ID = 'FLOWISE_CREDENTIAL_ID'

// The building model is remembered by its card name and settings, including the credential id picked from the
// Credentials page. A credential id is a pointer, never a key.
export const modelToRemember = (model) => {
    if (!model?.name) return null
    const inputs = { ...(model.inputs || {}) }
    const credential = model.credential || inputs[FLOWISE_CREDENTIAL_ID] || ''
    if (credential) inputs[FLOWISE_CREDENTIAL_ID] = credential
    return { name: model.name, credential, inputs }
}

export const rememberModel = (model, storage = globalThis.localStorage) => {
    const value = modelToRemember(model)
    try {
        if (value) storage?.setItem(MODEL_KEY, JSON.stringify(value))
    } catch {
        // storage full or blocked: the person picks again next time
    }
}

export const recallModel = (storage = globalThis.localStorage) => {
    try {
        const value = JSON.parse(storage?.getItem(MODEL_KEY) || 'null')
        return value?.name ? value : null
    } catch {
        return null
    }
}

// An empty canvas builds in place: no cards, or only the Start card a new workflow opens with.
export const canvasIsEmpty = (nodes = [], edges = []) => {
    const cards = (nodes || []).filter((node) => node?.data?.name !== 'startAgentflow')
    return cards.length === 0 && (edges || []).length === 0
}

const chatSettings = (chatbotConfig) => {
    try {
        return (typeof chatbotConfig === 'string' && chatbotConfig ? JSON.parse(chatbotConfig) : chatbotConfig) || {}
    } catch {
        return {}
    }
}

// The starter questions saved in a flow's chat settings, in order.
export const starterQuestionsOf = (chatbotConfig) =>
    Object.values(chatSettings(chatbotConfig).starterPrompts || {})
        .map((entry) => (typeof entry?.prompt === 'string' ? entry.prompt.trim() : ''))
        .filter(Boolean)

// Starter questions go into the chat settings when a flow has none yet; questions someone already wrote stay.
export const withStarterQuestions = (chatbotConfig, questions = []) => {
    const config = chatSettings(chatbotConfig)
    const existing = Object.values(config.starterPrompts || {}).some((entry) => entry?.prompt)
    const clean = (questions || []).filter((q) => typeof q === 'string' && q.trim())
    if (existing || !clean.length) return null
    const starterPrompts = Object.fromEntries(clean.map((prompt, index) => [String(index), { prompt: prompt.trim() }]))
    return JSON.stringify({ ...config, starterPrompts })
}

export const missingCredentialsText = (missing = []) => {
    if (!missing?.length) return ''
    const list = missing.map((m) => `${m.part} needs ${m.credential}`).join('; ')
    return `Add on the Credentials page, then pick on the card: ${list}.`
}

export const buildProblemsText = (kind, problems = []) =>
    `It could not build a ${kind} that passes the check. ${problems.length === 1 ? 'The problem' : 'The problems'}: ${problems.join(' ')}`

// Start a new one opens a fresh canvas in a new tab, the way Duplicate does, so this canvas stays as it is.
// The built cards travel like a duplicate; the starter questions and missing credentials travel beside them.
const LANDING_KEY = 'cuttlely.builderLanding'

export const stashNewCanvas = (result, storage = globalThis.localStorage) => {
    storage?.setItem(
        'duplicatedFlowData',
        JSON.stringify({ cuttlelyMigration: true, name: result.title || '', flow: { nodes: result.nodes, edges: result.edges } })
    )
    storage?.setItem(
        LANDING_KEY,
        JSON.stringify({
            title: result.title || '',
            starterQuestions: result.starterQuestions || [],
            missingCredentials: result.missingCredentials || []
        })
    )
}

export const takeLanding = (storage = globalThis.localStorage) => {
    try {
        const value = JSON.parse(storage?.getItem(LANDING_KEY) || 'null')
        storage?.removeItem(LANDING_KEY)
        return value && Array.isArray(value.starterQuestions) ? value : null
    } catch {
        return null
    }
}

// A harness name the server accepts (a letter first, then letters, digits, dashes or underscores, up to 64),
// made from the built title and kept clear of the names already taken.
export const harnessNameFrom = (title, taken = []) => {
    const base =
        String(title || '')
            .replace(/[^A-Za-z0-9]+/g, '-')
            .replace(/^[^A-Za-z]+/, '')
            .replace(/-+$/, '')
            .slice(0, 56) || 'team'
    const used = new Set((taken || []).map((name) => String(name).toLowerCase()))
    if (!used.has(base.toLowerCase())) return base
    for (let n = 2; ; n += 1) if (!used.has(`${base}-${n}`.toLowerCase())) return `${base}-${n}`
}

// A pipeline name is free text; a built one keeps its title and gets a number when the title is taken.
export const pipelineNameFrom = (title, taken = []) => {
    const base =
        String(title || '')
            .trim()
            .slice(0, 80) || 'Built pipeline'
    const used = new Set((taken || []).map((name) => String(name).toLowerCase()))
    if (!used.has(base.toLowerCase())) return base
    for (let n = 2; ; n += 1) if (!used.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}

// What the canvas does on save: a card's own credential moves from its inputs to data.credential.
export const asSavedCards = (nodes = []) =>
    nodes.map((node) => {
        const data = { ...node.data, inputs: { ...(node.data?.inputs || {}) } }
        if (FLOWISE_CREDENTIAL_ID in data.inputs) {
            data.credential = data.inputs[FLOWISE_CREDENTIAL_ID]
            delete data.inputs[FLOWISE_CREDENTIAL_ID]
        }
        return { ...node, data: { ...data, selected: false } }
    })

// The builder lays cards out at their Classic height. Compact cards (the new look) are much shorter, so for the new
// look the layout is pressed together vertically: every y shrinks by one factor, the smallest that still keeps each
// card clear of the next one below it in its column. Order, columns and centering stay as built.
const ROW = 36
export const compactCardHeight = (data = {}) => {
    const count = (list) => (Array.isArray(list) ? list.length : 0)
    const params = Array.isArray(data.inputParams) ? data.inputParams.filter((p) => !p.hidden && p.display !== false) : []
    const plugs = params.filter((p) => !p.additionalParams && p.acceptVariable).length
    const settings = params.length ? 24 + 22 * 3 : 0
    return 64 + ROW * (count(data.inputAnchors) + plugs) + settings + ROW * count(data.outputAnchors) + 16
}

export const compactForNewLook = (nodes = [], gap = 48) => {
    if (nodes.length < 2) return nodes
    const top = Math.min(...nodes.map((n) => n.position?.y ?? 0))
    const columns = new Map()
    for (const node of nodes) {
        const key = Math.round(node.position?.x ?? 0)
        columns.set(key, [...(columns.get(key) || []), node])
    }
    let factor = 0
    for (const column of columns.values()) {
        const sorted = [...column].sort((a, b) => a.position.y - b.position.y)
        for (let i = 1; i < sorted.length; i += 1) {
            const apart = sorted[i].position.y - sorted[i - 1].position.y
            if (apart > 0) factor = Math.max(factor, (compactCardHeight(sorted[i - 1].data) + gap) / apart)
            else factor = 1
        }
    }
    factor = Math.min(1, factor || 1)
    return nodes.map((node) => {
        const y = Math.round(top + (node.position.y - top) * factor)
        const position = { ...node.position, y }
        return { ...node, position, positionAbsolute: { ...(node.positionAbsolute || node.position), y } }
    })
}

// A built harness or pipeline is saved as a new one right away; this note follows it to its canvas, which
// says what was built and lists the credentials still to add.
const SAVED_KEY = 'cuttlely.builderSaved'

export const noteSavedBuild = (id, result, storage = globalThis.localStorage) => {
    storage?.setItem(SAVED_KEY, JSON.stringify({ id, title: result.title || '', missingCredentials: result.missingCredentials || [] }))
}

export const takeSavedBuild = (id, storage = globalThis.localStorage) => {
    try {
        const value = JSON.parse(storage?.getItem(SAVED_KEY) || 'null')
        if (!value || value.id !== id) return null
        storage?.removeItem(SAVED_KEY)
        return value
    } catch {
        return null
    }
}
