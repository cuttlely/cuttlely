import { DynamicTool } from '@langchain/core/tools'
import { CallbackManager } from '@langchain/core/callbacks/manager'
import { ICommonObject, INode, INodeData, INodeOptionsValue, INodeParams } from '../../../src/Interface'
import { HarnessFlowOptions, loadHarnessEngine } from '../engine'
import { addSingleFileToStorage, getFileFromStorage } from '../../../src/storageUtils'
import { ARTIFACTS_PREFIX } from '../../../src/agents'

const trustedDelivery = new WeakMap<object, () => void>()
const isTrustedOutput = (payload: any): boolean => payload?.trustedOutput === true || payload?.trace?.handoff?.reason === 'trustedOutput'
const isHarnessReplay = (options: ICommonObject): boolean => Boolean(options?.replay || options?.cuttlelyReplay)
function assertDeliveryActive(options: ICommonObject, deadlineAt?: number) {
    if (abortSignalOf(options)?.aborted) throw harnessFailure('Run was cancelled.', 'aborted')
    if (typeof deadlineAt === 'number' && Date.now() >= deadlineAt)
        throw harnessFailure('The turn budget expired before verified output could be delivered.', 'over_budget')
}
function deliverTrustedOutput(payload: any, options: ICommonObject) {
    if (!isTrustedOutput(payload)) return
    assertDeliveryActive(options, payload.trustedOutputDeadlineAt)
    if (isHarnessReplay(options)) {
        trustedDelivery.delete(payload)
        return
    }
    trustedDelivery.get(payload)?.()
    trustedDelivery.delete(payload)
}

class Harness_Harness implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]
    inputs: INodeParams[]

    constructor() {
        this.label = 'Harness'
        this.name = 'harness'
        this.version = 1.2
        this.type = 'Harness'
        this.icon = 'harness.svg'
        this.category = 'Harness'
        this.description =
            "Attach a named harness as a tool. One Harness card on an agent keeps the tool name harness. Several cards use the card title, or the harness name when the title is still Harness, followed by that card's id. A chat whose only node is this harness runs that roster for the message."
        this.baseClasses = [this.type, 'Tool']
        this.inputs = [
            {
                label: 'Harness',
                name: 'harnessName',
                type: 'asyncOptions',
                loadMethod: 'listHarnesses',
                description:
                    "Saved harness name. One Harness card on an agent is the tool harness. Several cards use the card title, or this name when the title is still Harness, followed by that card's id."
            },
            {
                label: 'Return Direct',
                name: 'returnDirect',
                type: 'boolean',
                default: true,
                optional: true,
                description:
                    'Sends the harness reply to the chat as is. Turn off only when the agent must rework that reply; each pass is another model call.'
            },
            {
                label: 'Tool Input',
                name: 'inputSource',
                type: 'options',
                options: [
                    {
                        label: 'User message',
                        name: 'user',
                        description: 'Harness Prime routes the message the person sent, as when the harness is asked directly.'
                    },
                    {
                        label: 'Agent task',
                        name: 'agent',
                        description: 'Harness Prime routes the task the agent wrote when it called the tool.'
                    }
                ],
                default: 'user',
                optional: true,
                additionalParams: true,
                description:
                    'What Harness Prime routes when an agent calls this harness as a tool. With User message, the agent task is used only when the message is empty.'
            },
            {
                label: 'Allow Image Uploads',
                name: 'allowImageUploads',
                type: 'boolean',
                default: false,
                optional: true,
                description:
                    'Lets people attach images in this chat. Harness Prime sees them when it routes and answers, and writes what a specialist needs into its task. Specialists do not see the images. Harness Prime needs a model that reads images.'
            }
        ]
    }

    loadMethods = {
        listHarnesses: async (_nodeData: INodeData, options?: ICommonObject): Promise<INodeOptionsValue[]> => {
            const engine = await loadHarnessEngine()
            const workspaceId = typeof options?.workspaceId === 'string' ? options.workspaceId : ''
            const harnesses = engine.listHarnesses()
            return harnesses
                .filter((harness: { name: string; workspaceId?: string }) => Boolean(workspaceId) && harness.workspaceId === workspaceId)
                .map((harness: { name: string; description?: string }) => ({
                    label: harness.name,
                    name: harness.name,
                    description: harness.description
                }))
        }
    }

    async init(nodeData: INodeData, input: string, options: ICommonObject): Promise<any> {
        const harnessName = selectedHarness(nodeData)
        // A chat flow passes the question as the input. An agent flow Agent passes '' and sets harnessUserMessage.
        const userMessage =
            typeof input === 'string' && input.trim()
                ? input
                : typeof options?.harnessUserMessage === 'string'
                ? options.harnessUserMessage
                : ''
        const streamed = { answer: false }
        const toolName = harnessToolNameFor(nodeData, options)
        const tool = new DynamicTool({
            name: toolName,
            description: harnessToolDescription(harnessName, toolName),
            returnDirect: nodeData.inputs?.returnDirect !== false && nodeData.inputs?.returnDirect !== 'false',
            func: async (task: string, runManager?: ToolRunManager) => {
                const payload = await runNamedHarness(
                    harnessName,
                    harnessToolInput(nodeData, userMessage, task),
                    options,
                    true,
                    runManager,
                    streamed,
                    [],
                    harnessToolMetadata(nodeData, userMessage, task),
                    harnessTraceCallbacks(runManager, toolName)
                )
                rememberToolPayload(options, payload)
                // The tool returns answer text only. The ending-node path records Harness.run; this closure records the tool.
                recordHarnessToolUsage(options, payload)
                return harnessToolOutput(payload, options)
            }
        })
        Object.defineProperty(tool, 'cuttlelyStreamedAnswer', { get: () => streamed.answer })
        // Card identity travels with the tool. Each agent reads it and applies that agent's own tool name.
        const card = cardFromNodeData(nodeData)
        Object.defineProperty(tool, 'harnessCard', {
            value: { id: card.id, label: card.label, name: card.name },
            enumerable: false,
            writable: true,
            configurable: true
        })
        return tool
    }

    async run(nodeData: INodeData, input: string, options: ICommonObject): Promise<any> {
        const harnessName = selectedHarness(nodeData)
        const images = allowsImages(nodeData) ? await uploadedImages(options) : []
        const payload = await runNamedHarness(harnessName, input, options, !options.agentflowRuntime, undefined, undefined, images)
        const stored = await storeHarnessImages(payload.artifacts, options, isTrustedOutput(payload), payload.trustedOutputDeadlineAt)
        payload.artifacts = stored
        if (isTrustedOutput(payload)) assertDeliveryActive(options, payload.trustedOutputDeadlineAt)
        if (!options.agentflowRuntime && !(isTrustedOutput(payload) && isHarnessReplay(options))) streamStoredImages(options, stored)
        deliverTrustedOutput(payload, options)
        if (options.agentflowRuntime) {
            return {
                id: nodeData.id,
                name: this.name,
                input: { question: input },
                output: {
                    content: payload.text,
                    text: payload.text,
                    harness: payload.harness,
                    agents: payload.agents,
                    sources: payload.sources,
                    artifacts: payload.artifacts,
                    timings: payload.timings,
                    report: payload.report,
                    sourceDocuments: payload.sources,
                    harnessPayload: payload
                },
                state: options.agentflowRuntime.state
            }
        }
        return {
            text: payload.text,
            harness: payload.harness,
            agents: payload.agents,
            sources: payload.sources,
            artifacts: payload.artifacts,
            timings: payload.timings,
            report: payload.report,
            sourceDocuments: payload.sources,
            harnessPayload: payload
        }
    }
}

