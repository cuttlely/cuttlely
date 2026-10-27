import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { readClientSignal } from './abort.mjs'
import { turnBudgetMs } from './budget.mjs'
import {
    ANALYST_SUMMARY_LINE,
    analystPayloadsFor,
    cappedAnalystRowLines,
    chiefContextTokens,
    compactAnalystPageText,
    fitChiefMessages,
    fitHandoff,
    fitSpecialistPrompt,
    groundAnalystSpecialistText,
    isAnalystCapSummary,
    wantsAnalystRows,
    stripTrailingAnalystStatus,
    isAnalystQueryTool,
    sourceNames,
    estimateTokens,
    specialistContextTokens
} from './context.mjs'
import { withModelFallback } from './fallback.mjs'
import { callPrepared, normalizeResult, prepareModule, preparedKind, preparedSchema, splitToolOutput } from './bridge.mjs'
import { emitHarnessEvent } from './events.mjs'
import { CHIEF_MODEL_REQUIRED, HarnessError, STALE_RECORD } from './errors.mjs'
import { assertHarnessCaller } from './caller.mjs'
export { assertHarnessCaller } from './caller.mjs'
import { createRun, hermesBaseUrl, stopRun, waitForRun } from './client.mjs'
import {
    analystCallsFor,
    analystStartCapture,
    beginAnalystCalls,
    dropAnalystCapture,
    endAnalystCalls,
    latestAnalystCursor,
    takeAnalystResults
} from './analyst-capture.mjs'
import { abortGatewayProfile, clearCallerWorkspace, noteCallerWorkspace, setGatewayContext } from './gateway.mjs'
import { analystToolsMissing } from './runtime/analyst-mcp-status.mjs'
import { ANALYST_CURSOR_ERRORS, analystPageRequest, analystPageTask } from './runtime/analyst-page.mjs'
import { analystScopeKey, endAnalystRun, withAnalystScope } from './runtime/analyst-store.mjs'
import { cachedPromptTokens, invokeChat, resolveModel } from './model.mjs'
import {
    compileProfileCached,
    compileTryProfile,
    discardTryProfile,
    noteLiveTry,
    tryProfileName,
    analystTablesNote,
    hasAnalystTool,
    needsAgentLoop,
    routerDialectNote,
    specialistSoul,
    specialistSummary,
    specialistWorkspace
} from './profile.mjs'
import { specialistSessionId } from './specialist-run.mjs'
import {
    hideTurnImageDir,
    namesRoot,
    rootStarts,
    workspaceMaskState,
    scanWorkspaceText,
    mergeTurnArtifacts,
    newTurnImageDir,
    promptImages,
    removeTurnImageDir,
    turnImageNote,
    turnFiles,
    turnImages,
    withPromptImages
} from './images.mjs'
import { prepareHarnessTurnUploads } from './uploads.mjs'
import { acquireTurn, releaseTurn } from './lock.mjs'
import { appendTurn, readPromptContext, sessionKey } from './session.mjs'
import { beginHarnessRun, finishHarnessRun, safeTraceId } from './history.mjs'
import { getHarness, listHarnesses } from './store.mjs'
import { normalizeArithmeticQuestion, validArgs } from './tool-fallback.mjs'
import { buildRunTrace, publicModelLabel, publicSources, publicTask, snapshotSpecialist, sumCallTokens } from './trace.mjs'

const require = createRequire(import.meta.url)
const { guardHarnessRun, setHarnessAvailabilityCheck: setAvailabilityCheck } = require('./availability.cjs')

let runtimeContextFor = null

// Tests pause a draft try after its profile is compiled and before the model runs.
export const runHooks = { afterProfile: null }

export function configureHarnessRuntime({ contextFor } = {}) {
    runtimeContextFor = typeof contextFor === 'function' ? contextFor : null
    setGatewayContext(runtimeContextFor)
}

// Before a run row is opened. A harness with no team is not in the caller's team.
// Both empty is an offline run with no team on either side.
export function assertHarnessWorkspace(name, flowOptions, record) {
    assertHarnessCaller(record?.name || name, flowOptions?.harnessCaller)
    let harness = record
    if (!harness) {
        try {
            harness = getHarness(name)
        } catch {
            return
        }
    }
    if (!harness) return
    const caller = typeof flowOptions?.workspaceId === 'string' ? flowOptions.workspaceId : ''
    const owner = typeof harness.workspaceId === 'string' ? harness.workspaceId : ''
    if (caller !== owner) {
        throw new HarnessError('wrong_workspace', `Harness "${harness.name || name}" belongs to another workspace.`)
    }
}

function ownerFlowOptions(record, callerOptions) {
    const flowOptions = { ...(callerOptions || {}) }
    assertHarnessWorkspace(record?.name, flowOptions, record)
    if (flowOptions.callerChatflowId == null && flowOptions.chatflowid != null) {
        flowOptions.callerChatflowId = flowOptions.chatflowid
    }
    if (record.chatflowId) flowOptions.chatflowid = record.chatflowId
    return flowOptions
}

async function runtimeModuleOptions(record) {
    if (typeof runtimeContextFor !== 'function') return null
    try {
        const runtime = await runtimeContextFor(record)
        if (!runtime?.flowOptions) return null
        return {
            componentNodes: runtime.componentNodes,
            loadNode: runtime.loadNode,
            flowOptions: runtime.flowOptions,
            nodeCache: new Map()
        }
    } catch (error) {
        console.warn(`[harness] ${record?.name || 'harness'} server context unavailable: ${error.message}`)
        return null
    }
}

function traceIdFrom(args) {
    return safeTraceId(args?.traceId) || safeTraceId(args?.flowOptions?.executionId) || safeTraceId(args?.metadata?.executionId)
}

function rememberRun(args, started, pending, result, error) {
    let recorded = pending
    try {
        if (pending) {
            recorded = finishHarnessRun(pending, { result, error, traceId: traceIdFrom(args) }) || pending
        } else {
            const opened = beginHarnessRun({
                id: args?.runId,
                apiKeyId: args?.apiKeyId,
                name: args?.name,
                chatId: args?.chatId,
                source: args?.source,
                startedAt: started,
                input: args?.input,
                traceId: traceIdFrom(args)
            })
            recorded = opened ? finishHarnessRun(opened, { result, error, traceId: traceIdFrom(args) }) : null
        }
    } catch (historyError) {
        console.warn(`[harness] run history was not saved: ${historyError.message}`)
    }
    if (recorded && typeof args?.onRecorded === 'function') {
        try {
            args.onRecorded(recorded)
        } catch {
            // A listener must not fail the turn.
        }
    }
}

// The canvas and Try it pass the draft roster in memory. The saved harness is what external runs read.
export function harnessForTurn(name, record) {
    if (record) {
        if (!record.name || record.name !== name) {
            throw new HarnessError('bad_name', `Harness run record "${record.name || ''}" does not match "${name}".`)
        }
        return record
    }
    const harness = getHarness(name)
    if (!harness) {
        throw new HarnessError('not_found', `Harness "${name}" was not found.`)
    }
    return harness
}

async function runHarnessBody(args = {}) {
    const started = Date.now()
    // A wrong team must not open a run row. Inline and off both reach this function.
    assertHarnessWorkspace(args.name, args.flowOptions, args.record)
    // A publish-check replay keeps no run history. The try profile is still removed below.
    const replay = args.replay === true
    let pending = null
    if (!replay) {
        try {
            pending = beginHarnessRun({
                id: args.runId,
                apiKeyId: args.apiKeyId,
                name: args.name,
                chatId: args.chatId,
                source: args.source,
                startedAt: started,
                input: args.input,
                traceId: traceIdFrom(args)
            })
        } catch (historyError) {
            console.warn(`[harness] run history was not opened: ${historyError.message}`)
        }
    }
    const turnFolders = new Set()
    let result
    let failure = null
    const tryName = args.record?.tryId ? tryProfileName(args.record.tryId) : ''
    if (tryName) noteLiveTry(tryName)
    try {
        // The answer, the trace and every record of the turn leave without workspace paths, whichever path ran.
        result = maskWorkspacePaths(await runHarnessTurn({ ...args, turnFolders }))
        return result
    } catch (error) {
        const masked = maskError(error)
        failure = masked
        throw masked
    } finally {
        // Keep files present until streamed text, final events and the returned payload are masked.
        for (const folder of turnFolders) {
            try {
                removeTurnImageDir(folder)
            } catch {
                // A folder that cannot be removed is left for the next workspace cleanup.
            }
        }
        if (args.record?.tryId) {
            try {
                await discardTryProfile(args.record.tryId)
            } catch (error) {
                console.warn(`[harness] try profile was not removed: ${error.message}`)
            }
        }
        if (replay) {
            try {
                dropAnalystCapture({ harness: args.name, chatId: args.chatId })
            } catch {
                // Dropping the check's captured rows must not hide the run's own error.
            }
        } else {
            rememberRun(args, started, pending, result, failure)
        }
    }
}

async function runHarnessTurn({
    name,
    chatId,
    input,
    baseUrl = hermesBaseUrl(),
    fetchImpl = fetch,
    componentNodes,
    loadNode,
    forceSpecialistFailure,
    metadata,
    timeoutMs,
    modelBaseUrl,
    flowOptions: callerFlowOptions,
    onEvent,
    signal,
    callbacks,
    budgetMs,
    images,
    record,
    replay,
    turnFolders
} = {}) {
    const harness = harnessForTurn(name, record)
    if (!chatId) {
        throw new HarnessError('bad_session', 'Harness cannot run: chatId is required.')
    }
    const turnLock = acquireTurn(name, chatId)
    const analystScope = analystScopeKey(name, chatId)
    try {
        return await withAnalystScope(
            analystScope,
            () =>
                runTurn(harness, {
                    name,
                    chatId,
                    input,
                    baseUrl,
                    fetchImpl,
                    componentNodes,
                    loadNode,
                    forceSpecialistFailure,
                    metadata,
                    timeoutMs,
                    modelBaseUrl,
                    callerFlowOptions,
                    onEvent,
                    signal,
                    callbacks,
                    budgetMs,
                    images,
                    replay,
                    turnFolders
                }),
            { workspace: harness.workspaceId }
        )
    } finally {
        // TEMP tables the analyst made in its own store last for this turn only.
        await endAnalystRun(analystScope).catch(() => {})
        releaseTurn(turnLock)
    }
}

async function runQueuedHarnessBody(args) {
    const queue = await import('./queue.mjs')
    return queue.runQueuedHarness(args)
}

// The server registers the boot-compile refusal. This package does not import the server.
export function setHarnessAvailabilityCheck(check) {
    setAvailabilityCheck(check)
}

export async function runHarness(args = {}) {
    return guardHarnessRun(args?.name, () => runHarnessBody(args))
}

export async function runQueuedHarness(args) {
    return guardHarnessRun(args?.name, () => runQueuedHarnessBody(args))
}

async function runTurn(
    harness,
    {
        name,
        chatId,
        input,
        baseUrl,
        fetchImpl,
        componentNodes,
        loadNode,
        forceSpecialistFailure,
        metadata,
        timeoutMs,
        modelBaseUrl,
        callerFlowOptions,
        onEvent,
        signal,
        callbacks,
        budgetMs,
        images,
        replay,
        turnFolders
    }
) {
    const flowOptions = ownerFlowOptions(harness, callerFlowOptions)
    const callerWorkspace = typeof flowOptions.workspaceId === 'string' ? flowOptions.workspaceId : ''
    if (callerWorkspace) noteCallerWorkspace(harness.name, callerWorkspace)
    try {
        return await runTurnBody(harness, {
            name,
            chatId,
            input,
            baseUrl,
            fetchImpl,
            componentNodes,
            loadNode,
            forceSpecialistFailure,
            metadata,
            timeoutMs,
            modelBaseUrl,
            flowOptions,
            onEvent,
            signal,
            callbacks,
            budgetMs,
            images,
            replay,
            turnFolders
        })
    } finally {
        if (callerWorkspace) clearCallerWorkspace(harness.name)
    }
}

async function runTurnBody(
    harness,
    {
        name,
        chatId,
        input,
        baseUrl,
        fetchImpl,
        componentNodes,
        loadNode,
        forceSpecialistFailure,
        metadata,
        timeoutMs,
        modelBaseUrl,
        flowOptions,
        onEvent,
        signal,
        callbacks,
        budgetMs,
        images,
        replay,
        turnFolders
    }
) {
    assertCurrentRecord(harness)
    const profileStarted = Date.now()
    const needsHermes = (harness.specialists || []).some((specialist) => needsAgentLoop(specialist))
    let roster = harness
    let profileMs = 0
    if (needsHermes) {
        // A try id compiles into its own profile directory. The published profile is not opened for write.
        const compiled = harness.tryId ? compileTryProfile(harness, harness.tryId) : compileProfileCached(harness)
        profileMs = Date.now() - profileStarted
        roster = compiled.roster || harness
    }
    if (typeof runHooks.afterProfile === 'function') {
        await runHooks.afterProfile({ name, tryId: harness.tryId || null, roster })
    }
    const clientSignal = readClientSignal(signal)
    const budget = turnBudgetMs(budgetMs)
    const budgetSignal = budget > 0 ? AbortSignal.timeout(budget) : undefined
    const context = {
        name,
        chatId,
        roster,
        baseUrl,
        fetchImpl,
        modelBaseUrl,
        metadata,
        forceSpecialistFailure,
        limit: timeoutMs ?? 240000,
        modelCache: new Map(),
        moduleOptions: { componentNodes, loadNode, nodeCache: new Map(), flowOptions },
        onEvent,
        clientSignal,
        budgetSignal,
        budgetMs: budget,
        workSignal: combineSignals(clientSignal, budgetSignal),
        // In-process LangSmith tracer callbacks from the calling tool run, so model steps appear as its child runs.
        traceCallbacks: callbacks,
        profileMs,
        profileSkipped: !needsHermes,
        usage: { prompt: 0, completion: 0, cached: 0, cachedSeen: false, seen: false },
        truncated: [],
        calls: [],
        toolLog: [],
        routeSteps: [],
        memoryBlock: '',
        promptMessages: [],
        turnId: crypto.randomUUID(),
        images: promptImages(images),
        turnFolders,
        // Publish-check replay: do not read or write the harness session.
        replay: replay === true
    }
    try {
        // With images, Harness Prime routes even a one-tool roster so it can write what the image shows into the task.
        const direct = context.images.length ? null : directToolSpecialist(roster)
        if (direct) return await runDirectTool(context, direct, input)
        return await runRoster(context, input)
    } catch (error) {
        throwIfClient(context)
        if (overBudget(context) && error?.code !== 'over_budget') {
            throw new HarnessError('over_budget', `Harness "${context.name}" exceeded the ${context.budgetMs}ms turn budget.`)
        }
        throw error
    }
}

