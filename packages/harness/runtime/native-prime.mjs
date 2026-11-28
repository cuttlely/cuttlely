import { publishedSearchCredential } from './native-search-credential.mjs'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { stableStringify } from '../flow-graph.mjs'
import { getHarness } from '../store.mjs'
import { openNativeNumericCode } from './native-numeric-code.mjs'
import { publishedCanvasSource, publishedCallerTryId } from '../canvas-ownership.mjs'
import { prepareNativePlaybooks } from './native-playbooks.mjs'
import { existingFileDependency, managedFilesReady } from './native-files.mjs'
import availability from '../availability.cjs'
import { HarnessError } from '../errors.mjs'
import { estimateTokens } from '../context.mjs'
import { needsNativeCanvasCredential, supportsNativeCanvasBinding, unboundNativeSerp } from '../../../scripts/native-canvas-bindings.mjs'
import { nativeMcpBindingSupported } from './native-mcp.mjs'
import { emptyNativeAnalystCard, nativeAnalystBinding, nativeAnalystSpecialistSupported } from './native-analyst.mjs'
import { chiefPrompt, specialistFileServiceRequirements, specialistProfileName, tryProfileName } from '../profile.mjs'

// Only the queue can supply a recorded selection. API and canvas JSON cannot set a symbol.
export const admittedAgentEngine = Symbol('admittedAgentEngine')

export const admittedNativeRolePin = Symbol('admittedNativeRolePin')
export const { selectAgentEngine } = availability

const deferredGrants = [
    ['shell', 'shell'],
    ['browser', 'browser'],
    ['codeExecution', 'code execution']
]

function deferredCapabilities(specialist) {
    return deferredGrants.filter(([key]) => specialist[key]).map(([, label]) => label)
}

// A published canvas can select its exact graph without using the registry's copy of that graph.
// Its server-issued witness binds the selected graph to the same saved owner and revision.
export function nativeRolePin(roster) {
    if (!roster?.workspaceId || !roster.chatflowId) return null
    const published = publishedCanvasSource(roster)
    if (!published && roster.tryId) return null
    const saved = published || getHarness(roster.name)
    if (!saved?.createdAt || !saved.updatedAt || (!published && !isDeepStrictEqual(saved, roster))) return null
    return createHash('sha256').update(stableStringify(saved)).digest('hex')
}

export function onDemandNativeRoles(engine) {
    return engine === 'native' && process.env.CUTTLELY_NATIVE_ROLE_POLICY === 'on-demand'
}

export function assertNativeRoleSupported(specialist, approvedBrowserTask = false, verifiedUploadShell = false) {
    if (verifiedUploadShell && specialist.shell === true && !specialist.browser && !specialist.codeExecution && !specialist.fileAccess)
        return
    if (approvedBrowserTask && specialist.browser === true && !specialist.shell && !specialist.codeExecution) return
    if (openNativeNumericCode(specialist, 'on-demand')) return
    const capabilities = deferredCapabilities(specialist)
    if (capabilities.length)
        throw new HarnessError(
            'native_unsupported',
            `Native runtime cannot run selected specialist "${specialist.name}": ${capabilities.join(', ')}.`
        )
}

export function useNativePrime(roster, mode, engine = selectAgentEngine(roster.name)) {
    return mode === 'agent' && useNativeSpecialists(roster, engine)
}

export function useNativeSpecialists(
    roster,
    engine = selectAgentEngine(roster.name),
    rolePin = onDemandNativeRoles(engine) ? nativeRolePin(roster) : null
) {
    if (engine === 'hermes') return false
    if (engine !== 'native') throw new HarnessError('bad_engine', 'The admitted agent engine is unavailable.')
    if (rolePin !== null && (!rolePin || nativeRolePin(roster) !== rolePin))
        throw new HarnessError('harness_changed', 'The saved team changed after native admission.')
    const gaps = compatibilityGaps(roster, { admitUnavailableTools: true, deferRoleGrants: Boolean(rolePin) })
    assertNoGaps(gaps)
    return true
}

function assertNoGaps(gaps) {
    if (gaps.length) {
        const details = gaps.map(({ specialist, capabilities }) => `${specialist}: ${capabilities.join(', ')}`)
        throw new HarnessError('native_unsupported', `Native runtime cannot run these saved capabilities: ${details.join('; ')}.`)
    }
}