type HarnessImage = { type?: string; mime?: string; name?: string; specialist?: string; base64?: string; data?: string }
type StoredArtifact = { type: string; data: string; name?: string }

// The artifact types a harness turn may return, with the MIME type each is stored as. The harness runtime checked
// the bytes against the type (packages/harness/images.mjs). PDF, DOCX, XLSX, PPTX and CSV keep a name for the download.
const HARNESS_ARTIFACT_MIMES: Record<string, string> = {
    png: 'image/png',
    jpeg: 'image/jpeg',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    csv: 'text/csv'
}
const HARNESS_FILE_TYPES = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'csv'])

// Images and files a specialist wrote this turn arrive as bytes. They are saved in the chat's file storage, and the
// chat gets the usual artifacts: images show inline, files as downloads. A publish check replay stores nothing.
async function storeHarnessImages(
    artifacts: unknown,
    options: ICommonObject,
    requireAll = false,
    deadlineAt?: number
): Promise<StoredArtifact[]> {
    const list = Array.isArray(artifacts) ? (artifacts as HarnessImage[]) : []
    const stored: StoredArtifact[] = []
    if (requireAll) assertDeliveryActive(options, deadlineAt)
    for (const [index, item] of list.entries()) {
        if (requireAll) assertDeliveryActive(options, deadlineAt)
        if (!item || typeof item.base64 !== 'string') {
            if (item && typeof item.type === 'string' && typeof item.data === 'string') {
                stored.push({ type: item.type, data: item.data, ...(typeof item.name === 'string' ? { name: item.name } : {}) })
            }
            continue
        }
        // buildChatflow marks a publish check with cuttlelyReplay; agentflow runs pass replay.
        if ((!requireAll && isHarnessReplay(options)) || (!isHarnessReplay(options) && (!options?.chatflowid || !options?.chatId))) continue
        const mime = typeof item.type === 'string' ? HARNESS_ARTIFACT_MIMES[item.type] : undefined
        if (!mime || (item.mime && item.mime !== mime)) continue
        const isFile = HARNESS_FILE_TYPES.has(item.type as string)
        const base = String(item.name || `${isFile ? 'file' : 'image'}-${index + 1}`)
            .split('/')
            .pop()
            ?.replace(/[^A-Za-z0-9._-]/g, '_')
        const fileName = `harness_${String(item.specialist || 'specialist').replace(/[^A-Za-z0-9_-]/g, '_')}_${Date.now()}_${index}_${base}`
        if (requireAll && isHarnessReplay(options)) {
            const bytes = Buffer.from(item.base64, 'base64')
            if (!bytes.length) throw harnessFailure('Verified replay attachment has no bytes.', 'trusted_output')
            stored.push({ type: item.type as string, data: `data:${mime};base64,${item.base64}`, ...(base ? { name: base } : {}) })
            continue
        }
        try {
            const result = await addSingleFileToStorage(
                mime,
                Buffer.from(item.base64, 'base64'),
                fileName,
                options.orgId,
                options.chatflowid,
                options.chatId
            )
            if (requireAll) {
                assertDeliveryActive(options, deadlineAt)
                if (!result.path) throw harnessFailure('Verified attachment could not be stored.', 'trusted_output')
            }
            stored.push({ type: item.type as string, data: result.path, ...(isFile ? { name: base } : {}) })
        } catch (error) {
            if (requireAll && (abortSignalOf(options)?.aborted || (error as { code?: string }).code === 'over_budget')) throw error
            console.error('Harness could not store a specialist file:', error instanceof Error ? error.message : error)
        }
    }
    if (requireAll) {
        assertDeliveryActive(options, deadlineAt)
        if (stored.length !== list.length)
            throw harnessFailure('Verified attachments could not be stored; no delivery was acknowledged.', 'trusted_output')
    }
    return stored
}