function noteUsage(context, reply) {
    const usage = reply?.usage
    if (!usage || typeof usage !== 'object') return null
    const prompt = usage.prompt_tokens ?? usage.input_tokens
    const completion = usage.completion_tokens ?? usage.output_tokens
    if (prompt == null && completion == null) return null
    if (!context.usage) context.usage = { prompt: 0, completion: 0, cached: 0, cachedSeen: false, seen: false }
    const cached = cachedPromptTokens(usage)
    const delta = { prompt: Number(prompt) || 0, completion: Number(completion) || 0, ...(cached != null ? { cached } : {}) }
    context.usage.seen = true
    context.usage.prompt += delta.prompt
    context.usage.completion += delta.completion
    if (cached != null) {
        context.usage.cachedSeen = true
        context.usage.cached = (Number(context.usage.cached) || 0) + cached
    }
    return delta
}

// A Hermes run reports the tokens of all its model calls in the run status. They count toward the turn and show
// on the specialist row, like an in-process specialist's calls.
export function noteHermesUsage(context, specialist, status, timing = {}) {
    const tokens = noteUsage(context, status)
    if (!tokens) return null
    if (!context.calls) context.calls = []
    // One total for the whole specialist turn, including tool time. The run card keeps it.
    // The trace puts it on the specialist span, not a model span, so the model span does not swallow tool time.
    context.calls.push({
        role: 'specialist',
        name: specialist.name,
        model: publicModelLabel(specialist.model),
        fallback: '',
        tokens,
        aggregate: true,
        ...(Number.isFinite(timing.startedAt) ? { startedAt: timing.startedAt } : {}),
        ...(Number.isFinite(timing.endedAt) ? { endedAt: timing.endedAt } : {})
    })
    return tokens
}

// Only a specialist that can write files (Python, file tools or the terminal) can leave an image, and only in the
// folder made for this run (see newTurnImageDir).
function writesFiles(specialist) {
    return Boolean(specialist?.codeExecution || specialist?.fileAccess || specialist?.shell)
}

// The folder that holds every specialist's workspace. Paths under it are hidden in answers (see hideTurnImageDir).
function specialistWorkspaceRoot() {
    return path.resolve(path.dirname(specialistWorkspace('_')))
}

export function turnImageDirFor(specialist) {
    return writesFiles(specialist) && specialist.profileName ? newTurnImageDir(specialistWorkspace(specialist.profileName)) : ''
}

// Images and files (PDF, DOCX, XLSX, PPTX, CSV) from the run's own folder. mergeTurnArtifacts applies the per-turn limits.
export function noteTurnImages(context, specialist, since, dir) {
    if (!writesFiles(specialist) || !dir) return
    const images = turnImages(dir, since, { specialist: specialist.name })
    if (images.length) {
        if (!context.turnImages) context.turnImages = []
        context.turnImages.push(images)
    }
    const files = turnFiles(dir, since, { specialist: specialist.name })
    if (files.length) {
        if (!context.turnFiles) context.turnFiles = []
        context.turnFiles.push(files)
    }
}

function noteTruncated(context, names) {
    if (!context.truncated) context.truncated = []
    for (const name of names || []) {
        if (name && !context.truncated.includes(name)) context.truncated.push(name)
    }
}

function loadPrompt(context) {
    if (context.replay) {
        context.memoryBlock = ''
        context.promptMessages = []
        return []
    }
    const prompt = readPromptContext(context.name, context.chatId)
    context.memoryBlock = prompt.block
    context.promptMessages = (prompt.messages || []).map((message) => {
        if (message?.role !== 'assistant') return message
        return { ...message, content: compactAnalystPageText(message.content) }
    })
    return context.promptMessages
}

function analystCursor(context) {
    return latestAnalystCursor({ harness: context?.name, chatId: context?.chatId })
}

function analystDataTask(context, text) {
    const cursor = analystCursor(context)
    return isAnalystDataTask(text, { hasCursor: Boolean(cursor?.token) && !cursor?.expired })
}

function predictionReport(context, timings) {
    const usage = context.usage
    return {
        tokens: {
            prompt: usage?.seen ? usage.prompt : null,
            completion: usage?.seen ? usage.completion : null,
            // Part of prompt, served from the provider's prompt cache. null when no model call reported it.
            cached: usage?.cachedSeen ? usage.cached : null
        },
        timings: {
            routeMs: timings.routeMs ?? 0,
            specialistsMs: timings.specialistsMs ?? 0,
            handoffMs: timings.handoffMs ?? 0,
            profileMs: context.profileSkipped ? 0 : context.profileMs || 0
        },
        truncated: [...(context.truncated || [])]
    }
}

function reportNote(context) {
    const usage = context.usage
    const cached = usage?.cachedSeen ? ` (cached ${usage.cached})` : ''
    const tokens = usage?.seen ? `in ${usage.prompt}${cached} out ${usage.completion}` : 'in na out na'
    const cut = context.truncated?.length ? context.truncated.join(',') : 'none'
    return `tokens ${tokens}, truncated ${cut}`
}

async function runRoster(context, input) {
    const preparedUploads = prepareHarnessTurnUploads({
        question: String(input ?? ''),
        specialists: context.roster?.specialists || [],
        workspaceFor(specialist) {
            if (!specialist?.profileName || !needsAgentLoop(specialist)) return ''
            return specialistWorkspace(specialist.profileName)
        }
    })
    context.uploadSources = preparedUploads.sources
    context.stagedNotes = preparedUploads.notes
    const question = preparedUploads.question
    context.userText = question
    const history = loadPrompt(context)
    const started = Date.now()
    const steps = await routeSteps(context, question, history)
    const routed = Date.now()
    let results = []
    let finished
    let text
    if (context.directReply) {
        finished = Date.now()
        text = context.directReply
        emit(context, 'partial', { phase: 'answer', text })
    } else {
        results = await runSteps(context, steps)
        finished = Date.now()
        text = await chiefHandoff(context, question, history, results)
    }
    if (!text.trim()) {
        throw new HarnessError('empty_output', `Harness "${context.name}" finished without a Harness Prime answer.`)
    }
    // The stored turn feeds the next prompt and the chat history; it holds file names, never workspace paths.
    text = maskWorkspacePaths(text)
    if (!context.replay) {
        appendTurn(
            context.name,
            context.chatId,
            question,
            text,
            sourceNames(maskWorkspacePaths([...(context.uploadSources || []), ...results.flatMap((result) => result.sources || [])]))
        )
    }
    const timings = { routeMs: routed - started, specialistsMs: finished - routed, handoffMs: Date.now() - finished }
    const agents = results.map((result) => {
        const specialist = (context.roster.specialists || []).find((item) => item.name === result.name)
        return publicAgent(context, specialist || { name: result.name }, result)
    })
    const report = predictionReport(context, timings)
    const routedCalls = roleCalls(context, 'route')
    const handoffCalls = roleCalls(context, 'handoff')
    const routeLast = routedCalls.at(-1)
    const handoffLast = handoffCalls.at(-1)
    const trace = buildRunTrace({
        harness: context.name,
        steps: context.routeSteps,
        agents,
        timings: { ...timings, profileMs: context.profileSkipped ? 0 : context.profileMs || 0 },
        report,
        profileSkipped: context.profileSkipped,
        wallMs: Date.now() - started,
        routeModel: routeLast?.model || '',
        routeTokens: sumCallTokens(routedCalls),
        routeFallback: routeLast?.fallback || '',
        handoffModel: handoffLast?.model || '',
        handoffTokens: sumCallTokens(handoffCalls),
        handoffFallback: handoffLast?.fallback || '',
        handoffStatus: handoffCalls.length ? 'done' : 'skipped',
        routeParse: context.routeParse,
        question
    })
    console.info(
        `[harness] ${context.name} route ${timings.routeMs}ms, specialists ${timings.specialistsMs}ms (` +
            agents.map((agent) => `${agent.name} ${agent.status} ${agent.ms}ms`).join(', ') +
            `), handoff ${timings.handoffMs}ms, profile ${profileNote(context)}, ${reportNote(context)}`
    )
    const sources = [...(context.uploadSources || []), ...results.flatMap((result) => result.sources || [])]
    // Image and file bytes ride on the returned payload only; the Harness node stores them for the chat. Events carry
    // the names.
    const { artifacts, skipped } = mergeTurnArtifacts(context.turnImages || [], context.turnFiles || [])
    if (skipped.length) console.info(`[harness] ${context.name} left out ${skipped.length} file(s) over the per-turn size limit`)
    const payload = { text, harness: context.name, agents, sources, artifacts, timings, report, trace }
    emit(context, 'final', {
        text,
        agents,
        sources,
        artifacts: artifacts.map(({ type, name, specialist }) => ({ type, name, specialist })),
        ...(skipped.length ? { skippedArtifacts: skipped } : {}),
        timings,
        report,
        trace
    })
    return payload
}

// Paths inside any specialist's workspace are shown as file names in every string of a value, keys included: events,
// specialist results and sources, and the turn's result. File bytes are never masked, by field and not by content: a
// "base64" string, and a "data" string holding a base64 data URL (data:<type>;base64,...). Every other field is text
// and is masked. Anything nested deeper than MASK_DEPTH, or a repeated reference to an object being masked, is
// replaced by a placeholder rather than passed on unmasked.
const MASK_DEPTH = 64
const fileBytes = (key, item) => typeof item === 'string' && (key === 'base64' || (key === 'data' && /^data:[^,]*;base64,/i.test(item)))
// A value's toJSON() serializer, own or inherited; a lookup that throws gives THROWS.
const THROWS = Symbol('throws')
const serializerOf = (value) => {
    try {
        const fn = value.toJSON
        return typeof fn === 'function' ? fn : undefined
    } catch {
        return THROWS
    }
}
const maskText = (text) => hideTurnImageDir(text, '', specialistWorkspaceRoot())
export function maskWorkspacePaths(value, depth = 0, open = new WeakSet()) {
    if (typeof value === 'string') return maskText(value)
    if (!value || typeof value !== 'object') return value
    // Raw bytes hold no text to mask.
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value
    if (depth >= MASK_DEPTH || open.has(value)) return '[nested data]'
    // Any other object (a URL, a Date, a class instance) is masked as it would be sent: its toJSON() form, or its own
    // fields.
    const serializer = serializerOf(value)
    if (serializer === THROWS) return '[data]'
    if (serializer) {
        let plain
        try {
            plain = serializer.call(value)
        } catch {
            return '[data]'
        }
        return plain === value ? '[data]' : maskWorkspacePaths(plain, depth + 1, open)
    }
    open.add(value)
    try {
        if (Array.isArray(value)) {
            let out
            try {
                out = Array.from({ length: value.length })
            } catch {
                return '[data]'
            }
            for (let index = 0; index < out.length; index += 1) {
                let item
                try {
                    item = value[index]
                } catch {
                    item = '[data]'
                }
                out[index] = maskWorkspacePaths(item, depth + 1, open)
            }
            return out
        }
        const out = {}
        // Each enumerable own field is read on its own; one that cannot be read (a getter that throws) becomes a
        // placeholder.
        let keys
        try {
            keys = Object.keys(value)
        } catch {
            return '[data]'
        }
        for (const key of keys) {
            let item
            try {
                item = value[key]
            } catch {
                item = '[data]'
            }
            const shown = maskText(key)
            let name = shown
            // Two keys that end up with the same name keep both values, in either order.
            for (let n = 2; Object.hasOwn(out, name); n += 1) name = `${shown} (${n})`
            // A key such as "__proto__" stays a plain field.
            Object.defineProperty(out, name, {
                value: fileBytes(key, item) ? item : maskWorkspacePaths(item, depth + 1, open),
                enumerable: true,
                writable: true,
                configurable: true
            })
        }
        return out
    } finally {
        open.delete(value)
    }
}

