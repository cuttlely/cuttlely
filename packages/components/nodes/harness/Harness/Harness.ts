import { DynamicTool } from '@langchain/core/tools'
import { CallbackManager } from '@langchain/core/callbacks/manager'
import { ICommonObject, INode, INodeData, INodeOptionsValue, INodeParams } from '../../../src/Interface'
import { HarnessFlowOptions, loadHarnessEngine } from '../engine'
import { addSingleFileToStorage, getFileFromStorage } from '../../../src/storageUtils'
import { ARTIFACTS_PREFIX } from '../../../src/agents'

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
            'Attach a named harness as a tool. The agent calls it when its system message routes a task to tool:harness. A chat whose only node is this harness runs that roster for the message.'
        this.baseClasses = [this.type, 'Tool']
        this.inputs = [
            {
                label: 'Harness',
                name: 'harnessName',
                type: 'asyncOptions',
                loadMethod: 'listHarnesses',
                description:
                    'Saved harness name. As a tool, the name the agent calls comes from this card title. One card titled Harness keeps the tool name harness. Several cards use the title, or this name when the title is still Harness.'
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
        return tool
    }

    async run(nodeData: INodeData, input: string, options: ICommonObject): Promise<any> {
        const harnessName = selectedHarness(nodeData)
        const images = allowsImages(nodeData) ? await uploadedImages(options) : []
        const payload = await runNamedHarness(harnessName, input, options, !options.agentflowRuntime, undefined, undefined, images)
        const stored = await storeHarnessImages(payload.artifacts, options)
        payload.artifacts = stored
        if (!options.agentflowRuntime) streamStoredImages(options, stored)
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
async function storeHarnessImages(artifacts: unknown, options: ICommonObject): Promise<StoredArtifact[]> {
    const list = Array.isArray(artifacts) ? (artifacts as HarnessImage[]) : []
    const stored: StoredArtifact[] = []
    for (const [index, item] of list.entries()) {
        if (!item || typeof item.base64 !== 'string') {
            if (item && typeof item.type === 'string' && typeof item.data === 'string') {
                stored.push({ type: item.type, data: item.data, ...(typeof item.name === 'string' ? { name: item.name } : {}) })
            }
            continue
        }
        // buildChatflow marks a publish check with cuttlelyReplay; agentflow runs pass replay.
        if (options?.replay || options?.cuttlelyReplay || !options?.chatflowid || !options?.chatId) continue
        const mime = typeof item.type === 'string' ? HARNESS_ARTIFACT_MIMES[item.type] : undefined
        if (!mime || (item.mime && item.mime !== mime)) continue
        const isFile = HARNESS_FILE_TYPES.has(item.type as string)
        const base = String(item.name || `${isFile ? 'file' : 'image'}-${index + 1}`)
            .split('/')
            .pop()
            ?.replace(/[^A-Za-z0-9._-]/g, '_')
        const fileName = `harness_${String(item.specialist || 'specialist').replace(/[^A-Za-z0-9_-]/g, '_')}_${Date.now()}_${index}_${base}`
        try {
            const result = await addSingleFileToStorage(
                mime,
                Buffer.from(item.base64, 'base64'),
                fileName,
                options.orgId,
                options.chatflowid,
                options.chatId
            )
            stored.push({ type: item.type as string, data: result.path, ...(isFile ? { name: base } : {}) })
        } catch (error) {
            console.error('Harness could not store a specialist file:', error instanceof Error ? error.message : error)
        }
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

async function harnessToolOutput(payload: { text?: string; artifacts?: unknown }, options: ICommonObject): Promise<string> {
    const text = payloadText(payload)
    const artifacts = await storeHarnessImages(payload?.artifacts, options)
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
    return out.slice(0, HARNESS_TOOL_NAME_MAX)
}

function isDefaultTitle(label: string): boolean {
    return label.toLowerCase() === 'harness'
}

// A title the person set wins. Otherwise a lone card stays harness, and several cards use the saved harness name.
function baseToolName(card: HarnessToolCard, alone: boolean): string {
    const label = textOf(card.label)
    if (label && !isDefaultTitle(label)) {
        const token = sanitizeHarnessToolToken(label)
        if (token) return token
    }
    if (alone) return 'harness'
    const named = sanitizeHarnessToolToken(textOf(card.name))
    if (named && named !== 'harness') return named
    return 'harness'
}

function withNumericSuffix(base: string, n: number): string {
    const suffix = `_${n}`
    const room = Math.max(HARNESS_TOOL_NAME_MAX - suffix.length, 1)
    let stem = (base || 'harness').slice(0, room)
    while (stem.endsWith('_')) stem = stem.slice(0, -1)
    if (!stem) stem = 'h'
    return `${stem.slice(0, HARNESS_TOOL_NAME_MAX - suffix.length)}${suffix}`
}

/**
 * One tool name per card. Cards are ordered by id, so the same cards always get the same names.
 * A base only one card wants is kept. When a base repeats, the earliest id keeps it and each later id
 * takes `_2`, `_3`, and so on. A suffix that another card already has moves to the next number.
 */
function assignHarnessToolNames(cards: HarnessToolCard[]): Map<string, string> {
    const items = (Array.isArray(cards) ? cards : []).map((card, index) => ({
        card: card || { id: '' },
        index,
        id: textOf(card?.id) || `harness_${index}`
    }))
    items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.index - b.index))
    const alone = items.length === 1
    const bases = items.map((item) => ({ ...item, base: baseToolName(item.card, alone) }))
    const counts = new Map<string, number>()
    for (const item of bases) counts.set(item.base, (counts.get(item.base) || 0) + 1)
    const used = new Set<string>()
    const names = new Map<string, string>()
    for (const item of bases) {
        if (counts.get(item.base) !== 1 || used.has(item.base)) continue
        names.set(item.id, item.base)
        used.add(item.base)
    }
    for (const item of bases) {
        if (names.has(item.id)) continue
        let n = 2
        let candidate = used.has(item.base) ? withNumericSuffix(item.base, n++) : item.base
        while (used.has(candidate)) candidate = withNumericSuffix(item.base, n++)
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

/**
 * Harness cards that share an agent with this card, including this card.
 * Cards that meet on one agent's tools input are one group, so each of them computes the same names.
 * A card that is not attached to an agent is a group of one.
 */
function harnessToolPeersFromFlow(nodeId: string, nodes: FlowNodeLike[], edges?: FlowEdgeLike[]): HarnessToolCard[] {
    const list = Array.isArray(nodes) ? nodes : []
    const byId = new Map<string, FlowNodeLike>()
    for (const node of list) {
        const id = flowNodeId(node)
        if (id) byId.set(id, node)
    }
    const self = byId.get(nodeId)
    if (!isHarnessFlowNode(self)) return []

    const adj = new Map<string, Set<string>>()
    const ensure = (id: string) => {
        if (!adj.has(id)) adj.set(id, new Set())
    }
    const linkAll = (ids: string[]) => {
        const harnessIds = [...new Set(ids.filter((id) => isHarnessFlowNode(byId.get(id))))]
        for (const id of harnessIds) ensure(id)
        for (let i = 1; i < harnessIds.length; i += 1) {
            adj.get(harnessIds[0])!.add(harnessIds[i])
            adj.get(harnessIds[i])!.add(harnessIds[0])
        }
    }

    for (const node of list) linkAll(toolRefIds(node))

    if (Array.isArray(edges)) {
        const grouped = new Map<string, string[]>()
        for (const edge of edges) {
            if (!edge || !edgeFeedsTools(edge) || typeof edge.source !== 'string' || typeof edge.target !== 'string') continue
            if (!isHarnessFlowNode(byId.get(edge.source))) continue
            const bucket = grouped.get(edge.target) || []
            bucket.push(edge.source)
            grouped.set(edge.target, bucket)
        }
        for (const ids of grouped.values()) linkAll(ids)
    }

    const seen = new Set<string>()
    const component: string[] = []
    const stack = [nodeId]
    while (stack.length) {
        const id = stack.pop() as string
        if (!id || seen.has(id)) continue
        seen.add(id)
        if (!isHarnessFlowNode(byId.get(id))) continue
        component.push(id)
        for (const next of adj.get(id) || []) stack.push(next)
    }

    return component.map((id) => cardFromFlowNode(id, byId.get(id)))
}

function cardFromNodeData(nodeData: INodeData): HarnessToolCard {
    const harnessName = nodeData?.inputs?.harnessName
    return {
        id: typeof nodeData?.id === 'string' && nodeData.id ? nodeData.id : 'harness_0',
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
        const id = textOf((item as { id?: unknown }).id)
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
            traceId: typeof options.executionId === 'string' ? options.executionId : undefined,
            componentNodes: options.componentNodes,
            flowOptions,
            onEvent: (event: { type: string }) => {
                harnessTrace?.event(event as Record<string, unknown>)
                forward?.(event)
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
    harnessToolPeersFromFlow,
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