const UPLOAD_IMAGE_LIMITS = { count: 4, bytes: 5 * 1024 * 1024 }
const UPLOAD_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

function allowsImages(nodeData: INodeData): boolean {
    const value = nodeData.inputs?.allowImageUploads
    return value === true || value === 'true'
}

type ChatUpload = { type?: string; name?: string; mime?: string; data?: string }

// Images attached to this message, read from the chat's file storage, or kept as links. Other files are left to the
// usual upload handling.
async function uploadedImages(options: ICommonObject): Promise<string[]> {
    const uploads = Array.isArray(options?.uploads) ? (options.uploads as ChatUpload[]) : []
    const images: string[] = []
    for (const upload of uploads) {
        if (images.length >= UPLOAD_IMAGE_LIMITS.count) break
        const mime = String(upload?.mime || '').toLowerCase()
        if (!UPLOAD_IMAGE_MIMES.includes(mime)) continue
        if (upload.type === 'url' && typeof upload.data === 'string' && /^https?:\/\//i.test(upload.data)) {
            images.push(upload.data)
            continue
        }
        if (upload.type !== 'stored-file' || !upload.name) continue
        try {
            const contents = await getFileFromStorage(upload.name, options.orgId, options.chatflowid, options.chatId)
            if (!contents?.length || contents.length > UPLOAD_IMAGE_LIMITS.bytes) continue
            images.push(`data:${mime};base64,${Buffer.from(contents).toString('base64')}`)
        } catch (error) {
            console.error('Harness could not read an attached image:', error instanceof Error ? error.message : error)
        }
    }
    return images
}

// The harness final event carries image names only. As the chatflow's ending node, the stored images go to a live
// chat the way a Tool Agent sends its artifacts, so they show without reloading the chat.
function streamStoredImages(options: ICommonObject, artifacts: StoredArtifact[]) {
    const sse = options?.sseStreamer
    const chatId = options?.chatId as string
    if (!artifacts.length || !chatId || typeof sse?.streamArtifactsEvent !== 'function') return
    sse.streamArtifactsEvent(chatId, artifacts)
}

// Connected to an agent as a tool, the images go after ARTIFACTS_PREFIX, where the agent reads tool artifacts (as the
// E2B code tool does), so they still show in the chat.
// A Tool Agent only sees the answer text, which has no token counts. Record the payload the tool already has.
// Harness.run does not call this: the chatflow records that payload once, when the harness is the ending node.
function recordHarnessToolUsage(options: ICommonObject, payload: unknown) {
    const record = options?.recordTokenUsage
    if (typeof record !== 'function') return
    void record(options.appDataSource, {
        workspaceId: options.workspaceId,
        flowId: options.chatflowid,
        result: payload
    })
}

async function harnessToolOutput(
    payload: { text?: string; artifacts?: unknown; trustedOutputDeadlineAt?: number },
    options: ICommonObject
): Promise<string> {
    const text = payloadText(payload)
    const artifacts = await storeHarnessImages(payload?.artifacts, options, isTrustedOutput(payload), payload.trustedOutputDeadlineAt)
    if (isTrustedOutput(payload)) {
        assertDeliveryActive(options, payload.trustedOutputDeadlineAt)
        if (!isHarnessReplay(options)) streamStoredImages(options, artifacts)
        deliverTrustedOutput(payload, options)
    }
    return artifacts.length ? text + ARTIFACTS_PREFIX + JSON.stringify(artifacts) : text
}

// Tool names the model may call: lowercase letters, digits and underscores, at most 64 characters.
const HARNESS_TOOL_NAME_MAX = 64

type HarnessToolCard = {
    id: string
    label?: unknown
    name?: unknown
}

type FlowNodeLike = {
    id?: string
    data?: {
        id?: string
        name?: string
        label?: unknown
        inputs?: { tools?: unknown; harnessName?: unknown }
    }
}

type FlowEdgeLike = { source?: string; target?: string; targetHandle?: string }