// An error leaves with its message, stack and fields masked. One that cannot be changed (a frozen error) is replaced
// by a masked copy with the same prototype, name and fields, such as its code.
export function maskError(error, depth = 0, seen = new WeakSet()) {
    // Masking never throws: anything it cannot read gives a plain placeholder error.
    try {
        return rebuildError(error, depth, seen)
    } catch {
        return new Error('[error]')
    }
}
function rebuildError(error, depth, seen) {
    // A thrown string or object is masked too; other thrown values carry no text.
    if (typeof error === 'string') return maskWorkspacePaths(error)
    if (!error || typeof error !== 'object') return error
    if (!(error instanceof Error)) return maskWorkspacePaths(error)
    // An error that names no workspace folder anywhere is passed on as it is.
    const inherited = ['message', 'name', 'stack'].some((key) => {
        try {
            return mentionsWorkspace(error[key])
        } catch {
            return true
        }
    })
    if (!inherited && !mentionsWorkspace(error)) return error
    if (depth >= 8 || seen.has(error)) return new Error('[nested error]')
    seen.add(error)
    // Otherwise it is rebuilt with the same prototype and every own field (enumerable or not, the cause included),
    // each masked, so a frozen error or a hidden field cannot keep a path.
    const copy = Object.create(Object.getPrototypeOf(error))
    for (const key of Reflect.ownKeys(error)) {
        const field = Object.getOwnPropertyDescriptor(error, key)
        const name = typeof key === 'string' ? maskWorkspacePaths(key) : key
        const masked = { enumerable: field.enumerable, configurable: true }
        // A getter is read once and its value kept, masked.
        let item
        try {
            item = 'value' in field ? field.value : field.get?.call(error)
        } catch {
            item = undefined
        }
        masked.writable = true
        masked.value = fileBytes(key, item) ? item : item instanceof Error ? maskError(item, depth + 1, seen) : maskWorkspacePaths(item)
        Object.defineProperty(copy, name, masked)
    }
    // A message, name or stack read from the prototype (a class getter) is kept as a masked own field.
    for (const key of ['message', 'name', 'stack']) {
        if (Object.hasOwn(copy, key)) continue
        let item
        try {
            item = error[key]
        } catch {
            item = '[error]'
        }
        if (typeof item === 'string' || key in copy)
            Object.defineProperty(copy, key, {
                value: typeof item === 'string' ? maskWorkspacePaths(item) : '[error]',
                enumerable: false,
                writable: true,
                configurable: true
            })
    }
    // A serializer (own or inherited) is replaced by one that masks what the original returns.
    const serializer = serializerOf(error)
    if (serializer) {
        Object.defineProperty(copy, 'toJSON', {
            value: () => {
                try {
                    const plain = serializer.call(error)
                    return plain === error ? '[data]' : maskWorkspacePaths(plain)
                } catch {
                    return '[data]'
                }
            },
            enumerable: false,
            writable: true,
            configurable: true
        })
    }
    seen.delete(error)
    return copy
}

// Whether a value may name the workspaces folder: a string holding it (plain or file-link spelling, keys included),
// or anything the scan cannot see through (a getter that throws, a toJSON() serializer, nesting past MASK_DEPTH),
// which is treated as naming it. A getter (such as an error's stack) is read and its value checked. Own fields are read whether enumerable or not. Cycle-safe.
function mentionsWorkspace(value, root = specialistWorkspaceRoot(), depth = 0, seen = new WeakSet()) {
    if (typeof value === 'string') return namesRoot(value, root)
    if (!value || typeof value !== 'object') return false
    if (seen.has(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false
    if (depth > MASK_DEPTH || serializerOf(value) !== undefined) return true
    seen.add(value)
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'string' && mentionsWorkspace(key, root)) return true
        const field = Object.getOwnPropertyDescriptor(value, key)
        if (!field) return true
        let item
        try {
            item = 'value' in field ? field.value : field.get?.call(value)
        } catch {
            return true
        }
        if (!fileBytes(key, item) && mentionsWorkspace(item, root, depth + 1, seen)) return true
    }
    return false
}

function emit(context, type, data = {}) {
    if (context?.clientSignal?.aborted) return
    // `at` is the event's own clock. The server builds trace spans from these events and does not send a tracer into this process.
    emitHarnessEvent(context?.onEvent, {
        type,
        harness: context?.name,
        chatId: context?.chatId,
        ...maskWorkspacePaths(data),
        at: Date.now()
    })
}

function modelCallRows(calls) {
    const rows = []
    for (const call of calls || []) {
        if (!call || typeof call !== 'object') continue
        const row = {}
        if (call.model) row.model = call.model
        if (Number.isFinite(call.startedAt)) row.startedAt = call.startedAt
        if (Number.isFinite(call.endedAt)) row.endedAt = call.endedAt
        if (call.tokens) {
            row.tokens = {
                prompt: Number(call.tokens.prompt) || 0,
                completion: Number(call.tokens.completion) || 0
            }
        }
        if (call.aggregate === true) row.aggregate = true
        rows.push(row)
    }
    return rows
}

function phaseCalls(context, role, name) {
    const calls = (context?.calls || []).filter((call) => {
        if (role === 'specialist') return call.name === name && (call.role === 'specialist' || call.role === 'fill')
        return call.role === role
    })
    const rows = modelCallRows(calls)
    return rows.length ? { calls: rows } : {}
}

function toolsFor(context, name) {
    return (context.toolLog || [])
        .filter((item) => item.specialist === name && item.status !== 'running')
        .map((item) => `${item.name} ${item.status}`)
}

function emitTool(context, data) {
    if (!context.toolLog) context.toolLog = []
    // A tool's detail (a preview, an error) can quote a workspace path; it is masked before the log, events and trace.
    const detail = data.detail ? hideTurnImageDir(String(data.detail), '', specialistWorkspaceRoot()) : ''
    const callId = typeof data.callId === 'string' ? data.callId.trim() : ''
    const emitted = { ...data, ...(detail ? { detail } : {}) }
    delete emitted.callId
    if (data.phase === 'start') {
        context.toolLog.push({
            specialist: data.specialist,
            name: data.name,
            status: 'running',
            ...('sqlHash' in data
                ? {
                      sqlHash: data.sqlHash,
                      ...(data.sql !== undefined ? { sql: data.sql } : {}),
                      ...(data.sqlTruncated ? { sqlTruncated: true } : {})
                  }
                : {}),
            ...(data.pinned ? { pinned: data.pinned } : {}),
            ...(data.freeSqlWithPin ? { freeSqlWithPin: data.freeSqlWithPin } : {}),
            ...(callId ? { callId } : {})
        })
    } else {
        const open = [...context.toolLog]
            .reverse()
            .find((item) => item.specialist === data.specialist && item.name === data.name && item.status === 'running')
        if (open) {
            open.status = data.error ? 'failed' : 'done'
            if (detail) open.detail = detail
            if (callId) open.callId = callId
        } else {
            context.toolLog.push({
                specialist: data.specialist,
                name: data.name,
                status: data.error ? 'failed' : 'done',
                ...(detail ? { detail } : {}),
                ...(callId ? { callId } : {})
            })
        }
    }
    emit(context, 'tool', emitted)
}

function configuredModel(context, specialist) {
    return publicModelLabel(specialist?.model || context.roster?.chief?.model)
}

function roleCalls(context, role) {
    return (context.calls || []).filter((call) => call.role === role)
}

function specialistEventFields(context, specialist, sources, failed = false) {
    const snap = snapshotSpecialist({
        calls: context.calls,
        tools: context.toolLog,
        name: specialist.name,
        configuredModel: configuredModel(context, specialist),
        failed
    })
    return {
        model: snap.model,
        ...(snap.fallback ? { fallback: snap.fallback } : {}),
        ...(snap.tokens ? { tokens: snap.tokens } : {}),
        ...(snap.tools.length ? { tools: snap.tools } : {}),
        ...(sources ? { sources: publicSources(sources) } : {})
    }
}

function publicAgent(context, specialist, result) {
    const fields = specialistEventFields(context, specialist, result.sources, result.status === 'failed')
    return {
        name: result.name,
        status: result.status,
        ms: result.ms,
        task: publicTask(result.publicTask ?? result.task),
        model: fields.model,
        ...(fields.fallback ? { fallback: fields.fallback } : {}),
        ...(fields.tokens ? { tokens: fields.tokens } : {}),
        ...(fields.tools ? { tools: fields.tools } : {}),
        ...(fields.sources?.length ? { sources: fields.sources } : {}),
        ...(result.error ? { error: result.error } : {})
    }
}

function combineSignals(clientSignal, budgetSignal) {
    if (clientSignal && budgetSignal) return AbortSignal.any([clientSignal, budgetSignal])
    return clientSignal || budgetSignal
}

function throwIfClient(context) {
    if (!context?.clientSignal?.aborted) return
    throw new HarnessError('aborted', 'Client disconnected')
}

function budgetFailure(context, name) {
    return `Specialist "${name}" exceeded the ${context.budgetMs}ms turn budget.`
}

function overBudget(context) {
    return Boolean(context?.budgetSignal?.aborted) && !context?.clientSignal?.aborted
}

function raceSignal(signal, work) {
    if (!signal) return Promise.resolve().then(work)
    if (signal.aborted) return Promise.reject(Object.assign(new Error('The harness run was aborted.'), { name: 'AbortError' }))
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            reject(Object.assign(new Error('The harness run was aborted.'), { name: 'AbortError' }))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        Promise.resolve()
            .then(work)
            .then(
                (value) => {
                    signal.removeEventListener('abort', onAbort)
                    resolve(value)
                },
                (error) => {
                    signal.removeEventListener('abort', onAbort)
                    reject(error)
                }
            )
    })
}

function publicSteps(steps) {
    return (steps || []).map((step) => ({
        specialist: step.specialist?.name || String(step.specialist || ''),
        task: String(step.task ?? ''),
        ...(step.after ? { after: step.after } : {})
    }))
}

function staleRecord(harness) {
    throw new HarnessError(STALE_RECORD, `Harness "${harness.name}" was saved by an older Cuttlely. Open its canvas and save it again.`)
}

function assertCurrentRecord(harness) {
    const model = harness.chief?.model
    const modelObject = model && typeof model === 'object' && !Array.isArray(model)
    if (!modelObject || !model.nodeName) {
        if (modelObject && (model.provider || model.model)) staleRecord(harness)
        throw new HarnessError('missing_model', `Harness "${harness.name}" cannot run: no Harness Prime model. ${CHIEF_MODEL_REQUIRED}`)
    }
    for (const specialist of harness.specialists || []) {
        const explicit = specialist.model
        if (explicit && typeof explicit === 'object' && !explicit.nodeName && (explicit.provider || explicit.model)) staleRecord(harness)
    }
}

function chiefModel(roster) {
    const model = roster.chief?.model
    if (!model?.nodeName) {
        throw new HarnessError('missing_model', `Harness "${roster.name}" cannot run: no Harness Prime model. ${CHIEF_MODEL_REQUIRED}`)
    }
    return model
}

function profileNote(context) {
    return context?.profileSkipped ? 'skipped' : `${context?.profileMs || 0}ms`
}

function fallbackFor(context, specialist) {
    if (specialist?.fallbackModel?.nodeName) return specialist.fallbackModel
    const chief = context.roster?.chief?.fallbackModel
    return chief?.nodeName ? chief : null
}

async function invokeOne(context, model, request, windowMs, controlSignal) {
    const resolved = await resolveModel(model, { ...(context.moduleOptions || {}), modelCache: context.modelCache })
    const parent = request.signal || context.workSignal
    const parts = []
    if (parent) parts.push(parent)
    if (controlSignal) parts.push(controlSignal)
    const deadline = windowMs > 0 ? AbortSignal.timeout(windowMs) : undefined
    if (deadline) parts.push(deadline)
    const signal = parts.length > 1 ? AbortSignal.any(parts) : parts[0]
    try {
        return await invokeChat(resolved, {
            messages: request.messages,
            tools: request.tools,
            json: request.json,
            timeoutMs: Math.min(context.limit, 120000),
            onDelta: request.onDelta,
            signal,
            callbacks: context.traceCallbacks
        })
    } catch (error) {
        if (deadline?.aborted && !context.clientSignal?.aborted && !context.budgetSignal?.aborted && !controlSignal?.aborted) {
            throw new HarnessError('model_slow', `${resolved.label || 'chat model'} did not answer within ${windowMs}ms.`)
        }
        throw error
    }
}

async function callModel(context, model, request) {
    const fallback = request.specialist ? fallbackFor(context, request.specialist) : fallbackFor(context, null)
    let winner = model
    let usedFallback = false
    const startedAt = Date.now()
    const reply = await withModelFallback({
        primary: model,
        fallback,
        onUse: () => {
            usedFallback = true
            console.info(`[harness] ${context.name} fallback ${fallback.label || fallback.nodeName} after ${model.label || model.nodeName}`)
        },
        run: (binding, windowMs, controlSignal) => {
            winner = binding
            return invokeOne(context, binding, request, windowMs, controlSignal)
        }
    })
    const endedAt = Date.now()
    const tokens = noteUsage(context, reply)
    if (!context.calls) context.calls = []
    context.calls.push({
        role: request.role || 'model',
        name: request.specialist?.name || 'chief',
        model: publicModelLabel(winner),
        fallback: usedFallback ? publicModelLabel(winner) : '',
        tokens,
        startedAt,
        endedAt
    })
    return reply
}

export const ROUTE_WHOLE_TASK =
    "When one specialist should do a multi-step data task, copy the user's whole request into that one task. Do not send only the first statement, and do not save later statements for another turn."

export const ROUTE_FOLLOW_UP =
    'Specialists do not see this chat. When the request is a follow-up, such as "and in April?", write the whole request into the task, with what the earlier turns settled: the measure, the filters and the names.'
export const ROUTE_IMAGES =
    'The user attached images. You can see them; specialists cannot. When a task depends on an image, write what the image shows into the task.'

export const ROUTE_ANALYST =
    'Any SQL, database, or analyst-addressed request must go to the analyst. That includes a message that starts with "Analyst:", a SQL verb, or the words "analyst database". Never answer those directly. Never return an empty steps list. When the user says "show more", "next page", or "page N" after a capped analyst result, send that to the analyst. Do not answer it yourself.'
