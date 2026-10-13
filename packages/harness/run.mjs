import crypto from 'node:crypto'
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
import { createRun, hermesBaseUrl, stopRun, waitForRun } from './client.mjs'
import { analystCallsFor, beginAnalystCalls, endAnalystCalls, latestAnalystCursor, takeAnalystResults } from './analyst-capture.mjs'
import { abortGatewayProfile, setGatewayContext } from './gateway.mjs'
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
    mergeTurnImages,
    newTurnImageDir,
    promptImages,
    removeTurnImageDir,
    turnImageNote,
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

let runtimeContextFor = null

// Tests pause a draft try after its profile is compiled and before the model runs.
export const runHooks = { afterProfile: null }

export function configureHarnessRuntime({ contextFor } = {}) {
    runtimeContextFor = typeof contextFor === 'function' ? contextFor : null
    setGatewayContext(runtimeContextFor)
}

function ownerFlowOptions(record, callerOptions) {
    const flowOptions = { ...(callerOptions || {}) }
    // A harness with no team is not in the caller's team. Both empty is an offline run with no team on either side.
    if ((flowOptions.workspaceId || '') !== (record.workspaceId || '')) {
        throw new HarnessError('wrong_workspace', `Harness "${record.name}" belongs to another workspace.`)
    }
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

export async function runHarness(args = {}) {
    const started = Date.now()
    let pending = null
    try {
        pending = beginHarnessRun({
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
    let result
    let failure = null
    const tryName = args.record?.tryId ? tryProfileName(args.record.tryId) : ''
    if (tryName) noteLiveTry(tryName)
    try {
        result = await runHarnessTurn(args)
        return result
    } catch (error) {
        failure = error
        throw error
    } finally {
        if (args.record?.tryId) {
            try {
                await discardTryProfile(args.record.tryId)
            } catch (error) {
                console.warn(`[harness] try profile was not removed: ${error.message}`)
            }
        }
        rememberRun(args, started, pending, result, failure)
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
    budgetMs,
    images,
    record
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
                    budgetMs,
                    images
                }),
            { workspace: harness.workspaceId }
        )
    } finally {
        // TEMP tables the analyst made in its own store last for this turn only.
        await endAnalystRun(analystScope).catch(() => {})
        releaseTurn(turnLock)
    }
}

export async function runQueuedHarness(args) {
    const queue = await import('./queue.mjs')
    return queue.runQueuedHarness(args)
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
        budgetMs,
        images
    }
) {
    const flowOptions = ownerFlowOptions(harness, callerFlowOptions)
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
        images: promptImages(images)
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
export function noteHermesUsage(context, specialist, status) {
    const tokens = noteUsage(context, status)
    if (!tokens) return null
    if (!context.calls) context.calls = []
    context.calls.push({
        role: 'specialist',
        name: specialist.name,
        model: publicModelLabel(specialist.model),
        fallback: '',
        tokens
    })
    return tokens
}

// Only a specialist that can write files (Python, file tools or the terminal) can leave an image, and only in the
// folder made for this run (see newTurnImageDir).
function writesFiles(specialist) {
    return Boolean(specialist?.codeExecution || specialist?.fileAccess || specialist?.shell)
}

export function turnImageDirFor(specialist) {
    return writesFiles(specialist) && specialist.profileName ? newTurnImageDir(specialistWorkspace(specialist.profileName)) : ''
}

export function noteTurnImages(context, specialist, since, dir) {
    if (!writesFiles(specialist) || !dir) return
    const images = turnImages(dir, since, { specialist: specialist.name })
    if (!images.length) return
    if (!context.turnImages) context.turnImages = []
    context.turnImages.push(images)
}

function noteTruncated(context, names) {
    if (!context.truncated) context.truncated = []
    for (const name of names || []) {
        if (name && !context.truncated.includes(name)) context.truncated.push(name)
    }
}

function loadPrompt(context) {
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
    appendTurn(
        context.name,
        context.chatId,
        question,
        text,
        sourceNames([...(context.uploadSources || []), ...results.flatMap((result) => result.sources || [])])
    )
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
        handoffStatus: handoffCalls.length ? 'done' : 'skipped'
    })
    console.info(
        `[harness] ${context.name} route ${timings.routeMs}ms, specialists ${timings.specialistsMs}ms (` +
            agents.map((agent) => `${agent.name} ${agent.status} ${agent.ms}ms`).join(', ') +
            `), handoff ${timings.handoffMs}ms, profile ${profileNote(context)}, ${reportNote(context)}`
    )
    const sources = [...(context.uploadSources || []), ...results.flatMap((result) => result.sources || [])]
    // Image bytes ride on the returned payload only; the Harness node stores them for the chat. Events carry the names.
    const artifacts = mergeTurnImages(context.turnImages || [])
    const payload = { text, harness: context.name, agents, sources, artifacts, timings, report, trace }
    emit(context, 'final', {
        text,
        agents,
        sources,
        artifacts: artifacts.map(({ type, name, specialist }) => ({ type, name, specialist })),
        timings,
        report,
        trace
    })
    return payload
}