function textOf(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

// A stored id may be a number. 0 is a real id, and it must not be treated as missing.
function cardIdOf(value: unknown): string {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    return textOf(value)
}

// One pass, no anchored expression, so a very long title stays linear.
function sanitizeHarnessToolToken(value: string): string {
    const lower = value.toLowerCase().slice(0, 1024)
    let out = ''
    let prevUnderscore = false
    for (let i = 0; i < lower.length; i += 1) {
        const code = lower.charCodeAt(i)
        const digit = code >= 48 && code <= 57
        const letter = code >= 97 && code <= 122
        if (digit || letter) {
            out += lower[i]
            prevUnderscore = false
            continue
        }
        if (!prevUnderscore && out.length) {
            out += '_'
            prevUnderscore = true
        }
    }
    if (out.endsWith('_')) out = out.slice(0, -1)
    // A model tool name cannot start with a digit. Prefix before any suffix is added, then cap the length.
    if (out && out.charCodeAt(0) >= 48 && out.charCodeAt(0) <= 57) out = `h_${out}`
    return out.slice(0, HARNESS_TOOL_NAME_MAX)
}

function isDefaultTitle(label: string): boolean {
    return label.toLowerCase() === 'harness'
}

// One Harness card on an agent stays harness, whatever its title, so an existing tool:harness call still works.
// A title is used only when two or more Harness cards are on that agent. A title that is still Harness uses the saved name.
function baseToolName(card: HarnessToolCard, alone: boolean): string {
    if (alone) return 'harness'
    const label = textOf(card.label)
    if (label && !isDefaultTitle(label)) {
        const token = sanitizeHarnessToolToken(label)
        if (token) return token
    }
    const named = sanitizeHarnessToolToken(textOf(card.name))
    if (named && named !== 'harness') return named
    return 'harness'
}

// Fit `base + suffix` into 64 characters. The suffix is kept whole when it is short enough.
function withLiteralSuffix(base: string, suffix: string): string {
    const room = Math.max(HARNESS_TOOL_NAME_MAX - suffix.length, 1)
    let stem = (base || 'harness').slice(0, room)
    while (stem.endsWith('_')) stem = stem.slice(0, -1)
    if (!stem) stem = 'h'
    return `${stem.slice(0, HARNESS_TOOL_NAME_MAX - suffix.length)}${suffix}`
}

// FNV-1a, 32 bits, as hex. A pure function of the raw id.
function fnv1a32(text: string): string {
    let hash = 0x811c9dc5
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}

// Suffix text taken from the id. When sanitizing drops case, punctuation, or characters past 32,
// a mark of the raw id is kept so two different ids cannot land on one suffix.
function stableIdToken(id: string): string {
    const full = sanitizeHarnessToolToken(id) || 'id'
    const token = full.slice(0, 32)
    if (full.length <= 32 && token === id) return token
    const mark = fnv1a32(id)
    const room = Math.max(32 - mark.length - 1, 1)
    let stem = token.slice(0, room)
    while (stem.endsWith('_')) stem = stem.slice(0, -1)
    if (!stem) stem = 'id'
    return `${stem}_${mark}`
}

// `__` cannot appear in a sanitized title or id token, so one card's title cannot spell another's name.
// The suffix is this card's own id. It does not depend on which other cards are present.
function withIdSuffix(base: string, id: string): string {
    return withLiteralSuffix(base, `__${stableIdToken(id)}`)
}

// harness_2 before harness_10, and harness_tool_2 before harness_tool_10. Text order would not.
function compareIds(left: string, right: string): number {
    const a = left.split(/(\d+)/)
    const b = right.split(/(\d+)/)
    const count = Math.max(a.length, b.length)
    for (let i = 0; i < count; i += 1) {
        const ap = a[i] ?? ''
        const bp = b[i] ?? ''
        const aNum = /^\d+$/.test(ap)
        const bNum = /^\d+$/.test(bp)
        if (aNum && bNum) {
            const diff = Number(ap) - Number(bp)
            if (diff !== 0) return diff < 0 ? -1 : 1
        } else if (ap !== bp) {
            return ap < bp ? -1 : 1
        }
    }
    return 0
}

/**
 * One tool name per card. A lone card is harness. Every other name is the sanitized title, or the
 * saved harness name when the title is still Harness, then `__` and that card's own id. Nothing else
 * in the list is an input, so deleting another card cannot change it, and a title cannot spell it.
 */
function assignHarnessToolNames(cards: HarnessToolCard[]): Map<string, string> {
    const items = (Array.isArray(cards) ? cards : []).map((card, index) => ({
        card: card || { id: '' },
        index,
        id: cardIdOf(card?.id) || `harness_${index}`
    }))
    const alone = items.length === 1
    const used = new Set<string>()
    const names = new Map<string, string>()
    for (const item of items) {
        if (names.has(item.id)) continue
        if (alone) {
            names.set(item.id, 'harness')
            continue
        }
        const base = baseToolName(item.card, false)
        let candidate = withIdSuffix(base, item.id)
        if (used.has(candidate)) candidate = withLiteralSuffix(candidate, `_${fnv1a32(`${base}\0${item.id}`)}`)
        if (used.has(candidate)) candidate = withLiteralSuffix(base, `_${fnv1a32(`${item.id}\0${base}\0${item.index}`)}`)
        names.set(item.id, candidate)
        used.add(candidate)
    }
    return names
}

const TOOL_REF = /^\{\{([^}]+)\.data\.instance\}\}$/

function flowNodeId(node: FlowNodeLike): string {
    if (typeof node?.id === 'string' && node.id) return node.id
    return typeof node?.data?.id === 'string' ? node.data.id : ''
}

function isHarnessFlowNode(node: FlowNodeLike | undefined): boolean {
    return node?.data?.name === 'harness'
}

function toolRefIds(node: FlowNodeLike): string[] {
    const tools = node?.data?.inputs?.tools
    if (!Array.isArray(tools)) return []
    const ids: string[] = []
    for (const item of tools) {
        if (typeof item !== 'string') continue
        const match = TOOL_REF.exec(item.trim())
        if (match) ids.push(match[1])
    }
    return ids
}

function edgeFeedsTools(edge: FlowEdgeLike): boolean {
    const handle = typeof edge?.targetHandle === 'string' ? edge.targetHandle : ''
    return handle.split('-')[2] === 'tools'
}

function cardFromFlowNode(id: string, node: FlowNodeLike | undefined): HarnessToolCard {
    const harnessName = node?.data?.inputs?.harnessName
    return {
        id,
        label: node?.data?.label,
        name: typeof harnessName === 'string' ? harnessName : undefined
    }
}

function flowIndex(nodes: FlowNodeLike[]): Map<string, FlowNodeLike> {
    const byId = new Map<string, FlowNodeLike>()
    for (const node of nodes) {
        const id = flowNodeId(node)
        if (id) byId.set(id, node)
    }
    return byId
}

function harnessIdsOnAgent(agentId: string, byId: Map<string, FlowNodeLike>, edges?: FlowEdgeLike[]): string[] {
    const ids = new Set<string>()
    for (const id of toolRefIds(byId.get(agentId) || {})) {
        if (isHarnessFlowNode(byId.get(id))) ids.add(id)
    }
    if (Array.isArray(edges)) {
        for (const edge of edges) {
            if (!edge || edge.target !== agentId || !edgeFeedsTools(edge) || typeof edge.source !== 'string') continue
            if (isHarnessFlowNode(byId.get(edge.source))) ids.add(edge.source)
        }
    }
    return [...ids]
}