export const ROUTE_ANALYSTS =
    'Several specialists are analysts, each with its own database. Any SQL, database, or analyst-addressed request must go to the analyst whose summary and tables fit it. When several fit, send a step to each of them. That includes a message that starts with "Analyst:", a SQL verb, or the words "analyst database". Never answer those directly. Never return an empty steps list. When the user says "show more", "next page", or "page N" after a capped analyst result, send that to the analyst that returned it. Do not answer it yourself.'
export const ROUTE_CHOOSE_ANALYST =
    'This request is a database task and no analyst was chosen for it. Choose the analyst whose summary and tables fit the request. Choose more than one only when the request needs data from more than one. Reply with JSON only: {"analysts":["NAME"]}.'

export function routeAnalystNote(specialists) {
    const count = (specialists || []).filter((specialist) => hasAnalystTool(specialist)).length
    if (!count) return ''
    return count === 1 ? ROUTE_ANALYST : ROUTE_ANALYSTS
}

export const HANDOFF_GROUNDING =
    'State only rows, counts, amounts, and other data that appear in the specialist results below. If a step did not run, say that plainly. Do not invent a table or a number, and do not ask whether to continue. When a specialist result includes rows, pass those rows through as a table or a list. When it also includes a page line that starts with "rows ", or a summary that starts with "returned ", keep that line after the rows. Never answer with only that count line. Do not echo raw tool JSON. A database change is plain words such as "Dropped table", "Created table", or "Inserted 3 rows".'

// Files a specialist made reach the chat as downloads on their own, once. The answer names them by file name and
// does not repeat a file list or a server path. A step that failed on the way is not reported when the request was
// still answered.
export const HANDOFF_FILES_AND_FAILURES =
    'Files the specialists made are attached to the chat as downloads already: refer to a file by its name only, and do not list the files again or include folder paths. If the results answer the request, do not mention steps or specialists that failed along the way. Only when a needed result is missing, say in one line which part could not be done.'

export const HANDOFF_KEEP_CLOSING =
    'When a specialist result ends with a source, citation or reference line, such as a line that starts with "Source:", end your answer with that line exactly as written.'

// A specialist's closing line, such as "Source: ..." that a playbook requires, survives Harness Prime's rewrite:
// a closing line from the last lines of a completed result that the answer dropped is put back at the end.
const CLOSING_LINE = /^(sources?|citations?|references?|data sources?)\s*:\s*\S/i
const CLOSING_LINE_WINDOW = 3
// No `$`: a failed match cannot rescan the rest of the line. closingTail supplies the end check instead.
const CLOSING_TAIL = /[.!?)]\s+((?:sources?|citations?|references?|data sources?)\s*:\s*\S.*)/i
const isSpace = (ch) => /\s/.test(ch)

// The source has to run to the end of the line, as `.*$` required. `.` stops at a lone \r, U+2028 or U+2029, so a
// match can only start in the short stretch before the last of them: spaces, an optional colon, spaces, the keyword,
// spaces and the punctuation. The match is taken from there and must end where the line ends.
function closingTail(line) {
    let from = Math.max(line.lastIndexOf('\r'), line.lastIndexOf('\u2028'), line.lastIndexOf('\u2029'))
    if (from >= 0) {
        while (from > 0 && isSpace(line[from - 1])) from -= 1
        if (line[from - 1] === ':') from -= 1
        while (from > 0 && isSpace(line[from - 1])) from -= 1
        for (let letters = 0; letters < 16 && from > 0 && /[a-z ]/i.test(line[from - 1]); letters += 1) from -= 1
        while (from > 0 && isSpace(line[from - 1])) from -= 1
        from = Math.max(from - 1, 0)
    }
    const rest = from > 0 ? line.slice(from) : line
    const match = CLOSING_TAIL.exec(rest)
    return match && match.index + match[0].length === rest.length ? match[1].trim() : null
}

export function closingLines(text) {
    const lines = String(text || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    const found = lines.slice(-CLOSING_LINE_WINDOW).filter((line) => CLOSING_LINE.test(line))
    if (found.length || !lines.length) return found
    // A specialist sometimes puts the source at the end of its last sentence instead of on its own line.
    const tail = closingTail(lines.at(-1))
    return tail ? [tail] : []
}

export function keepClosingLines(answer, results) {
    let next = String(answer || '').trimEnd()
    const missing = []
    for (const result of results || []) {
        if (result?.status !== 'completed' || result.ungrounded) continue
        for (const line of closingLines(result.text)) {
            if (!next.includes(line) && !missing.includes(line)) missing.push(line)
        }
    }
    if (!missing.length) return next
    return next ? `${next}\n\n${missing.join('\n')}` : missing.join('\n')
}

export const ANALYST_DID_NOT_RUN = 'The analyst did not run the query.'
export const ANALYST_TOOL_UNAVAILABLE =
    'The analyst tool is unavailable. Hermes has not registered it. Wait a few seconds and send the prompt again, or restart Cuttlely.'
export const ANALYST_TOOL_RETRY =
    'Call the query tool now for the SQL above. Do not answer until that tool returns. Never predict, simulate, or paraphrase a database result or error.'

const ANALYST_DATA_TASK =
    /\b(select|insert|update|delete|drop|create|alter|vacuum|attach|detach|pragma|truncate|table|tables|database|schema|sql|query|rows?)\b/i

export function isAnalystDataTask(text, options) {
    const value = String(text || '')
    if (analystPageRequest(value)) return Boolean(options?.hasCursor)
    if (/^\s*analyst\s*:/i.test(value)) return true
    if (/\banalyst database\b/i.test(value)) return true
    return ANALYST_DATA_TASK.test(value)
}

export const ANALYST_PAGE_NONE = "There's nothing to page yet. Ask your question again and I'll show the first page."
export const ANALYST_PAGE_OWNER_GONE =
    "The analyst that returned that result is no longer on this team. Ask your question again and I'll show the first page."

function rosterAnalysts(specialists) {
    return (specialists || []).filter((specialist) => hasAnalystTool(specialist))
}

// A bare paging phrase is not a specialist task unless this chat still has a live cursor.
// Expiry is known only while the capture still has that cursor and it is past the TTL.
// The cursor belongs to the analyst that returned it. A lone analyst also takes a cursor whose owner was renamed.
export function applyAnalystPageRoute(input, steps, specialists, cursor) {
    const request = analystPageRequest(input)
    const list = Array.isArray(steps) ? steps : []
    if (!request) return { steps: list, reply: '' }
    if (cursor?.expired) return { steps: [], reply: ANALYST_CURSOR_ERRORS.expired }
    if (!cursor?.token) return { steps: [], reply: ANALYST_PAGE_NONE }
    const analysts = rosterAnalysts(specialists)
    if (!analysts.length) return { steps: list, reply: '' }
    const owner = analysts.find((specialist) => specialist.name === cursor.specialist) || (analysts.length === 1 ? analysts[0] : null)
    if (!owner) return { steps: [], reply: ANALYST_PAGE_OWNER_GONE }
    return { steps: [{ specialist: owner, task: analystPageTask(cursor.token, request), paging: true }], reply: '' }
}

// The router can return no steps and Prime then invents a database answer. A data task with one analyst on the
// roster goes to that analyst. With several, analystsToChoose names them and the router picks among them.
export function forceAnalystRoute(input, steps, specialists) {
    const list = Array.isArray(steps) ? [...steps] : []
    if (list.length) return list
    const analysts = rosterAnalysts(specialists)
    if (analysts.length !== 1 || !isAnalystDataTask(input)) return list
    return [{ specialist: analysts[0], task: String(input || '') }]
}

export function analystsToChoose(input, steps, specialists) {
    if (Array.isArray(steps) && steps.length) return []
    const analysts = rosterAnalysts(specialists)
    if (analysts.length < 2 || !isAnalystDataTask(input)) return []
    return analysts
}

// The names the choice call returned that are analysts on this roster. Anything else, or nothing, is every analyst.
export function parseAnalystChoice(content, analysts, input) {
    let parsed = null
    try {
        parsed = JSON.parse(String(content || ''))
    } catch {
        parsed = null
    }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.analysts) ? parsed.analysts : []
    const byName = new Map((analysts || []).map((specialist) => [specialist.name.toLowerCase(), specialist]))
    const chosen = []
    for (const item of list) {
        const specialist = byName.get(
            String(typeof item === 'string' ? item : item?.name || item?.specialist || '')
                .trim()
                .toLowerCase()
        )
        if (specialist && !chosen.includes(specialist)) chosen.push(specialist)
    }
    return (chosen.length ? chosen : analysts || []).map((specialist) => ({ specialist, task: String(input || '') }))
}

export async function chooseAnalysts(context, input, history, analysts) {
    const system = [
        `You choose the analyst for a database request in the "${context.name}" harness.`,
        ROUTE_CHOOSE_ANALYST,
        'Analysts:',
        ...analysts.map((specialist) => routerLine(specialist, analysts.length))
    ].join('\n')
    const fitted = fitChiefMessages({ system, memory: context.memoryBlock || '', history, user: input, budget: chiefContextTokens() })
    noteTruncated(context, fitted.truncated)
    let reply
    try {
        reply = await callModel(context, chiefModel(context.roster), { messages: fitted.messages, json: true, role: 'route' })
    } catch (error) {
        // A stopped or out-of-time turn still stops. Any other failure of this extra call sends the task to every analyst.
        if (context.workSignal?.aborted || context.clientSignal?.aborted || context.budgetSignal?.aborted) throw error
        console.warn(`[harness] ${context.name} analyst choice failed, sending to every analyst`)
        return parseAnalystChoice('', analysts, input)
    }
    return parseAnalystChoice(reply.content, analysts, input)
}

const SQL_VERB = /\b(drop|create|insert|update|delete|select|alter)\b/gi

export function isMultiStepDataTask(text) {
    const value = String(text || '')
    const verbs = value.match(SQL_VERB) || []
    if (verbs.length >= 2) return true
    if (/\bthen\b/i.test(value) && verbs.length >= 1) return true
    // A numbered step starts the text or follows \n, after any whitespace that is not \n (NBSP and \r included).
    if (/(?:^|\n)[^\S\n]*\d+[.)]\s/.test(value) && /\b(table|insert|select|row)\b/i.test(value)) return true
    return false
}

// The router often keeps only the first SQL statement. One specialist still has to receive the whole task.
export function expandSingleSpecialistTask(user, task) {
    const full = String(user ?? '').trim()
    const given = String(task ?? '').trim()
    if (!full) return given
    if (!given) return full
    if (!isMultiStepDataTask(full)) return given
    if (given.length >= full.length * 0.8 && isMultiStepDataTask(given)) return given
    return full
}

function capabilityNote(specialist) {
    const tools = [
        ...(specialist.modules || []).map((mod) => mod.label || mod.nodeName),
        ...(specialist.mcpServers || []).map((mcp) => mcp.label || mcp.serverName || mcp.nodeName)
    ].filter(Boolean)
    if (specialist.browser) tools.push('web browser')
    if (specialist.codeExecution) tools.push('Python')
    if (specialist.fileAccess) tools.push('file write')
    if (specialist.shell) tools.push('shell')
    return tools.length ? ` Tools: ${tools.join(', ')}.` : ''
}

export function routerLine(specialist, analystCount) {
    const tables = analystCount > 1 ? analystTablesNote(specialist) : ''
    return `- ${specialist.name}: ${specialistSummary(specialist, 'No instructions.')}${capabilityNote(specialist)}${tables}`
}

function finishUnpaged(context, reply, started) {
    context.routeSteps = []
    context.directReply = reply
    emit(context, 'route', { phase: 'done', steps: [], ms: Date.now() - started, ...phaseCalls(context, 'route') })
    return []
}