function emit(context, type, data = {}) {
    if (context?.clientSignal?.aborted) return
    emitHarnessEvent(context?.onEvent, { type, harness: context?.name, chatId: context?.chatId, ...data })
}

function toolsFor(context, name) {
    return (context.toolLog || [])
        .filter((item) => item.specialist === name && item.status !== 'running')
        .map((item) => `${item.name} ${item.status}`)
}

function emitTool(context, data) {
    if (!context.toolLog) context.toolLog = []
    const detail = data.detail ? String(data.detail) : ''
    const callId = typeof data.callId === 'string' ? data.callId.trim() : ''
    const emitted = { ...data }
    delete emitted.callId
    if (data.phase === 'start') {
        context.toolLog.push({
            specialist: data.specialist,
            name: data.name,
            status: 'running',
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
            signal
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
    const tokens = noteUsage(context, reply)
    if (!context.calls) context.calls = []
    context.calls.push({
        role: request.role || 'model',
        name: request.specialist?.name || 'chief',
        model: publicModelLabel(winner),
        fallback: usedFallback ? publicModelLabel(winner) : '',
        tokens
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
    'Any SQL, database, or analyst-addressed request must go to the analyst. That includes a message that starts with "Analyst:", a SQL verb, or the words "analyst database". Never answer those directly. An empty steps list is only for a request that is not a database task. When the user says "show more", "next page", or "page N" after a capped analyst result, send that to the analyst. Do not answer it yourself.'

export const HANDOFF_GROUNDING =
    'State only rows, counts, amounts, and other data that appear in the specialist results below. If a step did not run, say that plainly. Do not invent a table or a number, and do not ask whether to continue. When a specialist result includes rows, pass those rows through as a table or a list. When it also includes a page line that starts with "rows ", or a summary that starts with "returned ", keep that line after the rows. Never answer with only that count line. Do not echo raw tool JSON. A database change is plain words such as "Dropped table", "Created table", or "Inserted 3 rows".'

export const HANDOFF_KEEP_CLOSING =
    'When a specialist result ends with a source, citation or reference line, such as a line that starts with "Source:", end your answer with that line exactly as written.'

// A specialist's closing line, such as "Source: ..." that a playbook requires, survives Harness Prime's rewrite:
// a closing line from the last lines of a completed result that the answer dropped is put back at the end.
const CLOSING_LINE = /^(sources?|citations?|references?|data sources?)\s*:\s*\S/i
const CLOSING_LINE_WINDOW = 3
const CLOSING_TAIL = /[.!?)]\s+((?:sources?|citations?|references?|data sources?)\s*:\s*\S.*)$/i

export function closingLines(text) {
    const lines = String(text || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    const found = lines.slice(-CLOSING_LINE_WINDOW).filter((line) => CLOSING_LINE.test(line))
    if (found.length || !lines.length) return found
    // A specialist sometimes puts the source at the end of its last sentence instead of on its own line.
    const tail = CLOSING_TAIL.exec(lines.at(-1))
    return tail ? [tail[1].trim()] : []
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

// A bare paging phrase is not a specialist task unless this chat still has a live cursor.
// Expiry is known only while the capture still has that cursor and it is past the TTL.
export function applyAnalystPageRoute(input, steps, specialists, cursor) {
    const request = analystPageRequest(input)
    const list = Array.isArray(steps) ? steps : []
    if (!request) return { steps: list, reply: '' }
    if (cursor?.expired) return { steps: [], reply: ANALYST_CURSOR_ERRORS.expired }
    if (!cursor?.token) return { steps: [], reply: ANALYST_PAGE_NONE }
    const analyst = (specialists || []).find((specialist) => hasAnalystTool(specialist))
    if (!analyst) return { steps: list, reply: '' }
    return { steps: [{ specialist: analyst, task: analystPageTask(cursor.token, request), paging: true }], reply: '' }
}

// The router can return no steps and Prime then invents a database answer. A data task with an analyst on the roster goes to that analyst.
export function forceAnalystRoute(input, steps, specialists) {
    const list = Array.isArray(steps) ? [...steps] : []
    if (list.length) return list
    const analyst = (specialists || []).find((specialist) => hasAnalystTool(specialist))
    if (!analyst || !isAnalystDataTask(input)) return list
    return [{ specialist: analyst, task: String(input || '') }]
}

const SQL_VERB = /\b(drop|create|insert|update|delete|select|alter)\b/gi

export function isMultiStepDataTask(text) {
    const value = String(text || '')
    const verbs = value.match(SQL_VERB) || []
    if (verbs.length >= 2) return true
    if (/\bthen\b/i.test(value) && verbs.length >= 1) return true
    if (/(?:^|\n)\s*\d+[.)]\s+/.test(value) && /\b(table|insert|select|row)\b/i.test(value)) return true
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

function finishUnpaged(context, reply, started) {
    context.routeSteps = []
    context.directReply = reply
    emit(context, 'route', { phase: 'done', steps: [], ms: Date.now() - started })
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
        emit(context, 'route', { phase: 'done', steps: context.routeSteps, ms: Date.now() - started })
        return steps
    }
    const blocked = applyAnalystPageRoute(input, [], specialists, cursor)
    if (blocked.reply) return finishUnpaged(context, blocked.reply, started)
    emit(context, 'route', { phase: 'start' })
    const system = [
        `You route work for the "${context.name}" harness.`,
        context.roster.chief?.instructions ? `Harness Prime instructions: ${context.roster.chief.instructions}` : '',
        'Specialists:',
        ...specialists.map(
            (specialist) => `- ${specialist.name}: ${specialistSummary(specialist, 'No instructions.')}${capabilityNote(specialist)}`
        ),
        'Pick every specialist the request needs. Steps run at the same time, so write each task so it stands on its own.',
        ROUTE_AFTER,
        routerDialectNote(specialists),
        specialists.some((specialist) => hasAnalystTool(specialist)) ? ROUTE_ANALYST : '',
        ROUTE_WHOLE_TASK,
        ROUTE_FOLLOW_UP,
        context.images?.length ? ROUTE_IMAGES : '',
        'Reply with JSON only: {"steps":[{"specialist":"NAME","task":"...","after":""}]}. Leave "after" empty unless the step needs an earlier step\'s result. Use an empty list when no specialist is needed.'
    ]
        .filter(Boolean)
        .join('\n')
    const fitted = fitChiefMessages({ system, memory: context.memoryBlock || '', history, user: input, budget: chiefContextTokens() })
    noteTruncated(context, fitted.truncated)
    const reply = await callModel(context, chiefModel(context.roster), {
        messages: withPromptImages(fitted.messages, context.images),
        json: true,
        role: 'route',
        onDelta: (text) => emit(context, 'partial', { phase: 'route', text })
    })
    const pageRoute = applyAnalystPageRoute(
        input,
        forceAnalystRoute(input, parseSteps(reply.content, specialists, input), specialists),
        specialists,
        cursor
    )
    if (pageRoute.reply) return finishUnpaged(context, pageRoute.reply, started)
    const steps = pageRoute.steps
    if (steps.length === 1 && !steps[0].paging) steps[0].task = expandSingleSpecialistTask(input, steps[0].task)
    context.routeSteps = publicSteps(steps)
    const routed = roleCalls(context, 'route')
    const last = routed.at(-1)
    emit(context, 'route', {
        phase: 'done',
        steps: context.routeSteps,
        ms: Date.now() - started,
        ...(last?.model ? { model: last.model } : {}),
        ...(last?.fallback ? { fallback: last.fallback } : {}),
        ...(sumCallTokens(routed) ? { tokens: sumCallTokens(routed) } : {})
    })
    return steps
}

// A step that needs an earlier step's result names it in "after". It waits for that step and gets its result with
// the task. Only a step listed earlier counts, so steps cannot wait on each other in a loop.
export const ROUTE_AFTER =
    "When a step needs another step's result (for example, the writer turns the numbers the analyst finds into a note), " +
    'list it after that step and add "after": "NAME" to it. It then waits for that step and gets its result with the task.'
const EARLIER_RESULT_CHARS = 6000

export function parseSteps(content, specialists, input) {
    let parsed
    try {
        parsed = JSON.parse(content)
    } catch {
        return specialists.map((specialist) => ({ specialist, task: input }))
    }
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
    return steps
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
            ...specialistEventFields(context, specialist, out.sources)
        })
        return {
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
        }
    } catch (error) {
        throwIfClient(context)
        const ms = Date.now() - started
        const message = overBudget(context) ? budgetFailure(context, specialist.name) : error.message
        emit(context, 'specialist', {
            phase: 'failed',
            name: specialist.name,
            status: 'failed',
            ms,
            error: message,
            task: publicTask(step.task),
            ...specialistEventFields(context, specialist, [], true)
        })
        return {
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
        }
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

function forwardHermes(context, specialist, event) {
    const kind = event?.event
    if (kind === 'message.delta' && event.delta) {
        emitSpecialistPartial(context, specialist, String(event.delta))
        return
    }
    if (kind !== 'tool.started' && kind !== 'tool.completed') return
    const detail = event.preview ? String(event.preview) : ''
    const callId = hermesEventCallId(event)
    emitTool(context, {
        phase: kind === 'tool.started' ? 'start' : 'done',
        specialist: specialist.name,
        name: String(event.tool || 'tool'),
        ...(event.error ? { error: true } : {}),
        ...(detail ? { detail } : {}),
        ...(callId ? { callId } : {})
    })
}

function analystQueryCount(context, name) {
    return (context.toolLog || []).filter((tool) => tool.specialist === name && tool.status !== 'running' && isAnalystQueryTool(tool.name))
        .length
}

async function runSpecialistOnce(context, specialist, task) {
    if (specialist.profileName && needsAgentLoop(specialist)) return runHermesSpecialist(context, specialist, task)
    return runInlineSpecialist(context, specialist, task)
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
    beginAnalystCalls(context.name, specialist.name, context.chatId)
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
        noteHermesUsage(context, specialist, status)
        if (['failed', 'error', 'cancelled'].includes(status.status)) {
            throw new HarnessError('specialist_failed', status.error || status.message || `Specialist "${specialist.name}" failed.`)
        }
        attachCapturedAnalystResults(context, specialist, specialistStarted, toolLogStart)
        noteTurnImages(context, specialist, specialistStarted, imageDir)
        const text = typeof status.output === 'string' ? hideTurnImageDir(status.output, imageDir) : ''
        if (!text.trim()) throw new HarnessError('empty_output', `Specialist "${specialist.name}" returned nothing.`)
        return { text }
    } finally {
        endAnalystCalls(context.name, specialist.name, context.chatId)
        context.workSignal?.removeEventListener('abort', onAbort)
        await Promise.all(stops)
        try {
            removeTurnImageDir(imageDir)
        } catch {
            // A folder that cannot be removed is left for the next workspace cleanup.
        }
    }
}

function attachCapturedAnalystResults(context, specialist, since, logStart = 0) {
    const captured = takeAnalystResults({ harness: context.name, specialist: specialist.name, since })
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
        slots[slotIndex].detail = JSON.stringify({ result: JSON.stringify(item.result) })
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
            onDelta: (text) => emitSpecialistPartial(context, specialist, text),
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
        onDelta: (text) => emitSpecialistPartial(context, specialist, text),
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

function wantsAnalystRows(question) {
    const text = String(question || '')
    const aggregate = /\b(how many|count|number of|total|sum|average|avg|mean)\b/i.test(text)
    const listing = /\b(list|show|select\s+\*|all rows|every row|each row)\b/i.test(text)
    if (aggregate && !listing) return false
    return true
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
            ? `Your specialists already did the work below. Answer the user from their results. Keep numbers, file paths, URLs, and script output exactly as given. If a specialist failed, name it and the reason in one line. ${HANDOFF_GROUNDING} ${HANDOFF_KEEP_CLOSING} The Tools line is the tool status for this turn. A step with no tool result did not run.`
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
        const reply = await callModel(context, chiefModel(roster), {
            messages: withPromptImages(fitted.messages, context.images),
            role: 'handoff',
            onDelta: (text) => emit(context, 'partial', { phase: 'answer', text })
        })
        throwIfClient(context)
        const handed = roleCalls(context, 'handoff')
        const last = handed.at(-1)
        emit(context, 'handoff', {
            phase: 'done',
            ms: Date.now() - handoffStarted,
            ...(last?.model ? { model: last.model } : {}),
            ...(last?.fallback ? { fallback: last.fallback } : {}),
            ...(sumCallTokens(handed) ? { tokens: sumCallTokens(handed) } : {})
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
    emit(context, 'route', { phase: 'done', direct: true, steps: context.routeSteps, ms: 0 })
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
                ...specialistEventFields(context, specialist, [], true)
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
            ...specialistEventFields(context, specialist, [], true)
        })
        throw new HarnessError('over_budget', budgetFailure(context, specialist.name))
    }
    emitTool(context, { phase: 'done', specialist: specialist.name, name: toolLabel })
    const text = output.text.trim()
    const finished = Date.now()
    if (!text) {
        emit(context, 'specialist', {
            phase: 'failed',
            name: specialist.name,
            status: 'failed',
            ms: finished - started,
            error: 'empty output',
            task: publicTask(question),
            ...specialistEventFields(context, specialist, [], true)
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
        ...specialistEventFields(context, specialist, output.documents)
    })
    const timings = { prepareMs: fillStarted - started, fillMs: filled - fillStarted, toolMs: finished - filled }
    const report = predictionReport(context, { routeMs: 0, specialistsMs: timings.toolMs, handoffMs: 0 })
    console.info(
        `[harness] ${name} direct ${specialist.name}: fill ${fill} ${timings.fillMs}ms, tool ${timings.toolMs}ms, profile ${profileNote(
            context
        )}, ${reportNote(context)}`
    )
    appendTurn(name, chatId, question, text, sourceNames(output.documents))
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
        }
    })
    const payload = { text, harness: name, agents, sources: output.documents, artifacts: [], timings, report, trace }
    emit(context, 'final', { text, agents, sources: output.documents, artifacts: [], timings, report, trace })
    return payload
}

const WARM_INPUT = 'Reply with the single word ready.'
const HEALTH_POLL_MS = 2000

// Hermes loads a profile's tools and builds its prompt on the profile's first run.
// One short run per agent-loop specialist pays that cost before a chat does.
export async function warmHarnessProfiles({ names, baseUrl = hermesBaseUrl(), fetchImpl = fetch, healthWaitMs = 1200000 } = {}) {
    const records = names ? names.map((name) => getHarness(name)).filter(Boolean) : listHarnesses()
    const targets = []
    for (const record of records) {
        let roster
        try {
            roster = compileProfileCached(record).roster || record
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
                return { profile: specialist.profileName, status: 'failed', ms: Date.now() - started, error: error.message }
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
        await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS))
    }
    console.warn(`[harness] Hermes warm-up skipped: ${baseUrl}/health did not answer`)
    return false
}

export { sessionKey, listHarnesses, directToolSpecialist }