function agentIdsForHarness(nodeId: string, byId: Map<string, FlowNodeLike>, edges?: FlowEdgeLike[]): string[] {
    const agents = new Set<string>()
    for (const [id, node] of byId) {
        if (id === nodeId) continue
        if (toolRefIds(node).includes(nodeId)) agents.add(id)
    }
    if (Array.isArray(edges)) {
        for (const edge of edges) {
            if (!edge || edge.source !== nodeId || !edgeFeedsTools(edge) || typeof edge.target !== 'string') continue
            agents.add(edge.target)
        }
    }
    return [...agents].sort(compareIds)
}

function cardsOnAgent(agentId: string, byId: Map<string, FlowNodeLike>, edges?: FlowEdgeLike[]): HarnessToolCard[] {
    return harnessIdsOnAgent(agentId, byId, edges).map((id) => cardFromFlowNode(id, byId.get(id)))
}

function nameFreeOnAgents(name: string, agents: string[], taken: Map<string, Set<string>>): boolean {
    return agents.every((agentId) => !taken.get(agentId)?.has(name))
}

// A name this card can keep after another card is removed. The suffix is its own id, not _1, _2, …
function firstFreeOnAgents(stem: string, selfId: string, agents: string[], taken: Map<string, Set<string>>): string {
    const byId = withIdSuffix(stem || 'harness', selfId)
    if (nameFreeOnAgents(byId, agents, taken)) return byId
    const marked = withLiteralSuffix(byId, `_${fnv1a32(`${stem}\0${selfId}`)}`)
    if (nameFreeOnAgents(marked, agents, taken)) return marked
    return withLiteralSuffix(stem || 'harness', `_${fnv1a32(`${selfId}\0${stem}`)}`)
}

function reserveOnAgents(name: string, agents: string[], taken: Map<string, Set<string>>): void {
    for (const agentId of agents) {
        const set = taken.get(agentId) || new Set<string>()
        set.add(name)
        taken.set(agentId, set)
    }
}

// True when this card is the only Harness on at least one agent. That agent must call it harness.
function loneOnAnyAgent(id: string, agentsOf: Map<string, string[]>, byId: Map<string, FlowNodeLike>, edges?: FlowEdgeLike[]): boolean {
    const agents = agentsOf.get(id) || []
    return agents.some((agentId) => harnessIdsOnAgent(agentId, byId, edges).length === 1)
}

/**
 * One tool name for a Harness card when the caller has no agent. A card that is the only Harness on
 * any agent is named harness when that name is free on every agent the card touches. That single name
 * cannot serve two agents that are each the only user of a different card. Those names are
 * assignFlowHarnessToolNames, one map per agent.
 */
function sharedHarnessToolNames(nodes: FlowNodeLike[], edges?: FlowEdgeLike[]): Map<string, string> {
    const byId = flowIndex(Array.isArray(nodes) ? nodes : [])
    const harnessIds = [...byId.keys()].filter((id) => isHarnessFlowNode(byId.get(id))).sort(compareIds)
    const agentsOf = new Map<string, string[]>()
    const agentIds = new Set<string>()
    for (const id of harnessIds) {
        const agents = agentIdsForHarness(id, byId, edges)
        agentsOf.set(id, agents)
        for (const agentId of agents) agentIds.add(agentId)
    }

    const local = new Map<string, Map<string, string>>()
    for (const agentId of agentIds) {
        local.set(agentId, assignHarnessToolNames(cardsOnAgent(agentId, byId, edges)))
    }

    const ordered = [...harnessIds].sort((left, right) => {
        const leftLone = loneOnAnyAgent(left, agentsOf, byId, edges) ? 0 : 1
        const rightLone = loneOnAnyAgent(right, agentsOf, byId, edges) ? 0 : 1
        if (leftLone !== rightLone) return leftLone - rightLone
        return compareIds(left, right)
    })

    const taken = new Map<string, Set<string>>()
    const names = new Map<string, string>()
    for (const id of ordered) {
        const agents = agentsOf.get(id) || []
        if (!agents.length) {
            const alone = assignHarnessToolNames([cardFromFlowNode(id, byId.get(id))]).get(id) || 'harness'
            names.set(id, alone)
            continue
        }
        const candidates: string[] = []
        for (const agentId of agents) {
            const name = local.get(agentId)?.get(id)
            if (name && !candidates.includes(name)) candidates.push(name)
        }
        const lone = loneOnAnyAgent(id, agentsOf, byId, edges)
        const chosen =
            lone && nameFreeOnAgents('harness', agents, taken)
                ? 'harness'
                : candidates.find((name) => nameFreeOnAgents(name, agents, taken)) ||
                  firstFreeOnAgents(candidates[0] || 'harness', id, agents, taken)
        names.set(id, chosen)
        reserveOnAgents(chosen, agents, taken)
    }
    return names
}

/**
 * Tool name of each Harness card on each agent. A lone card is harness on that agent, including when
 * the same card also sits beside another Harness on a second agent, and including when each of two
 * cards is the only Harness on its own agent. One global name cannot do both.
 */
function assignFlowHarnessToolNames(nodes: FlowNodeLike[], edges?: FlowEdgeLike[]): Map<string, Record<string, string>> {
    const byId = flowIndex(Array.isArray(nodes) ? nodes : [])
    const harnessIds = [...byId.keys()].filter((id) => isHarnessFlowNode(byId.get(id))).sort(compareIds)
    const agentIds = new Set<string>()
    for (const id of harnessIds) {
        for (const agentId of agentIdsForHarness(id, byId, edges)) agentIds.add(agentId)
    }
    const byAgent = new Map<string, Record<string, string>>()
    for (const agentId of agentIds) {
        byAgent.set(agentId, Object.fromEntries(assignHarnessToolNames(cardsOnAgent(agentId, byId, edges))))
    }
    return byAgent
}