async function routeSteps(context, input, history) {
    const started = Date.now()
    const specialists = context.roster.specialists || []
    const cursor = analystCursor(context)
    // A lone specialist skips routing, unless the turn has images: the specialist cannot see them, so Harness Prime
    // routes and writes what they show into the task.
    if (specialists.length === 1 && !context.images?.length) {
        const routed = applyAnalystPageRoute(input, [{ specialist: specialists[0], task: input }], specialists, cursor)
        if (routed.reply) return finishUnpaged(context, routed.reply, started)
        const steps = routed.steps
        context.routeSteps = publicSteps(steps)
        emit(context, 'route', { phase: 'done', steps: context.routeSteps, ms: Date.now() - started, ...phaseCalls(context, 'route') })
        return steps
    }
    const blocked = applyAnalystPageRoute(input, [], specialists, cursor)
    if (blocked.reply) return finishUnpaged(context, blocked.reply, started)
    emit(context, 'route', { phase: 'start' })
    const analystCount = rosterAnalysts(specialists).length
    const system = [
        `You route work for the "${context.name}" harness.`,
        context.roster.chief?.instructions ? `Harness Prime instructions: ${context.roster.chief.instructions}` : '',
        'Specialists:',
        ...specialists.map((specialist) => routerLine(specialist, analystCount)),
        'Pick every specialist the request needs. Steps run at the same time, so write each task so it stands on its own.',
        ROUTE_AFTER,
        routerDialectNote(specialists),
        routeAnalystNote(specialists),
        ROUTE_WHOLE_TASK,
        ROUTE_FOLLOW_UP,
        context.images?.length ? ROUTE_IMAGES : '',
        'Reply with JSON only: {"steps":[{"specialist":"NAME","task":"...","after":""}]}. Leave "after" empty unless the step needs an earlier step\'s result. Always name at least one specialist.'
    ]
        .filter(Boolean)
        .join('\n')
    const fitted = fitChiefMessages({ system, memory: context.memoryBlock || '', history, user: input, budget: chiefContextTokens() })
    noteTruncated(context, fitted.truncated)
    const routeStream = chiefStream(context, 'route')
    let reply
    try {
        reply = await callModel(context, chiefModel(context.roster), {
            messages: withPromptImages(fitted.messages, context.images),
            json: true,
            role: 'route',
            onDelta: routeStream.onDelta
        })
    } finally {
        routeStream.flush()
    }
    let routed = parseRouteSteps(reply.content, specialists, input)
    if (!routed.ok) {
        // One retry with a fixed JSON-only reminder. Only structural facts about the reply (kind, length, hash
        // prefix) are kept; the reply text itself is never stored, logged or sent back.
        context.routeParse = routeDiagnostics(reply.content, { retried: true })
        console.warn(`[harness] router reply was not JSON; retrying once ${routeLogFields(context)}`)
        const retryMessages = [...fitted.messages, { role: 'user', content: ROUTE_JSON_RETRY }]
        let retry = { content: '' }
        let retryFailed = false
        try {
            retry = await callModel(context, chiefModel(context.roster), {
                messages: withPromptImages(retryMessages, context.images),
                json: true,
                role: 'route'
            })
        } catch (error) {
            // A failed retry still ends at the default specialist; only a stopped run stops here.
            if (context.workSignal?.aborted || context.clientSignal?.aborted || context.budgetSignal?.aborted) throw error
            retryFailed = true
            console.warn(`[harness] router retry failed ${routeLogFields(context)} errorKind=${routeErrorKind(error)}`)
        }
        routed = parseRouteSteps(retry.content, specialists, input)
        if (!routed.ok) {
            const fallback = defaultRouteSpecialist(specialists, context.roster.chief)
            context.routeParse = {
                ...(retryFailed ? context.routeParse : routeDiagnostics(retry.content, { retried: true })),
                fallbackSpecialist: fallback?.name || ''
            }
            console.warn(`[harness] router reply was still not JSON; using the default specialist ${routeLogFields(context)}`)
            routed = { ok: true, steps: fallback ? [{ specialist: fallback, task: input, fallback: true }] : [] }
        }
    }
    // An empty plan (or one naming no roster specialist) is not an answer to route on, so no input-driven analyst route
    // (a lone analyst, the analyst choice call, `show more` paging) widens or steers it: it runs exactly one step on
    // the chief's default specialist. The analyst routes apply only to a plan that named a roster specialist.
    const emptyPlan = !routed.steps.length
    let steps
    if (emptyPlan) {
        steps = withFallbackStep([], specialists, context.roster.chief, input)
    } else {
        let parsedSteps = forceAnalystRoute(input, routed.steps, specialists)
        const choices = analystPageRequest(input) ? [] : analystsToChoose(input, parsedSteps, specialists)
        if (choices.length) parsedSteps = await chooseAnalysts(context, input, history, choices)
        const pageRoute = applyAnalystPageRoute(input, parsedSteps, specialists, cursor)
        if (pageRoute.reply) return finishUnpaged(context, pageRoute.reply, started)
        steps = withFallbackStep(pageRoute.steps, specialists, context.roster.chief, input)
    }
    if (steps.length && (emptyPlan || steps[0].fallback) && !context.routeParse?.fallbackSpecialist) {
        // Record where a plan with no usable step went: the one default specialist.
        context.routeParse = { ...(context.routeParse || {}), fallbackSpecialist: steps.map((step) => step.specialist.name).join(',') }
        console.warn(`[harness] router plan had no usable step; using the fallback route ${routeLogFields(context)}`)
    }
    for (const step of steps) delete step.fallback
    if (steps.length === 1 && !steps[0].paging) steps[0].task = expandSingleSpecialistTask(input, steps[0].task)
    context.routeSteps = publicSteps(steps)
    const routedCalls = roleCalls(context, 'route')
    const last = routedCalls.at(-1)
    emit(context, 'route', {
        phase: 'done',
        steps: context.routeSteps,
        ms: Date.now() - started,
        ...(last?.model ? { model: last.model } : {}),
        ...(last?.fallback ? { fallback: last.fallback } : {}),
        ...(sumCallTokens(routedCalls) ? { tokens: sumCallTokens(routedCalls) } : {}),
        ...(context.routeParse ? publicRouteParse(context.routeParse) : {}),
        ...phaseCalls(context, 'route')
    })
    return steps
}

// A step that needs an earlier step's result names it in "after". It waits for that step and gets its result with
// the task. Only a step listed earlier counts, so steps cannot wait on each other in a loop.
export const ROUTE_AFTER =
    "When a step needs another step's result (for example, the writer turns the numbers the analyst finds into a note), " +
    'list it after that step and add "after": "NAME" to it. It then waits for that step and gets its result with the task.'
const EARLIER_RESULT_CHARS = 6000

// The router is asked for JSON, but a model can wrap it in a code fence, put prose around it, or answer in prose.
// readRouteJson finds the JSON: the whole reply, a fenced block, or the first balanced {...} or [...] in it.
// It returns undefined when there is none.
// A routing reply is a list of steps or an object with a steps list. Other JSON inside prose (for example a config
// snippet the model quoted) is not a route.
function isRouteShape(value) {
    if (Array.isArray(value)) {
        // A bare list counts only when it lists steps; "[]" or a list of hosts in prose is not a route.
        return (
            value.length > 0 &&
            value.every(
                (item) => item && typeof item === 'object' && (typeof item.specialist === 'string' || typeof item.name === 'string')
            )
        )
    }
    return Boolean(value) && typeof value === 'object' && Array.isArray(value.steps)
}

export function readRouteJson(content) {
    const text = String(content ?? '').trim()
    if (!text) return undefined
    const tryParse = (value) => {
        try {
            const parsed = JSON.parse(value)
            return isRouteShape(parsed) ? parsed : undefined
        } catch {
            return undefined
        }
    }
    const whole = tryParse(text)
    if (whole !== undefined) return whole
    // Fences are found with indexOf, not a regular expression, so a long reply stays linear.
    for (let open = text.indexOf('```'); open !== -1; ) {
        const close = text.indexOf('```', open + 3)
        if (close === -1) break
        const body = text.slice(open + 3, close).replace(/^json\b/i, '')
        const fenced = tryParse(body.trim())
        if (fenced !== undefined) return fenced
        open = text.indexOf('```', close + 3)
    }
    // A bounded scan for the first balanced object or array: a routing reply is short, and a long run of
    // unmatched brackets must not turn into quadratic work.
    const scan = text.slice(0, ROUTE_JSON_SCAN_CHARS)
    let attempts = 0
    for (let start = 0; start < scan.length && attempts < ROUTE_JSON_SCAN_TRIES; start += 1) {
        const open = scan[start]
        if (open !== '{' && open !== '[') continue
        attempts += 1
        const slice = balancedSlice(scan, start)
        if (!slice) continue
        const parsed = tryParse(slice)
        if (parsed !== undefined) return parsed
        // A balanced value that is not a route is skipped whole, so a list nested inside it is not read as one.
        start += slice.length - 1
    }
    return undefined
}

function balancedSlice(text, start) {
    const stack = []
    let inString = false
    let escaped = false
    for (let index = start; index < text.length; index += 1) {
        const ch = text[index]
        if (inString) {
            if (escaped) escaped = false
            else if (ch === '\\') escaped = true
            else if (ch === '"') inString = false
            continue
        }
        if (ch === '"') inString = true
        else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']')
        else if (ch === '}' || ch === ']') {
            if (stack.pop() !== ch) return null
            if (!stack.length) return text.slice(start, index + 1)
        }
    }
    return null
}

// The specialist a route that cannot be read goes to: the chief's default when it names a specialist on the
// roster, otherwise the first specialist. Never every specialist.
export function defaultRouteSpecialist(specialists, chief) {
    const list = specialists || []
    const wanted = String(chief?.defaultSpecialist || '')
        .trim()
        .toLowerCase()
    return (wanted && list.find((specialist) => specialist.name.toLowerCase() === wanted)) || list[0] || null
}

// Reads the router reply. ok is false when the reply holds no JSON; steps is then empty.
export function parseRouteSteps(content, specialists, input) {
    const parsed = readRouteJson(content)
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') return { ok: false, steps: [] }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.steps) ? parsed.steps : []
    const byName = new Map(specialists.map((specialist) => [specialist.name.toLowerCase(), specialist]))
    const steps = []
    const seen = new Set()
    for (const item of list) {
        const specialist = byName.get(
            String(item?.specialist || item?.name || '')
                .trim()
                .toLowerCase()
        )
        if (!specialist || seen.has(specialist.name)) continue
        const after = byName.get(
            String(item?.after || '')
                .trim()
                .toLowerCase()
        )
        seen.add(specialist.name)
        steps.push({
            specialist,
            task: String(item.task || input),
            ...(after && after !== specialist && seen.has(after.name) ? { after: after.name } : {})
        })
    }
    return { ok: true, steps }
}

// A plan with no usable step (no JSON, an empty list, or only names not on the roster) goes to one default
// specialist with the whole request: never zero steps, never every specialist. The added step carries
// `fallback: true` so the caller can record route.fallbackSpecialist.
export function withFallbackStep(steps, specialists, chief, input) {
    if (steps.length) return steps
    const fallback = defaultRouteSpecialist(specialists, chief)
    return fallback ? [{ specialist: fallback, task: input, fallback: true }] : []
}

export function parseSteps(content, specialists, input, chief) {
    const parsed = parseRouteSteps(content, specialists, input)
    return withFallbackStep(parsed.ok ? parsed.steps : [], specialists, chief, input)
}

export const ROUTE_JSON_RETRY =
    'Your last reply was not JSON. Do not answer the request. Reply with only the routing JSON: {"steps":[{"specialist":"NAME","task":"...","after":""}]}.'
const ROUTE_JSON_SCAN_CHARS = 20000
const ROUTE_JSON_SCAN_TRIES = 64
export const ROUTE_PARSE_ERRORS = ['empty', 'no_json', 'invalid_json']
const ROUTE_HASH_CHARS = 12