// Offline preflight inspects only the saved grants. Values, credentials, endpoints and
// playbook bodies never appear in the report. Live provider checks still occur at dispatch.
export function nativeCompatibilityGaps(roster, { admitUnavailableTools = false, exportOnly = false } = {}) {
    return compatibilityGaps(roster, { admitUnavailableTools, exportOnly, deferRoleGrants: false })
}

const localFilesGap = 'existing workspace files need owner-scoped upload'

function hasLocalWorkspaceFiles(roster, host, specialist) {
    if (existingFileDependency(host, specialist)) return true
    const callerTryId = publishedCallerTryId(roster)
    return Boolean(callerTryId && existingFileDependency({ name: host.name, tryId: callerTryId }, specialist))
}

// The physical Try cleanup may remove an unmarked workspace left after an interrupted restore.
// Inspect under the Try lock, before starting a run that takes responsibility for that cleanup.
export function assertNativeCanvasWorkspaces(roster) {
    const host = publishedCanvasSource(roster)
    if (!host) return
    const blocked = roster.specialists.filter((specialist) => specialist.fileAccess && hasLocalWorkspaceFiles(roster, host, specialist))
    assertNoGaps(blocked.map((s) => ({ specialist: s.name, capabilities: [localFilesGap] })))
}

function compatibilityGaps(roster, { admitUnavailableTools, exportOnly, deferRoleGrants }) {
    const host = publishedCanvasSource(roster) || roster
    const gaps = []
    for (const specialist of roster.specialists) {
        const capabilities = new Set(deferRoleGrants ? [] : deferredCapabilities(specialist))
        for (const [enabled, label] of [
            [specialist.fileAccess && !managedFilesReady(), 'workspace files'],
            [specialist.fileAccess && !exportOnly && hasLocalWorkspaceFiles(roster, host, specialist), localFilesGap]
        ])
            if (enabled) capabilities.add(label)
        if (!exportOnly && specialist.fileAccess && host.name && specialist.name) {
            const savedProfile = host.tryId ? tryProfileName(host.tryId) : host.name
            for (const requirement of specialistFileServiceRequirements(
                specialistProfileName(savedProfile, specialist.name),
                specialist.credentials
            ))
                capabilities.add(requirement)
        }
        if (!exportOnly) for (const gap of prepareNativePlaybooks(roster, specialist).gaps) capabilities.add(gap)
        for (const binding of specialist.modules || []) {
            // Offline inventory continues to list the missing credential. In a live canary its absence need
            // not deny a sibling role. A host key requires an explicit saved or operator binding.
            const unboundSearch = unboundNativeSerp(binding)
            if (
                admitUnavailableTools &&
                unboundSearch &&
                (!process.env.SERPAPI_API_KEY || publishedSearchCredential(roster, specialist, binding))
            )
                continue
            if (!supportsNativeCanvasBinding(binding) && !nativeAnalystBinding(binding)) {
                let hint = needsNativeCanvasCredential(binding) ? ' (select a saved credential)' : ''
                if (unboundSearch)
                    hint = ' (select a saved credential or configure CUTTLELY_NATIVE_SEARCH_CREDENTIALS for the published card)'
                if (binding?.nodeName === 'customRetriever' && !binding.upstream?.vectorStore) hint = ' (connect a supported vector store)'
                capabilities.add('canvas tool ' + nativeNodeLabel(binding) + hint)
            }
        }
        for (const binding of specialist.mcpServers || []) {
            if (
                !nativeAnalystBinding(binding) &&
                !emptyNativeAnalystCard(binding) &&
                !nativeMcpBindingSupported(binding, roster.workspaceId)
            )
                capabilities.add('MCP configuration for ' + nativeNodeLabel(binding))
        }
        if (specialist.trustedOutputs?.length && !nativeAnalystSpecialistSupported(specialist))
            capabilities.add('trusted output without an eligible saved query')
        if (capabilities.size) gaps.push({ specialist: specialist.name, capabilities: [...capabilities] })
    }
    return gaps
}

function nativeNodeLabel(binding) {
    const label = binding?.nodeName
    return typeof label === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(label) ? label : 'unrecognized node'
}

export function nativePrimeInstructions(roster, recall) {
    return chiefPrompt(roster, { offeredTools: ['run_specialist', ...(recall?.tools || []).map((tool) => tool.function.name)] })
}