/**
 * Tool name for one Harness card. Pass the agent id to get the name on that agent. Without an agent
 * id, the result is the single shared name from sharedHarnessToolNames.
 */
function harnessToolNameFromFlow(nodeId: string, nodes: FlowNodeLike[], edges?: FlowEdgeLike[], agentId?: string): string {
    const list = Array.isArray(nodes) ? nodes : []
    const byId = flowIndex(list)
    const self = byId.get(nodeId)
    if (!isHarnessFlowNode(self)) return 'harness'
    if (typeof agentId === 'string' && agentId) {
        const onAgent = assignFlowHarnessToolNames(list, edges).get(agentId)
        if (onAgent && typeof onAgent[nodeId] === 'string') return onAgent[nodeId]
    }
    return sharedHarnessToolNames(list, edges).get(nodeId) || 'harness'
}

/**
 * Harness cards that share an agent with this card, including this card.
 * A card that is not attached to an agent is a group of one. The tool name itself is
 * harnessToolNameFromFlow, which counts a collision only inside one agent.
 */
function harnessToolPeersFromFlow(nodeId: string, nodes: FlowNodeLike[], edges?: FlowEdgeLike[]): HarnessToolCard[] {
    const list = Array.isArray(nodes) ? nodes : []
    const byId = flowIndex(list)
    const self = byId.get(nodeId)
    if (!isHarnessFlowNode(self)) return []
    const agentIds = agentIdsForHarness(nodeId, byId, edges)
    if (!agentIds.length) return [cardFromFlowNode(nodeId, self)]
    const ids = new Set<string>()
    for (const agentId of agentIds) {
        for (const id of harnessIdsOnAgent(agentId, byId, edges)) ids.add(id)
    }
    if (!ids.has(nodeId)) ids.add(nodeId)
    return [...ids].map((id) => cardFromFlowNode(id, byId.get(id)))
}

function cardFromNodeData(nodeData: INodeData): HarnessToolCard {
    const harnessName = nodeData?.inputs?.harnessName
    return {
        id: cardIdOf(nodeData?.id) || 'harness_0',
        label: nodeData?.label,
        name: typeof harnessName === 'string' ? harnessName : undefined
    }
}

function peersForNode(nodeData: INodeData, options: ICommonObject): HarnessToolCard[] {
    const self = cardFromNodeData(nodeData)
    const raw = options?.harnessToolPeers
    if (!Array.isArray(raw) || !raw.length) return [self]
    const cards: HarnessToolCard[] = []
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue
        const id = cardIdOf((item as { id?: unknown }).id)
        if (!id) continue
        cards.push({
            id,
            label: (item as { label?: unknown }).label,
            name: (item as { name?: unknown }).name
        })
    }
    if (!cards.length) return [self]
    if (!cards.some((card) => card.id === self.id)) cards.push(self)
    return cards
}

function harnessToolNameFor(nodeData: INodeData, options: ICommonObject): string {
    const explicit = textOf(options?.harnessToolName)
    if (explicit && /^[a-z0-9_]+$/.test(explicit)) return explicit.slice(0, HARNESS_TOOL_NAME_MAX)
    const self = cardFromNodeData(nodeData)
    return assignHarnessToolNames(peersForNode(nodeData, options)).get(self.id) || 'harness'
}

function selectedHarness(nodeData: INodeData): string {
    const harnessName: unknown = nodeData.inputs?.harnessName
    if (harnessName === undefined || harnessName === null || harnessName === '') {
        throw harnessFailure('Harness cannot run: no harness name is selected.')
    }
    // A list or an object would be turned into a name further down; only text names a harness.
    if (typeof harnessName !== 'string') {
        throw harnessFailure('Harness cannot run: the harness name is not text. Pick the harness again on this card.')
    }
    return harnessName
}

// An agent rewrites the request into a long task, and Harness Prime then routes the rewrite instead of the person's
// message. By default the tool hands Harness Prime the message the person sent, as a direct harness run does.
function harnessToolInput(nodeData: INodeData, userMessage: string, task: string): string {
    const source = nodeData.inputs?.inputSource
    const agentTask = typeof task === 'string' ? task : String(task ?? '')
    if (source === 'agent') return agentTask
    return typeof userMessage === 'string' && userMessage.trim() ? userMessage : agentTask
}

// What rides with a tool run besides the routed input: the agent's own task and which of the two was routed.
function harnessToolMetadata(nodeData: INodeData, userMessage: string, task: string): { agentTask: string; inputSource: 'user' | 'agent' } {
    const agentTask = typeof task === 'string' ? task : String(task ?? '')
    const usedUser = nodeData.inputs?.inputSource !== 'agent' && typeof userMessage === 'string' && Boolean(userMessage.trim())
    return { agentTask, inputSource: usedUser ? 'user' : 'agent' }
}

// The chat saves the harness trace with the agent's reply when the harness ran as a tool (buildChatflow reads it).
function rememberToolPayload(options: ICommonObject, payload: unknown) {
    const holder = options?.harnessToolPayloads
    if (!Array.isArray(holder) || !payload || typeof payload !== 'object') return
    const { artifacts: _artifacts, ...rest } = payload as Record<string, unknown>
    holder.push(rest)
}

function harnessToolDescription(harnessName: string, toolName: string): string {
    // A single card with no title of its own keeps this sentence, so an existing system message still matches.
    const call =
        toolName === 'harness'
            ? 'Call this tool, named harness, only when the system message routes the task to tool:harness. '
            : `Call this tool, named ${toolName}, only when the system message routes the task to tool:${toolName}. `
    return (
        `Harness workflow "${harnessName}". ` +
        call +
        'Document and vector-store questions go to the researcher. Database questions go to the analyst. ' +
        'Do not call it for ordinary questions the other tools already cover. ' +
        'Input is the task to hand to Harness Prime.'
    )
}