// Structural facts about a router reply that held no route: a fixed error kind, its length and a short hash
// prefix (to tell repeated replies apart). The reply text is never kept.
export function routeDiagnostics(content, { retried = false } = {}) {
    const text = String(content ?? '')
    const trimmed = text.trim()
    const error = !trimmed ? 'empty' : /[{[]/.test(trimmed) ? 'invalid_json' : 'no_json'
    return {
        error,
        rawLength: text.length,
        rawSha256: crypto.createHash('sha256').update(text).digest('hex').slice(0, ROUTE_HASH_CHARS),
        retried: Boolean(retried)
    }
}

// The trace and event fields for a route parse: the same structural facts, nothing else.
export function publicRouteParse(parse) {
    if (!parse?.error) return parse?.fallbackSpecialist ? { fallbackSpecialist: String(parse.fallbackSpecialist) } : {}
    return {
        parseError: ROUTE_PARSE_ERRORS.includes(parse.error) ? parse.error : 'invalid_json',
        rawLength: Number(parse.rawLength) || 0,
        rawSha256: String(parse.rawSha256 || '')
            .replace(/[^0-9a-f]/g, '')
            .slice(0, ROUTE_HASH_CHARS),
        retried: Boolean(parse.retried),
        ...(parse.fallbackSpecialist ? { fallbackSpecialist: String(parse.fallbackSpecialist) } : {})
    }
}

function routeLogFields(context) {
    const fields = publicRouteParse(context.routeParse)
    return [`harness=${context.name}`, `chat=${context.chatId}`, ...Object.entries(fields).map(([key, value]) => `${key}=${value}`)].join(
        ' '
    )
}

// Only the error class name, never its message, which can carry provider or model text.
function routeErrorKind(error) {
    const name = String(error?.name || '')
    return /^[A-Za-z]{1,40}$/.test(name) ? name : 'Error'
}

// Steps without "after" start together. A step with "after" starts when that step finishes, with its result.
export function runSteps(context, steps, run = runStep) {
    const started = new Map()
    const runs = (steps || []).map((step) => {
        const earlier = step.after ? started.get(step.after) : null
        const promise = earlier ? earlier.then((result) => run(context, withEarlierResult(step, result))) : run(context, step)
        started.set(step.specialist.name, promise)
        return promise
    })
    return Promise.all(runs)
}

export function withEarlierResult(step, result) {
    const name = result?.name || step.after
    let note
    if (result?.status === 'completed' && String(result.text || '').trim()) {
        const text = String(result.text).trim()
        const clipped = text.length > EARLIER_RESULT_CHARS ? `${text.slice(0, EARLIER_RESULT_CHARS)}…` : text
        note = `Result from ${name} (use its numbers and facts exactly as given):\n${clipped}`
    } else {
        const reason = String(result?.error || 'no result').trim()
        note = `${name} did not finish (${reason}). Do not make up its result; say it is missing.`
    }
    return { ...step, input: `${step.task}\n\n${note}` }
}

async function runStep(context, step) {
    const { specialist } = step
    const note = context.stagedNotes?.get(specialist.name)
    const given = step.input ?? step.task
    const task = note ? `${given}\n\n${note}` : given
    const started = Date.now()
    throwIfClient(context)
    emit(context, 'specialist', {
        phase: 'start',
        name: specialist.name,
        task: publicTask(step.task),
        model: configuredModel(context, specialist)
    })
    try {
        if (overBudget(context)) throw new HarnessError('over_budget', budgetFailure(context, specialist.name))
        if (context.forceSpecialistFailure === specialist.name) {
            throw new HarnessError('specialist_failed', `Specialist "${specialist.name}" failed.`)
        }
        context._stepTask = task
        let out = await runSpecialistOnce(context, specialist, task)
        throwIfClient(context)
        const dataTask = hasAnalystTool(specialist) && (analystDataTask(context, task) || analystDataTask(context, context.userText))
        if (dataTask && analystQueryCount(context, specialist.name) === 0) {
            out = await runSpecialistOnce(context, specialist, `${task}\n\n${ANALYST_TOOL_RETRY}`)
            throwIfClient(context)
        }
        if (dataTask && analystQueryCount(context, specialist.name) === 0) {
            const unavailable = analystToolsMissing()
            const detail = unavailable ? ANALYST_TOOL_UNAVAILABLE : ANALYST_DID_NOT_RUN
            emitTool(context, {
                phase: 'done',
                specialist: specialist.name,
                name: 'query',
                error: true,
                detail
            })
            out = { text: detail, sources: [], ungrounded: true }
        } else if (dataTask) {
            out = {
                ...out,
                text: groundAnalystSpecialistText(out.text, context.toolLog, specialist.name),
                analystPayloads: analystPayloadsFor(context.toolLog, specialist.name)
            }
        }
        const ms = Date.now() - started
        emit(context, 'specialist', {
            phase: 'done',
            name: specialist.name,
            status: 'completed',
            ms,
            task: publicTask(step.task),
            ...specialistEventFields(context, specialist, out.sources),
            ...phaseCalls(context, 'specialist', specialist.name)
        })
        // Grounding adds analyst payloads after the specialist's own result was masked; the step result is masked whole.
        return maskWorkspacePaths({
            name: specialist.name,
            status: 'completed',
            task,
            publicTask: step.task,
            text: out.text,
            tools: toolsFor(context, specialist.name),
            sources: out.sources || [],
            ms,
            soul: specialistSoul(specialist),
            ...(specialist.handoffChars ? { handoffChars: specialist.handoffChars } : {}),
            ...(out.analystPayloads ? { analystPayloads: out.analystPayloads } : {}),
            ...(out.ungrounded ? { ungrounded: true, error: out.text } : {})
        })
    } catch (error) {
        throwIfClient(context)
        const ms = Date.now() - started
        // A failure can quote a workspace path (a tool error, a traceback); it is masked here, before it reaches events,
        // the trace, the stored message, the run record or the chief's prompt.
        const message = overBudget(context)
            ? budgetFailure(context, specialist.name)
            : hideTurnImageDir(String(error?.message ?? ''), '', specialistWorkspaceRoot())
        emit(context, 'specialist', {
            phase: 'failed',
            name: specialist.name,
            status: 'failed',
            ms,
            error: message,
            task: publicTask(step.task),
            ...specialistEventFields(context, specialist, [], true),
            ...phaseCalls(context, 'specialist', specialist.name)
        })
        // The task can hold staged upload paths; the failed step goes to Prime's prompt masked whole.
        return maskWorkspacePaths({
            name: specialist.name,
            status: 'failed',
            task,
            publicTask: step.task,
            text: '',
            error: message,
            tools: toolsFor(context, specialist.name),
            sources: [],
            ms,
            soul: specialistSoul(specialist)
        })
    }
}

function holdAnalystPartial(context, specialist) {
    if (!hasAnalystTool(specialist)) return false
    const dataTask = analystDataTask(context, context._stepTask) || analystDataTask(context, context.userText)
    if (!dataTask) return false
    return analystQueryCount(context, specialist.name) === 0
}

function emitSpecialistPartial(context, specialist, text) {
    if (!text || holdAnalystPartial(context, specialist)) return
    emit(context, 'partial', { phase: 'specialist', specialist: specialist.name, text })
}

function hermesEventCallId(event) {
    for (const key of ['tool_call_id', 'toolCallId', 'callId']) {
        const value = event?.[key]
        if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200)
    }
    return ''
}

// Keep a scanner per stream so token holds and rule 5 survive delta boundaries.
export function bufferStream(context, key, delta, flush, send, root = specialistWorkspaceRoot()) {
    if (!context._deltaTail) context._deltaTail = new Map()
    let state = context._deltaTail.get(key)
    if (!state) {
        state = workspaceMaskState()
        context._deltaTail.set(key, state)
    }
    const shown = scanWorkspaceText(state, delta, root, flush)
    if (shown) send(shown)
    if (flush) context._deltaTail.delete(key)
}

// Where the last mention of the workspaces folder starts (at its opening quote or file:// link) when no line has
// ended after it, or the text's length.
export function openPathAt(text, root = specialistWorkspaceRoot()) {
    let at = Math.max(-1, ...rootStarts(text, root))
    if (at < 0 || text.indexOf('\n', at) >= 0) return text.length
    if (at > 0 && QUOTE_CHARS.includes(text[at - 1])) at -= 1
    return pathContextAt(text, at)
}

// Where the text's end starts a prefix of the workspaces folder (or its file:// link), or its length when it does not.
export function rootPrefixAt(text, root = specialistWorkspaceRoot()) {
    let at = Math.min(text.length, ...rootStarts(text, root, true))
    // An opening quote just before it (or at the very end) stays with the path, so a quoted path is read whole.
    if (at > 0 && QUOTE_CHARS.includes(text[at - 1])) at -= 1
    return pathContextAt(text, at)
}

// Keep Markdown marks and the preceding word with a path so its start boundary stays intact.
function pathContextAt(text, at) {
    while (at > 0 && /[A-Za-z0-9._*~/-]/.test(text[at - 1])) at -= 1
    return at
}

const QUOTE_CHARS = '"\'`'

function forwardDelta(context, specialist, delta, flush = false) {
    bufferStream(context, `specialist:${specialist.name}`, delta, flush, (text) => emitSpecialistPartial(context, specialist, text))
}

function chiefStream(context, phase) {
    const send = (text) => emit(context, 'partial', { phase, text })
    return {
        onDelta: (text) => bufferStream(context, `chief:${phase}`, String(text ?? ''), false, send),
        flush: () => bufferStream(context, `chief:${phase}`, '', true, send)
    }
}

function forwardHermes(context, specialist, event) {
    const kind = event?.event
    if (kind === 'message.delta' && event.delta) {
        forwardDelta(context, specialist, String(event.delta))
        return
    }
    const data = hermesToolEvent(specialist.name, event)
    const capture = context.analystStarts?.get(specialist.name)
    if (data?.phase === 'start' && isAnalystQueryTool(data.name) && capture) capture.hermesStarted(data)
    else {
        if (data && isAnalystQueryTool(data.name)) capture?.flush()
        if (data) emitTool(context, data)
    }
}

// A code or shell tool result that reports a failure in its own top-level fields: execute_code's
// {"status": "error", ...} or a non-zero exit code. The runtime's error flag is the first signal; this catches a result
// it missed. Only top-level keys count (nested data is ignored) and only for tools that run code, so other tools'
// payloads cannot flip a step's state. The preview may be cut, so this reads the leading object without JSON.parse.
const CODE_TOOLS = new Set(['execute_code', 'terminal', 'process'])
const FAILED_TOP_LEVEL =
    /^\s*\{(?:\s*"[A-Za-z_]+"\s*:\s*(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)\s*,)*?\s*(?:"status"\s*:\s*"(?:error|timeout|interrupted)"|"exit_code"\s*:\s*(?:-\d|[1-9]))/
// The kept tail of a cut error preview: a non-zero exit code as the very last field of the top-level object.
const FAILED_LAST_FIELD = /[,{]\s*"exit_code"\s*:\s*(?:-\d+|[1-9]\d*)\s*\}\s*$/

export function hermesToolFailed(event) {
    if (!event || typeof event !== 'object') return false
    if (event.event === 'tool.failed' || event.error === true) return true
    if (event.event !== 'tool.completed' || typeof event.preview !== 'string') return false
    if (!CODE_TOOLS.has(String(event.tool || event.tool_name || ''))) return false
    let parsed = null
    try {
        parsed = JSON.parse(event.preview)
    } catch {
        // A cut preview is not JSON: read its leading scalar fields, and its last field when the tail is kept.
        return FAILED_TOP_LEVEL.test(event.preview) || FAILED_LAST_FIELD.test(event.preview)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const code = parsed.exit_code
    return ['error', 'timeout', 'interrupted'].includes(parsed.status) || (Number.isInteger(code) && code !== 0)
}

// One Hermes run event as a harness tool step, or null when it is not a tool event. A failed call is a failed
// step, never done.
export function hermesToolEvent(name, event) {
    const kind = event?.event
    if (kind !== 'tool.started' && kind !== 'tool.completed' && kind !== 'tool.failed') return null
    const detail = event.preview ? String(event.preview) : ''
    const callId = hermesEventCallId(event)
    return {
        phase: kind === 'tool.started' ? 'start' : 'done',
        specialist: name,
        name: String(event.tool || event.tool_name || 'tool'),
        ...(kind !== 'tool.started' && hermesToolFailed(event) ? { error: true } : {}),
        ...(detail ? { detail } : {}),
        ...(callId ? { callId } : {})
    }
}

function analystQueryCount(context, name) {
    return (context.toolLog || []).filter((tool) => tool.specialist === name && tool.status !== 'running' && isAnalystQueryTool(tool.name))
        .length
}

async function runSpecialistOnce(context, specialist, task) {
    let out
    try {
        out =
            specialist.profileName && needsAgentLoop(specialist)
                ? await runHermesSpecialist(context, specialist, task)
                : await runInlineSpecialist(context, specialist, task)
    } finally {
        // Streamed text still held back for a whole path is sent, masked, once the specialist stops.
        forwardDelta(context, specialist, '', true)
    }
    // Every specialist's answer and sources, Hermes or inline, reach Harness Prime and the chat without workspace paths.
    return maskWorkspacePaths(out)
}

// Hermes builds its system prompt from the profile's SOUL.md, which already holds the specialist's
// instructions. The run only adds the session memory, so the instructions are not sent twice, and the
// task is sent whole. The memory gets the room the soul leaves in the specialist's context budget.
// Each turn is a new Hermes session, so the specialist sees the last turns of the chat here instead of replaying
// its own session. They come before the older summary, so a full context shortens the summary first.
export const SPECIALIST_TURN_CHARS = 1500

export function recentTurnsText(history = []) {
    const lines = []
    for (const message of history || []) {
        if (message?.role !== 'user' && message?.role !== 'assistant') continue
        const text = typeof message.content === 'string' ? message.content.trim() : ''
        if (!text) continue
        const clipped = text.length > SPECIALIST_TURN_CHARS ? `${text.slice(0, SPECIALIST_TURN_CHARS).trimEnd()} ...` : text
        lines.push(`${message.role === 'user' ? 'User' : 'Answer'}: ${clipped}`)
    }
    return lines.length ? ['Earlier in this chat, for follow-up questions:', ...lines].join('\n') : ''
}

export function hermesSpecialistRequest(
    specialist,
    { memory = '', history = [], task = '', chatId = '', turnId, budget = specialistContextTokens() } = {}
) {
    const soulTokens = estimateTokens(specialistSoul(specialist))
    const fitted = fitSpecialistPrompt({
        name: specialist.name,
        instructions: '',
        memory: [recentTurnsText(history), memory].filter(Boolean).join('\n\n'),
        task,
        budget: budget ? Math.max(1, budget - soulTokens) : budget,
        keepTask: true
    })
    const body = {
        input: fitted.messages.at(-1).content,
        session_id: specialistSessionId(specialist.profileName, chatId, turnId),
        provider: 'custom',
        model: specialist.profileName
    }
    const memoryPrompt = fitted.messages[0].content
    if (memoryPrompt) body.instructions = memoryPrompt
    return { body, truncated: fitted.truncated }
}

async function runHermesSpecialist(context, specialist, task) {
    const imageDir = turnImageDirFor(specialist)
    const { body, truncated } = hermesSpecialistRequest(specialist, {
        memory: context.memoryBlock || '',
        history: context.promptMessages || [],
        task: imageDir ? `${task}\n\n${turnImageNote(imageDir)}` : task,
        chatId: context.chatId,
        turnId: context.turnId
    })
    noteTruncated(context, truncated)
    if (context.metadata) body.metadata = context.metadata
    const request = {
        harnessName: specialist.profileName,
        baseUrl: context.baseUrl,
        fetchImpl: context.fetchImpl,
        timeoutMs: context.limit,
        signal: context.workSignal
    }
    let runId
    const stops = []
    const cancel = () => {
        abortGatewayProfile(specialist.profileName)
        if (!runId) return
        stops.push(
            stopRun({
                harnessName: specialist.profileName,
                runId,
                baseUrl: context.baseUrl,
                fetchImpl: context.fetchImpl
            }).catch(() => {})
        )
    }
    if (context.workSignal?.aborted) cancel()
    const onAbort = () => cancel()
    context.workSignal?.addEventListener('abort', onAbort, { once: true })
    const specialistStarted = Date.now()
    const toolLogStart = context.toolLog?.length || 0
    const startCapture = analystStartCapture((data) => emitTool(context, data))
    if (!context.analystStarts) context.analystStarts = new Map()
    context.analystStarts.set(specialist.name, startCapture)
    beginAnalystCalls(context.name, specialist.name, context.chatId, startCapture.gatewayStarted)
    try {
        const created = await createRun({ ...request, body })
        runId = created.run_id
        if (context.workSignal?.aborted) {
            cancel()
            throw Object.assign(new Error('The harness run was aborted.'), { name: 'AbortError' })
        }
        const status =
            created.output || created.error || !created.run_id
                ? created
                : await waitForRun({
                      ...request,
                      runId: created.run_id,
                      onEvent: (event) => forwardHermes(context, specialist, event)
                  })
        noteHermesUsage(context, specialist, status, { startedAt: specialistStarted, endedAt: Date.now() })
        forwardDelta(context, specialist, '', true)
        if (['failed', 'error', 'cancelled'].includes(status.status)) {
            const failure = status.error || status.message
            throw new HarnessError(
                'specialist_failed',
                failure ? hideTurnImageDir(String(failure), imageDir, specialistWorkspaceRoot()) : `Specialist "${specialist.name}" failed.`
            )
        }
        attachCapturedAnalystResults(context, specialist, specialistStarted, toolLogStart)
        noteTurnImages(context, specialist, specialistStarted, imageDir)
        const text = typeof status.output === 'string' ? hideTurnImageDir(status.output, imageDir, specialistWorkspaceRoot()) : ''
        if (!text.trim()) throw new HarnessError('empty_output', `Specialist "${specialist.name}" returned nothing.`)
        return { text }
    } finally {
        startCapture.flush()
        context.analystStarts.delete(specialist.name)
        endAnalystCalls(context.name, specialist.name, context.chatId)
        context.workSignal?.removeEventListener('abort', onAbort)
        await Promise.all(stops)
        // A turn keeps its folder until its answer is masked; a run outside a turn (warm-up) removes it now.
        if (imageDir && context.turnFolders) context.turnFolders.add(imageDir)
        else {
            try {
                removeTurnImageDir(imageDir)
            } catch {
                // A folder that cannot be removed is left for the next workspace cleanup.
            }
        }
    }
}

function attachCapturedAnalystResults(context, specialist, since, logStart = 0) {
    const captured = takeAnalystResults({ harness: context.name, specialist: specialist.name, chatId: context.chatId, since })
    if (!captured.length) return
    if (!context.toolLog) context.toolLog = []
    const slots = []
    for (let index = logStart; index < context.toolLog.length; index += 1) {
        const tool = context.toolLog[index]
        if (tool.specialist === specialist.name && isAnalystQueryTool(tool.name) && tool.status !== 'running') slots.push(tool)
    }
    // The gateway numbered every analyst call in this run. Use that order only when it
    // lines up with these chips. A missing id is not a reason to fill the first chip.
    const calls = analystCallsFor(context.name, specialist.name, context.chatId)
    if (calls.length > 0 && calls.length === slots.length) {
        slots.forEach((tool, index) => {
            if (!tool.callId && calls[index]?.id) tool.callId = calls[index].id
        })
    }
    const used = new Set()
    for (const item of captured) {
        const callId = item?.callId || ''
        if (!callId) continue
        const slotIndex = slots.findIndex((tool, index) => !used.has(index) && tool.callId === callId)
        if (slotIndex < 0) continue
        used.add(slotIndex)
        slots[slotIndex].detail = maskWorkspacePaths(JSON.stringify({ result: JSON.stringify(item.result) }))
        Object.assign(slots[slotIndex], item.traceFields)
        if (item.timings) slots[slotIndex].timings = item.timings
        if (item.pinned) slots[slotIndex].pinned = item.pinned
        if (item.freeSqlWithPin) slots[slotIndex].freeSqlWithPin = item.freeSqlWithPin
    }
}

function documentsFrom(raw) {
    return splitToolOutput(raw).documents
}

function toolName(prepared, index, used) {
    const base =
        String(prepared.tool?.name || prepared.binding.label || prepared.binding.nodeName || `tool_${index}`)
            .replace(/[^A-Za-z0-9_-]/g, '_')
            .slice(0, 60) || `tool_${index}`
    let name = base
    let n = 2
    while (used.has(name)) name = `${base}_${n++}`
    used.add(name)
    return name
}

async function runInlineSpecialist(context, specialist, task) {
    const model = specialist.model || chiefModel(context.roster)
    const soul = specialistSoul(specialist)
    const modules = specialist.modules || []
    if (!modules.length) {
        const reply = await callModel(context, model, {
            messages: specialistPrompt(context, specialist, task, soul),
            role: 'specialist',
            onDelta: (text) => forwardDelta(context, specialist, String(text ?? '')),
            specialist
        })
        return { text: reply.content }
    }
    const prepared = await Promise.all(modules.map((binding) => prepareModule(binding, task, context.moduleOptions)))
    if (prepared.length === 1 && preparedKind(prepared[0]) === 'query') {
        const label = moduleLabel(prepared[0])
        emitTool(context, { phase: 'start', specialist: specialist.name, name: label })
        const raw = await raceSignal(context.workSignal, () => callPrepared(prepared[0], task))
        const text = normalizeResult(raw)
        emitTool(context, { phase: 'done', specialist: specialist.name, name: label })
        emitSpecialistPartial(context, specialist, text)
        return { text, sources: documentsFrom(raw) }
    }
    const used = new Set()
    const named = prepared.map((item, index) => ({ item, name: toolName(item, index, used) }))
    const tools = named.map(({ item, name }) => ({
        type: 'function',
        function: {
            name,
            description: String(item.tool?.description || item.binding.description || item.binding.label || item.binding.nodeName).slice(
                0,
                1000
            ),
            parameters: preparedSchema(item)
        }
    }))
    const reply = await callModel(context, model, {
        messages: specialistPrompt(context, specialist, task, soul),
        tools,
        role: 'specialist',
        onDelta: (text) => forwardDelta(context, specialist, String(text ?? '')),
        specialist
    })
    if (!reply.toolCalls.length) return { text: reply.content }
    const calls = await Promise.all(
        reply.toolCalls.map(async (call) => {
            const match = named.find((entry) => entry.name === call.function?.name)
            const label = match?.name || call.function?.name || 'tool'
            if (!match) {
                emitTool(context, { phase: 'start', specialist: specialist.name, name: label })
                emitTool(context, { phase: 'done', specialist: specialist.name, name: label, error: true })
                return { name: label, text: 'That tool is not on this specialist.', raw: null }
            }
            let args = {}
            try {
                args = JSON.parse(call.function.arguments || '{}')
            } catch {
                args = { input: String(call.function.arguments || '') }
            }
            const kind = preparedKind(match.item)
            const value = kind === 'object' ? args : args.query ?? args.input ?? JSON.stringify(args)
            emitTool(context, { phase: 'start', specialist: specialist.name, name: label })
            const raw = await raceSignal(context.workSignal, () => callPrepared(match.item, value))
            const text = normalizeResult(raw)
            emitTool(context, { phase: 'done', specialist: specialist.name, name: label })
            emitSpecialistPartial(context, specialist, text)
            return { name: match.name, text, raw }
        })
    )
    const text = calls.length === 1 ? calls[0].text : calls.map((call) => `${call.name}: ${call.text}`).join('\n')
    return { text, sources: calls.flatMap((call) => documentsFrom(call.raw)) }
}

function moduleLabel(prepared) {
    return String(prepared?.tool?.name || prepared?.binding?.label || prepared?.binding?.nodeName || 'tool')
}

function specialistPrompt(context, specialist, task, instructions, history = context.promptMessages || []) {
    const fitted = fitSpecialistPrompt({
        name: specialist.name,
        instructions,
        memory: context.memoryBlock || '',
        history,
        task,
        budget: specialistContextTokens()
    })
    noteTruncated(context, fitted.truncated)
    return fitted.messages
}

function isAnalystStatusLine(line) {
    const text = String(line || '').trim()
    if (!text) return false
    if (/^Changed \d+ rows$/.test(text)) return true
    if (text === 'The statement finished.') return true
    if (/^returned \d+ rows$/.test(text)) return true
    return isAnalystCapSummary(text)
}

function analystRowLines(block, summaryLine) {
    return String(block || '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && line !== summaryLine && !isAnalystStatusLine(line))
}

function analystRowId(line) {
    const labeled = String(line).match(/\bid:\s*([^\s,|]+)/i)
    if (labeled) return labeled[1]
    const first = String(line).split('|')[0].trim()
    if (/^\d+$/.test(first)) return first
    return ''
}

function answerForRowMatch(answer) {
    return String(answer || '')
        .split('\n')
        .map((line) => line.replace(ANALYST_SUMMARY_LINE, ''))
        .join('\n')
}

function analystRowCells(line) {
    const text = String(line || '')
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .trim()
    if (!text) return []
    if (text.includes('|'))
        return text
            .split('|')
            .map((cell) => cell.trim())
            .filter(Boolean)
    const labeled = []
    const pattern = /(?:^|,)\s*[^:,|]+:\s*([^,|]+)/g
    let match
    while ((match = pattern.exec(text))) {
        const cell = match[1].trim()
        if (cell) labeled.push(cell)
    }
    if (labeled.length) return labeled
    const bare = text.replace(/^(?:[-*+]|\d+[.)])\s+/, '').trim()
    return bare ? [bare] : []
}

function sameCellValues(left, right) {
    if (!left.length || left.length !== right.length) return false
    const pending = [...right]
    for (const cell of left) {
        const index = pending.indexOf(cell)
        if (index < 0) return false
        pending.splice(index, 1)
    }
    return true
}

// A one-column row is shown only when a whole answer line is that cell.
// List markers, pipes, backticks, bold, and a leading column label are not part of the value.
// A bare number matches that line, so a count such as "rows 1-100 of 150" is not row 100.
function singleColumnLineShown(line, cell) {
    const value = String(cell ?? '').trim()
    if (!value) return false
    let text = String(line || '').trim()
    if (!text || isAnalystStatusLine(text)) return false
    text = text.replace(/\|/g, '')
    text = text.replace(/`+/g, '')
    text = text.replace(/\*\*|__/g, '')
    text = text.trim()
    text = text.replace(/^(?:[-*+]|\d+[.)])\s+/, '')
    text = text.trim()
    if (!text || isAnalystStatusLine(text)) return false
    if (text === value) return true
    const labeled = text.match(/^[A-Za-z_][\w]*:\s*(.*)$/)
    return Boolean(labeled) && labeled[1].trim() === value
}

function analystIdLinePattern(id) {
    return new RegExp(
        `^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)?\\|?\\s*(?:id:\\s*)?${String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s*$|\\s*[,|])`,
        'i'
    )
}

function analystRowShown(answer, line) {
    const row = String(line || '').trim()
    if (!row) return false
    const body = answerForRowMatch(answer)
    if (body.includes(row)) return true
    const id = analystRowId(row)
    const rowCells = analystRowCells(row)
    const atStart = id ? analystIdLinePattern(id) : null
    for (const item of body.split('\n')) {
        const text = item.trim()
        if (!text) continue
        if (atStart && atStart.test(text)) return true
        if (rowCells.length > 1 && sameCellValues(rowCells, analystRowCells(text))) return true
    }
    return false
}

function answerLinesForRowMatch(answer) {
    return answerForRowMatch(answer)
        .split('\n')
        .map((item) => item.trim())
        .filter((item) => item && !isAnalystStatusLine(item))
}

function singleColumnLineMatches(row, line) {
    const text = String(line || '').trim()
    const rowText = String(row || '').trim()
    if (!text || !rowText || isAnalystStatusLine(text)) return false
    const id = analystRowId(rowText)
    if (id && analystIdLinePattern(id).test(text)) return true
    const cells = analystRowCells(rowText)
    return cells.length === 1 && singleColumnLineShown(text, cells[0])
}

// One shown line covers one captured row, so identical values need one line each.
// Multi-column rows stay a boolean match: one line can still cover repeated copies.
// Counting those lines would also split two different rows that share one overlapping line.
function missingAnalystRows(answer, rows) {
    const lines = answerLinesForRowMatch(answer)
    const used = new Set()
    const missing = []
    for (const row of rows) {
        if (analystRowCells(row).length !== 1) {
            if (!analystRowShown(answer, row)) missing.push(row)
            continue
        }
        let found = -1
        for (let i = 0; i < lines.length; i += 1) {
            if (used.has(i)) continue
            if (!singleColumnLineMatches(row, lines[i])) continue
            found = i
            break
        }
        if (found >= 0) used.add(found)
        else missing.push(row)
    }
    return missing
}

// A wrapped page line is still that line: **rows ...**, `- rows ...`, `> rows ...`, `rows ...`.
// Strip markers from the ends only. Deleting the summary text inside the line leaves `**` or `- `.
function normalizedAnalystPageLine(line) {
    let text = String(line || '').trim()
    let previous = ''
    while (text && text !== previous) {
        previous = text
        text = text.replace(/^(?:>\s*)+/, '').trim()
        text = text.replace(/^(?:[-*+]|\d+[.)])\s+/, '').trim()
        if (text.startsWith('`') && text.endsWith('`') && text.length >= 2) {
            text = text.slice(1, -1).trim()
            continue
        }
        if (((text.startsWith('**') && text.endsWith('**')) || (text.startsWith('__') && text.endsWith('__'))) && text.length >= 4) {
            text = text.slice(2, -2).trim()
            continue
        }
        if (((text.startsWith('*') && text.endsWith('*')) || (text.startsWith('_') && text.endsWith('_'))) && text.length >= 2) {
            text = text.slice(1, -1).trim()
        }
    }
    return text
}

// Prime may already have written the page line. Take that whole line out, append the
// missing rows, and put the bare page line back last so restored rows do not land after it.
function withoutAnalystPageLine(answer, pageLine) {
    const target = String(pageLine || '').trim()
    if (!target) return String(answer || '').trim()
    const kept = String(answer || '')
        .split('\n')
        .filter((item) => normalizedAnalystPageLine(item) !== target)
    return kept.join('\n').trim()
}

function preserveAnalystRows(answer, results, question) {
    let next = String(answer || '').trim()
    if (!wantsAnalystRows(question)) return stripTrailingAnalystStatus(next)
    for (const result of results || []) {
        const block = String(result?.text || '').trim()
        const line = block.match(ANALYST_SUMMARY_LINE)?.[0]
        if (!line) continue
        const structured = cappedAnalystRowLines(result.analystPayloads)
        const rows = structured == null ? analystRowLines(block, line) : structured
        const missingAll = missingAnalystRows(next, rows)
        const present = rows.length - missingAll.length
        if (rows.length > 0 && present >= rows.length && next.includes(line)) continue
        const missing = missingAll
        const hadPage = next.includes(line)
        if (!missing.length && hadPage) continue
        // Strip while the page line is still in place. Moving it first would leave
        // a trailing status line, such as "Changed 150 rows", above the restored rows.
        const prepared = hadPage ? stripTrailingAnalystStatus(next) : next
        const body = hadPage ? withoutAnalystPageLine(prepared, line) : prepared
        const parts = []
        if (missing.length) parts.push(missing.join('\n'))
        parts.push(line)
        next = body ? `${body}\n\n${parts.join('\n')}` : parts.join('\n')
    }
    return stripTrailingAnalystStatus(next)
}

async function chiefHandoff(context, input, history, results) {
    if ((results || []).some((result) => result.ungrounded)) {
        const parts = results
            .map((result) => {
                if (result.ungrounded) return String(result.text || ANALYST_DID_NOT_RUN)
                if (result.status === 'failed') return String(result.error || `${result.name} failed.`).trim()
                return String(result.text || '').trim()
            })
            .filter(Boolean)
        return parts.join('\n\n')
    }
    const roster = context.roster
    const system = [
        `You are Harness Prime for the "${context.name}" harness.`,
        roster.chief?.instructions ? `Instructions: ${roster.chief.instructions}` : '',
        results.length
            ? `Your specialists already did the work below. Answer the user from their results. Keep numbers, URLs, and script output exactly as given. ${HANDOFF_FILES_AND_FAILURES} ${HANDOFF_GROUNDING} ${HANDOFF_KEEP_CLOSING} The Tools line is the tool status for this turn. A step with no tool result did not run.`
            : 'No specialist was needed. Answer the user directly and briefly.'
    ]
        .filter(Boolean)
        .join('\n')
    const fitted = fitHandoff({
        system,
        memory: context.memoryBlock || '',
        history,
        request: input,
        results,
        chiefBudget: chiefContextTokens()
    })
    noteTruncated(context, fitted.truncated)
    throwIfClient(context)
    if (overBudget(context)) return budgetReply(results)
    const handoffStarted = Date.now()
    emit(context, 'handoff', { phase: 'start', model: configuredModel(context, null) })
    try {
        const answerStream = chiefStream(context, 'answer')
        let reply
        try {
            reply = await callModel(context, chiefModel(roster), {
                messages: withPromptImages(fitted.messages, context.images),
                role: 'handoff',
                onDelta: answerStream.onDelta
            })
        } finally {
            answerStream.flush()
        }
        throwIfClient(context)
        const handed = roleCalls(context, 'handoff')
        const last = handed.at(-1)
        emit(context, 'handoff', {
            phase: 'done',
            ms: Date.now() - handoffStarted,
            ...(last?.model ? { model: last.model } : {}),
            ...(last?.fallback ? { fallback: last.fallback } : {}),
            ...(sumCallTokens(handed) ? { tokens: sumCallTokens(handed) } : {}),
            ...phaseCalls(context, 'handoff')
        })
        return keepClosingLines(preserveAnalystRows(reply.content, results, input), results)
    } catch (error) {
        throwIfClient(context)
        if (overBudget(context)) return budgetReply(results)
        throw error
    }
}

function budgetReply(results) {
    const lines = (results || [])
        .filter((result) => result.status === 'completed' && String(result.text || '').trim())
        .map((result) => result.text)
    if (!lines.length) return 'The harness turn exceeded its time budget before a specialist finished.'
    return lines.join('\n\n')
}

function directToolSpecialist(harness) {
    const specialists = harness?.specialists || []
    if (specialists.length !== 1) return null
    const specialist = specialists[0]
    const modules = specialist.modules || []
    if (modules.length !== 1 || (specialist.mcpServers || []).length) return null
    if (needsAgentLoop(specialist)) return null
    if ((modules[0].category || '') !== 'Tools') return null
    return specialist
}

function fillSchema(prepared) {
    if (prepared.runs || !prepared.tool?.schema) return null
    const schema = preparedSchema(prepared)
    return Object.keys(schema?.properties || {}).length ? schema : null
}

async function fillToolArgs(context, specialist, prepared, schema, question, history) {
    const name = toolName(prepared, 0, new Set())
    const description = String(prepared.tool?.description || prepared.binding.description || prepared.binding.label || name).slice(0, 1000)
    const system = [
        `Call the ${name} tool once with the user's latest message rewritten as the tool's input.`,
        "Use the simplest form the tool's description allows, the way a person would type it into this tool. Do not use programming-language syntax or operators unless the tool asks for code.",
        `Tool: ${description}`,
        specialist.instructions ? `Specialist instructions: ${specialist.instructions}` : ''
    ]
        .filter(Boolean)
        .join('\n')
    const reply = await callModel(context, specialist.model || chiefModel(context.roster), {
        messages: specialistPrompt(context, specialist, question, system, history),
        tools: [{ type: 'function', function: { name, description, parameters: schema } }],
        role: 'fill',
        specialist
    })
    const call = reply.toolCalls.find((item) => item.function?.name === name) || reply.toolCalls[0]
    if (!call) return null
    try {
        const args = JSON.parse(call.function?.arguments || '{}')
        return args && typeof args === 'object' && !Array.isArray(args) ? args : null
    } catch {
        return null
    }
}

function toolValue(prepared, args) {
    if (preparedKind(prepared) === 'object') return args
    const values = Object.values(args)
    return args.input ?? args.query ?? (values.length === 1 ? values[0] : JSON.stringify(args))
}

async function runDirectTool(context, specialist, input) {
    const { name, chatId } = context
    const question = String(input ?? '')
    loadPrompt(context)
    if (context.forceSpecialistFailure === specialist.name) {
        throw new HarnessError('specialist_failed', `Specialist "${specialist.name}" failed.`)
    }
    context.routeSteps = publicSteps([{ specialist, task: question }])
    emit(context, 'route', { phase: 'done', direct: true, steps: context.routeSteps, ms: 0, ...phaseCalls(context, 'route') })
    emit(context, 'specialist', {
        phase: 'start',
        name: specialist.name,
        task: publicTask(question),
        model: configuredModel(context, specialist)
    })
    const started = Date.now()
    const prepared = await prepareModule(specialist.modules[0], question, context.moduleOptions)
    const fillStarted = Date.now()
    const schema = fillSchema(prepared)
    let value = question
    let fill = 'none'
    if (schema) {
        // Letters fail validArgs, so "17 times 3" would otherwise wait on a model fill.
        // Rewrite plain arithmetic and check again; the model stays the fallback.
        let args = validArgs(schema, question)
        if (!args) {
            const expression = normalizeArithmeticQuestion(question)
            if (expression) args = validArgs(schema, expression)
        }
        const accepted = Boolean(args)
        if (!args) args = await fillToolArgs(context, specialist, prepared, schema, question, context.promptMessages || [])
        fill = accepted ? 'valid' : args ? 'model' : 'model-empty'
        if (args) value = toolValue(prepared, args)
    }
    const filled = Date.now()
    const toolLabel = moduleLabel(prepared)
    throwIfClient(context)
    emitTool(context, { phase: 'start', specialist: specialist.name, name: toolLabel })
    let output
    try {
        output = splitToolOutput(await raceSignal(context.workSignal, () => callPrepared(prepared, value)))
    } catch (error) {
        throwIfClient(context)
        if (overBudget(context)) {
            emitTool(context, { phase: 'done', specialist: specialist.name, name: toolLabel, error: true })
            emit(context, 'specialist', {
                phase: 'failed',
                name: specialist.name,
                status: 'failed',
                ms: Date.now() - started,
                error: budgetFailure(context, specialist.name),
                task: publicTask(question),
                ...specialistEventFields(context, specialist, [], true),
                ...phaseCalls(context, 'specialist', specialist.name)
            })
            throw new HarnessError('over_budget', budgetFailure(context, specialist.name))
        }
        throw error
    }
    throwIfClient(context)
    if (overBudget(context)) {
        emitTool(context, { phase: 'done', specialist: specialist.name, name: toolLabel, error: true })
        emit(context, 'specialist', {
            phase: 'failed',
            name: specialist.name,
            status: 'failed',
            ms: Date.now() - started,
            error: budgetFailure(context, specialist.name),
            task: publicTask(question),
            ...specialistEventFields(context, specialist, [], true),
            ...phaseCalls(context, 'specialist', specialist.name)
        })
        throw new HarnessError('over_budget', budgetFailure(context, specialist.name))
    }
    emitTool(context, { phase: 'done', specialist: specialist.name, name: toolLabel })
    const text = maskWorkspacePaths(output.text.trim())
    const finished = Date.now()
    if (!text) {
        emit(context, 'specialist', {
            phase: 'failed',
            name: specialist.name,
            status: 'failed',
            ms: finished - started,
            error: 'empty output',
            task: publicTask(question),
            ...specialistEventFields(context, specialist, [], true),
            ...phaseCalls(context, 'specialist', specialist.name)
        })
        throw new HarnessError('empty_output', `Harness "${name}" finished without a tool result.`)
    }
    emit(context, 'partial', { phase: 'answer', text })
    emit(context, 'specialist', {
        phase: 'done',
        name: specialist.name,
        status: 'completed',
        ms: finished - started,
        task: publicTask(question),
        ...specialistEventFields(context, specialist, output.documents),
        ...phaseCalls(context, 'specialist', specialist.name)
    })
    const timings = { prepareMs: fillStarted - started, fillMs: filled - fillStarted, toolMs: finished - filled }
    const report = predictionReport(context, { routeMs: 0, specialistsMs: timings.toolMs, handoffMs: 0 })
    console.info(
        `[harness] ${name} direct ${specialist.name}: fill ${fill} ${timings.fillMs}ms, tool ${timings.toolMs}ms, profile ${profileNote(
            context
        )}, ${reportNote(context)}`
    )
    if (!context.replay) appendTurn(name, chatId, question, text, sourceNames(maskWorkspacePaths(output.documents)))
    const filledInput = typeof value === 'string' ? value : JSON.stringify(value ?? '')
    const agent = publicAgent(context, specialist, {
        name: specialist.name,
        status: 'completed',
        ms: finished - started,
        publicTask: question,
        sources: output.documents
    })
    const agents = [{ ...agent, fill, input: publicTask(filledInput) }]
    const trace = buildRunTrace({
        harness: name,
        direct: true,
        steps: context.routeSteps,
        agents,
        timings: {
            ...timings,
            routeMs: 0,
            specialistsMs: timings.toolMs,
            handoffMs: 0,
            profileMs: context.profileSkipped ? 0 : context.profileMs || 0
        },
        report,
        profileSkipped: context.profileSkipped,
        wallMs: finished - started,
        directDetail: {
            fill,
            fillMs: timings.fillMs,
            toolMs: timings.toolMs,
            input: publicTask(filledInput)
        },
        question
    })
    const payload = { text, harness: name, agents, sources: output.documents, artifacts: [], timings, report, trace }
    emit(context, 'final', { text, agents, sources: output.documents, artifacts: [], timings, report, trace })
    return payload
}

const WARM_INPUT = 'Reply with the single word ready.'
const HEALTH_POLL_MS = 2000

// Hermes loads a profile's tools and builds its prompt on the profile's first run.
// One short run per agent-loop specialist pays that cost before a chat does.
export async function warmHarnessProfiles({
    names,
    baseUrl = hermesBaseUrl(),
    fetchImpl = fetch,
    healthWaitMs = 1200000,
    lock = (fn) => fn()
} = {}) {
    const records = names ? names.map((name) => getHarness(name)).filter(Boolean) : listHarnesses()
    const targets = []
    for (const record of records) {
        let roster
        try {
            // The lock covers the compile only. The health wait below can run for minutes and must not hold it.
            const compiled = await lock(() => compileProfileCached(record))
            roster = compiled.roster || record
        } catch (error) {
            console.warn(`[harness] ${record.name} warm-up skipped: ${error.message}`)
            continue
        }
        for (const specialist of roster.specialists || []) {
            if (specialist.profileName && needsAgentLoop(specialist)) targets.push({ name: record.name, roster, specialist, record })
        }
    }
    if (!targets.length || !(await hermesHealthy(baseUrl, fetchImpl, healthWaitMs))) return []
    const chatId = `cuttlely-warmup-${Date.now()}`
    const results = await Promise.all(
        targets.map(async ({ name, roster, specialist, record }) => {
            const started = Date.now()
            const moduleOptions = await runtimeModuleOptions(record)
            const context = {
                name,
                chatId,
                roster,
                baseUrl,
                fetchImpl,
                limit: 120000,
                ...(moduleOptions ? { moduleOptions } : {})
            }
            try {
                await runHermesSpecialist(context, specialist, WARM_INPUT)
                return { profile: specialist.profileName, status: 'warm', ms: Date.now() - started }
            } catch (error) {
                return {
                    profile: specialist.profileName,
                    status: 'failed',
                    ms: Date.now() - started,
                    error: hideTurnImageDir(String(error?.message ?? ''), '', specialistWorkspaceRoot())
                }
            }
        })
    )
    console.info(
        '[harness] Hermes warm-up: ' +
            results
                .map((result) => `${result.profile} ${result.status} ${result.ms}ms${result.error ? ` (${result.error})` : ''}`)
                .join(', ')
    )
    return results
}

async function hermesHealthy(baseUrl, fetchImpl, waitMs) {
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
        try {
            const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/health`)
            if (response.ok) return true
        } catch {
            // Hermes is still starting.
        }
        const pause = Math.min(HEALTH_POLL_MS, deadline - Date.now())
        if (pause <= 0) break
        await new Promise((resolve) => setTimeout(resolve, pause))
    }
    console.warn(`[harness] Hermes warm-up skipped: ${baseUrl}/health did not answer`)
    return false
}

export { sessionKey, listHarnesses, directToolSpecialist }
