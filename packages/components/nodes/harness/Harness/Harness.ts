import { DynamicTool } from '@langchain/core/tools'
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
                description: 'Saved harness name. The tool the agent calls is named harness.'
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

    async init(nodeData: INodeData, _input: string, options: ICommonObject): Promise<any> {
        const harnessName = selectedHarness(nodeData)
        const streamed = { answer: false }
        const tool = new DynamicTool({
            name: 'harness',
            description: harnessToolDescription(harnessName),
            returnDirect: nodeData.inputs?.returnDirect !== false && nodeData.inputs?.returnDirect !== 'false',
            func: async (task: string, runManager?: { handlers?: unknown[] }) => {
                const payload = await runNamedHarness(harnessName, task, options, true, runManager, streamed)
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

// Images a specialist wrote this turn arrive as bytes. They are saved in the chat's file storage, and the chat gets
// the usual image artifacts. A publish check replay stores nothing.
async function storeHarnessImages(artifacts: unknown, options: ICommonObject): Promise<Array<{ type: string; data: string }>> {
    const list = Array.isArray(artifacts) ? (artifacts as HarnessImage[]) : []
    const stored: Array<{ type: string; data: string }> = []
    for (const [index, item] of list.entries()) {
        if (!item || typeof item.base64 !== 'string') {
            if (item && typeof item.type === 'string' && typeof item.data === 'string') stored.push({ type: item.type, data: item.data })
            continue
        }
        // buildChatflow marks a publish check with cuttlelyReplay; agentflow runs pass replay.
        if (options?.replay || options?.cuttlelyReplay || !options?.chatflowid || !options?.chatId) continue
        if (item.type !== 'png' && item.type !== 'jpeg') continue
        const base = String(item.name || `image-${index + 1}`)
            .split('/')
            .pop()
            ?.replace(/[^A-Za-z0-9._-]/g, '_')
        const fileName = `harness_${String(item.specialist || 'specialist').replace(/[^A-Za-z0-9_-]/g, '_')}_${Date.now()}_${index}_${base}`
        try {
            const result = await addSingleFileToStorage(
                item.mime || (item.type === 'png' ? 'image/png' : 'image/jpeg'),
                Buffer.from(item.base64, 'base64'),
                fileName,
                options.orgId,
                options.chatflowid,
                options.chatId
            )
            stored.push({ type: item.type, data: result.path })
        } catch (error) {
            console.error('Harness could not store a specialist image:', error instanceof Error ? error.message : error)
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
function streamStoredImages(options: ICommonObject, artifacts: Array<{ type: string; data: string }>) {
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

function selectedHarness(nodeData: INodeData): string {
    const harnessName = nodeData.inputs?.harnessName as string
    if (!harnessName) {
        throw harnessFailure('Harness cannot run: no harness name is selected.')
    }
    return harnessName
}

function harnessToolDescription(harnessName: string): string {
    return (
        `Harness workflow "${harnessName}". ` +
        'Call this tool, named harness, only when the system message routes the task to tool:harness. ' +
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
    'checkStorage'
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

async function runNamedHarness(
    harnessName: string,
    input: string,
    options: ICommonObject,
    streamAnswer: boolean,
    runManager?: { handlers?: unknown[] },
    streamed?: { answer: boolean },
    images: string[] = []
) {
    const engine = await loadHarnessEngine()
    const chatId = (options.chatId as string) || (options.sessionId as string)
    if (!chatId) {
        throw harnessFailure('Harness cannot run: chatId is required.')
    }
    try {
        // Copy the optional method first. A boolean from `typeof engine.runQueuedHarness` does not narrow it.
        const queuedRun = engine.runQueuedHarness
        const run = process.env.CUTTLELY_HARNESS_QUEUE !== 'off' && typeof queuedRun === 'function' ? queuedRun : engine.runHarness
        return await run({
            name: harnessName,
            chatId,
            input,
            source: 'prediction',
            traceId: typeof options.executionId === 'string' ? options.executionId : undefined,
            componentNodes: options.componentNodes,
            flowOptions: pickFlowOptions(options),
            onEvent: harnessOnEvent(options, streamAnswer, runManager, streamed),
            signal: abortSignalOf(options),
            ...(images.length ? { images } : {})
        })
    } catch (error) {
        throw harnessFailure((error as Error).message || 'Harness cannot run.', (error as { code?: string }).code)
    }
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
    harnessOnEvent,
    storeHarnessImages,
    harnessToolOutput,
    streamStoredImages,
    uploadedImages,
    recordHarnessToolUsage
}