function flattenTools(tools: unknown): any[] {
    if (tools == null) return []
    const source = Array.isArray(tools) ? tools : [tools]
    const out: any[] = []
    for (const item of source) {
        if (Array.isArray(item)) {
            for (const inner of item) out.push(inner)
        } else {
            out.push(item)
        }
    }
    return out
}

function cardFromTool(tool: any): HarnessToolCard | undefined {
    const raw = tool?.harnessCard
    if (!raw || typeof raw !== 'object') return undefined
    const id = textOf(raw.id) || (typeof raw.id === 'number' && Number.isFinite(raw.id) ? String(raw.id) : '')
    if (!id) return undefined
    return { id, label: raw.label, name: raw.name }
}

// A shallow copy that keeps getters, so a shared tool object is not changed for another agent.
function cloneNamedTool(tool: any, name: string, card: HarnessToolCard): any {
    const clone = Object.create(Object.getPrototypeOf(tool))
    for (const key of Reflect.ownKeys(tool)) {
        const desc = Object.getOwnPropertyDescriptor(tool, key)
        if (desc) Object.defineProperty(clone, key, desc)
    }
    clone.name = name
    const harnessName = textOf(card.name) || name
    clone.description = harnessToolDescription(harnessName, name)
    return clone
}

/**
 * Names for the Harness tools on this agent only. A tool that is already correct is left as it is.
 * A tool whose name must differ is copied, so the shared instance other agents hold stays unchanged.
 */
export function prepareAgentTools(tools: unknown): any[] {
    const list = flattenTools(tools)
    const cards: HarnessToolCard[] = []
    const stamped: Array<HarnessToolCard | undefined> = []
    for (const tool of list) {
        const card = cardFromTool(tool)
        stamped.push(card)
        if (card) cards.push(card)
    }
    if (!cards.length) return list
    const names = assignHarnessToolNames(cards)
    return list.map((tool, index) => {
        const card = stamped[index]
        if (!card || !tool || typeof tool !== 'object') return tool
        const name = names.get(card.id)
        if (!name || tool.name === name) return tool
        return cloneNamedTool(tool, name, card)
    })
}

const FLOW_OPTION_KEYS = [
    'appDataSource',
    'databaseEntities',
    'logger',
    'orgId',
    'workspaceId',
    'chatflowid',
    'cachePool',
    'baseURL',
    'componentNodes',
    'usageCacheManager',
    'updateStorageUsage',
    'checkStorage',
    'harnessCaller'
] as const

function pickFlowOptions(options: ICommonObject): HarnessFlowOptions {
    const flowOptions: HarnessFlowOptions = {}
    for (const key of FLOW_OPTION_KEYS) {
        if (options[key] !== undefined) flowOptions[key] = options[key]
    }
    return flowOptions
}

function payloadText(payload: { text?: string }): string {
    return typeof payload?.text === 'string' && payload.text.length ? payload.text : 'Harness returned no text.'
}

function abortSignalOf(options: ICommonObject): AbortSignal | undefined {
    const value = options?.signal as { aborted?: boolean; addEventListener?: unknown; signal?: AbortSignal } | undefined
    if (value && typeof value.aborted === 'boolean' && typeof value.addEventListener === 'function') return value as AbortSignal
    if (value?.signal && typeof value.signal.aborted === 'boolean') return value.signal
    return undefined
}

type ToolRunManager = {
    handlers?: unknown[]
    getChild?: (tag?: string) => { handlers?: unknown[]; getParentRunId?: () => string | undefined }
}

/**
 * The LangSmith tracers of the Harness tool run, as a child callback manager, so harness model steps show up
 * as child runs of the tool run. Other handlers (the token counter, streamers) are left out: the tool records
 * its usage once and streams through its own events.
 */
function harnessTraceCallbacks(runManager?: ToolRunManager, toolName = 'harness'): CallbackManager | undefined {
    const child = typeof runManager?.getChild === 'function' ? runManager.getChild(toolName) : undefined
    if (!child) return undefined
    const tracers = (child.handlers ?? []).filter((handler) => (handler as { name?: string } | null)?.name === 'langchain_tracer')
    if (!tracers.length) return undefined
    const manager = new CallbackManager(child.getParentRunId?.())
    for (const tracer of tracers) manager.addHandler(tracer as any, true)
    return manager
}