export async function runNativePrime({ messages, roster, complete, delegate, signal, budget, recall, checkRole }) {
    function selectedSpecialist(args) {
        const specialist = typeof args.name === 'string' && roster.specialists.find((s) => s.name === args.name.trim())
        if (!specialist) throw new HarnessError('forbidden', 'The requested specialist is not on this team.')
        if (typeof args.task !== 'string' || !args.task.trim()) throw new HarnessError('bad_task', 'A specialist task is required.')
        return specialist
    }
    const tools = [
        {
            type: 'function',
            function: {
                name: 'run_specialist',
                description: 'Ask one specialist on this team to perform a task and return its result.',
                parameters: {
                    type: 'object',
                    properties: { name: { type: 'string', enum: roster.specialists.map((s) => s.name) }, task: { type: 'string' } },
                    required: ['name', 'task'],
                    additionalProperties: false
                }
            }
        }
    ]
    return runNativeToolLoop({
        messages,
        tools: [...tools, ...(recall?.tools || [])],
        complete,
        signal,
        budget,
        // A saved team can have more than eight specialists. Keep individual model batches bounded.
        maxCalls: 40,
        maxBatchCalls: 8,
        limitCode: 'delegation_limit',
        validateCall:
            checkRole &&
            ((name, args) => {
                if (name === 'run_specialist') checkRole(selectedSpecialist(args))
            }),
        execute: (name, args) => {
            if (name === 'session_search') return recall.execute(name, args)
            return delegate(selectedSpecialist(args), args.task.trim())
        }
    })
}

export async function runNativeToolLoop({
    messages,
    tools,
    complete,
    execute,
    aliases,
    validateCall,
    signal,
    budget,
    maxCalls,
    maxBatchCalls = maxCalls,
    queueCall,
    limitCode
}) {
    const transcript = [...messages]
    const allowed = new Set(tools.map((tool) => tool.function.name))
    // Only evict a replayable tool result after the model has seen its complete batch.
    const readResults = []
    let pendingReads = []
    let remaining = maxCalls
    for (;;) {
        signal?.throwIfAborted()
        if (budget) {
            let tokens = transcript.reduce(
                (total, message) =>
                    total + estimateTokens(message.content) + (message.tool_calls ? estimateTokens(JSON.stringify(message.tool_calls)) : 0),
                0
            )
            while (tokens > budget && readResults.length) {
                const { message, compactContent } = readResults.shift()
                tokens -= estimateTokens(message.content) - estimateTokens(compactContent)
                message.content = compactContent
            }
            if (tokens > budget) throw new HarnessError('context_limit', 'The native agent exhausted its turn context.')
        }
        const reply = await complete(transcript, tools)
        readResults.push(...pendingReads)
        pendingReads = []
        signal?.throwIfAborted()
        if (!reply.toolCalls.length) return reply.content
        if (reply.toolCalls.length > remaining || reply.toolCalls.length > maxBatchCalls)
            throw new HarnessError(limitCode, 'The native agent reached its tool call limit.')
        remaining -= reply.toolCalls.length
        const calls = reply.toolCalls.map((call) => {
            let name = call.function?.name
            if (!allowed.has(name)) {
                name = aliases?.get(name)
                if (!name || !allowed.has(name)) throw new HarnessError('forbidden', 'The requested tool is unavailable to this agent.')
            }
            let args
            try {
                args = JSON.parse(call.function.arguments)
            } catch {
                throw new HarnessError('bad_task', 'Invalid tool arguments.')
            }
            if (!args || typeof args !== 'object' || Array.isArray(args))
                throw new HarnessError('bad_task', 'Expected tool arguments as an object.')
            return { name, id: call.id, args }
        })
        if (validateCall) for (const call of calls) await validateCall(call.name, call.args)
        // Commit the whole validated batch before dispatch. Calls left in this state
        // when a worker dies never reached a tool.
        if (queueCall) for (const call of calls) call.receipt = queueCall(call.name)
        transcript.push({ role: 'assistant', content: reply.content, tool_calls: reply.toolCalls })
        for (const call of calls) {
            signal?.throwIfAborted()
            const result = await execute(call.name, call.args, call.receipt)
            const content = typeof result === 'string' ? result : result.content
            const message = { role: 'tool', tool_call_id: call.id, content }
            transcript.push(message)
            if (result.compactContent && result.compactContent.length < content.length)
                pendingReads.push({ message, compactContent: result.compactContent })
        }
    }
}