async function runNamedHarness(
    harnessName: string,
    input: string,
    options: ICommonObject,
    streamAnswer: boolean,
    runManager?: { handlers?: unknown[] },
    streamed?: { answer: boolean },
    images: string[] = [],
    metadata?: Record<string, unknown>,
    callbacks?: CallbackManager
) {
    const engine = await loadHarnessEngine()
    const chatId = (options.chatId as string) || (options.sessionId as string)
    if (!chatId) {
        throw harnessFailure('Harness cannot run: chatId is required.')
    }
    const flowOptions = pickFlowOptions(options)
    // Before a span or a run row. A harness in another team exports nothing.
    if (typeof engine.assertHarnessWorkspace === 'function') {
        try {
            engine.assertHarnessWorkspace(harnessName, flowOptions)
        } catch (error) {
            throw harnessFailure((error as Error).message || 'Harness cannot run.', (error as { code?: string }).code)
        }
    }
    const harnessTrace = await openNodeHarnessTrace(harnessName, input, options)
    const forward = harnessOnEvent(options, streamAnswer, runManager, streamed)
    const deferred: Array<{ type: string }> = []
    let runId: string | undefined
    try {
        // Copy the optional method first. A boolean from `typeof engine.runQueuedHarness` does not narrow it.
        const queuedRun = engine.runQueuedHarness
        const run = process.env.CUTTLELY_HARNESS_QUEUE !== 'off' && typeof queuedRun === 'function' ? queuedRun : engine.runHarness
        const payload = await run({
            name: harnessName,
            chatId,
            input,
            source: 'prediction',
            ...(isHarnessReplay(options) ? { trustedOutputPreview: true } : {}),
            traceId: typeof options.executionId === 'string' ? options.executionId : undefined,
            componentNodes: options.componentNodes,
            flowOptions,
            onEvent: (event: { type: string }) => {
                harnessTrace?.event(event as Record<string, unknown>)
                const shaped = event as { type: string; phase?: string; trustedOutput?: boolean }
                if (shaped.trustedOutput && (shaped.type === 'final' || (shaped.type === 'partial' && shaped.phase === 'answer')))
                    deferred.push(event)
                else forward?.(event)
            },
            signal: abortSignalOf(options),
            onRecorded: (row: unknown) => {
                const id = row && typeof row === 'object' ? (row as { id?: unknown }).id : undefined
                if (typeof id === 'string') runId = id
            },
            ...(images.length ? { images } : {}),
            ...(metadata ? { metadata } : {}),
            ...(callbacks ? { callbacks } : {})
        })
        if (isTrustedOutput(payload) && !isHarnessReplay(options) && deferred.length)
            trustedDelivery.set(payload, () => deferred.forEach((event) => forward?.(event)))
        const jobRunId = takeJobRunId(payload)
        if (!runId && jobRunId) runId = jobRunId
        harnessTrace?.finish({ text: typeof payload?.text === 'string' ? payload.text : undefined, runId })
        return payload
    } catch (error) {
        if (!runId && error && typeof error === 'object' && typeof (error as { runId?: unknown }).runId === 'string') {
            runId = (error as { runId: string }).runId
        }
        if ((error as { code?: string }).code !== 'wrong_workspace') harnessTrace?.fail(error, { runId })
        throw harnessFailure((error as Error).message || 'Harness cannot run.', (error as { code?: string }).code)
    }
}

function takeJobRunId(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !('runId' in payload)) return undefined
    const record = payload as { runId?: unknown }
    const runId = typeof record.runId === 'string' ? record.runId : undefined
    delete record.runId
    return runId
}

// Traces stay off unless the server has turned them on. A publish check exports nothing.
// The import stays inside the run so loading this node does not load the tracer.
async function openNodeHarnessTrace(harnessName: string, input: string, options: ICommonObject) {
    if (process.env.CUTTLELY_OTEL_TRACES !== 'true') return undefined
    if (options?.replay || options?.cuttlelyReplay) return undefined
    const { openHarnessRunTrace } = await import('../../../src/otelRunSpans')
    return openHarnessRunTrace({
        name: harnessName,
        workspaceId: typeof options.workspaceId === 'string' ? options.workspaceId : undefined,
        question: input,
        replay: options?.replay === true,
        cuttlelyReplay: options?.cuttlelyReplay === true
    })
}

// The tool is initialized before the prediction run attaches sseStreamer. A streaming Tool Agent
// puts that streamer on CustomChainHandler, which is the runManager when the tool is called.
function streamerFrom(options: ICommonObject, runManager?: { handlers?: unknown[] }) {
    const own = options?.sseStreamer
    if (own && typeof own.streamCustomEvent === 'function') return own
    for (const handler of runManager?.handlers || []) {
        const nested = (handler as { sseStreamer?: { streamCustomEvent?: unknown } })?.sseStreamer
        if (nested && typeof nested.streamCustomEvent === 'function') return nested
    }
    return undefined
}

function harnessOnEvent(
    options: ICommonObject,
    streamAnswer: boolean,
    runManager?: { handlers?: unknown[] },
    streamed?: { answer: boolean }
) {
    const sse = streamerFrom(options, runManager)
    const chatId = (options.chatId as string) || (options.sessionId as string)
    if (!sse || !chatId) return undefined
    let started = false
    return (event: { type: string; phase?: string; text?: string; sources?: unknown }) => {
        const asToken =
            streamAnswer && event.type === 'partial' && event.phase === 'answer' && typeof event.text === 'string' && event.text.length > 0
        // An answer delta also goes out as `token` below. `streamedAsToken` tells a client that reads
        // both events to take the text from `token` only, so each piece is shown once.
        sse.streamCustomEvent(chatId, `harness.${event.type}`, asToken ? { ...event, streamedAsToken: true } : event)
        if (streamAnswer && event.type === 'final' && Array.isArray(event.sources) && event.sources.length) {
            sse.streamSourceDocumentsEvent?.(chatId, event.sources)
        }
        if (!asToken) return
        // Same pair the chat models use: `start` opens the bubble, `token` appends this delta.
        if (!started) {
            sse.streamStartEvent?.(chatId, event.text)
            started = true
        }
        sse.streamTokenEvent?.(chatId, event.text as string)
        if (streamed) streamed.answer = true
    }
}

function harnessFailure(message: string, code?: string) {
    const error = new Error(message) as Error & { harnessError?: boolean; code?: string }
    error.harnessError = true
    error.code = code || 'harness_failed'
    return error
}

module.exports = {
    nodeClass: Harness_Harness,
    assignHarnessToolNames,
    assignFlowHarnessToolNames,
    harnessToolPeersFromFlow,
    harnessToolNameFromFlow,
    prepareAgentTools,
    harnessOnEvent,
    storeHarnessImages,
    harnessToolOutput,
    streamStoredImages,
    uploadedImages,
    recordHarnessToolUsage,
    harnessToolInput,
    harnessToolMetadata,
    rememberToolPayload,
    harnessTraceCallbacks
}
