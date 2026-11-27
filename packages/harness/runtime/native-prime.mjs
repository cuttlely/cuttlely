import { publishedCanvasSource } from '../canvas-ownership.mjs'
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

export const { selectAgentEngine } = availability

export function useNativePrime(roster, mode, engine = selectAgentEngine(roster.name)) {
    return mode === 'agent' && useNativeSpecialists(roster, engine)
}

export function useNativeSpecialists(roster, engine = selectAgentEngine(roster.name)) {
    if (engine === 'hermes') return false
    if (engine !== 'native') throw new HarnessError('bad_engine', 'The admitted agent engine is unavailable.')
    const gaps = nativeCompatibilityGaps(roster, { admitUnavailableTools: true })
    if (gaps.length) {
        const details = gaps.map(({ specialist, capabilities }) => `${specialist}: ${capabilities.join(', ')}`)
        throw new HarnessError('native_unsupported', `Native runtime cannot run these saved capabilities: ${details.join('; ')}.`)
    }
    return true
}

// Offline preflight inspects only the saved grants. Values, credentials, endpoints and
// playbook bodies never appear in the report. Live provider checks still occur at dispatch.
export function nativeCompatibilityGaps(roster, { admitUnavailableTools = false, exportOnly = false } = {}) {
    const host = publishedCanvasSource(roster) || roster
    const gaps = []
    for (const specialist of roster.specialists) {
        const capabilities = new Set()
        for (const [enabled, label] of [
            [specialist.shell, 'shell'],
            [specialist.browser, 'browser'],
            [specialist.codeExecution, 'code execution'],
            [specialist.fileAccess && !managedFilesReady(), 'workspace files'],
            [
                specialist.fileAccess && !exportOnly && existingFileDependency(host, specialist),
                'existing workspace files need owner-scoped upload'
            ]
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
            // not deny a sibling role. A host key may have made the released tool operational: require rebinding.
            if (admitUnavailableTools && unboundNativeSerp(binding) && !process.env.SERPAPI_API_KEY) continue
            if (!supportsNativeCanvasBinding(binding) && !nativeAnalystBinding(binding)) {
                let hint = needsNativeCanvasCredential(binding) ? ' (select a saved credential)' : ''
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

export async function runNativePrime({ messages, roster, complete, delegate, signal, budget, recall }) {
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
        execute: (name, args) => {
            if (name === 'session_search') return recall.execute(name, args)
            const specialist = typeof args.name === 'string' && roster.specialists.find((s) => s.name === args.name.trim())
            if (!specialist) throw new HarnessError('forbidden', 'The requested specialist is not on this team.')
            if (typeof args.task !== 'string' || !args.task.trim()) throw new HarnessError('bad_task', 'A specialist task is required.')
            return delegate(specialist, args.task.trim())
        }
    })
}

export async function runNativeToolLoop({
    messages,
    tools,
    complete,
    execute,
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
            if (!allowed.has(call.function?.name)) throw new HarnessError('forbidden', 'The requested tool is unavailable to this agent.')
            let args
            try {
                args = JSON.parse(call.function.arguments)
            } catch {
                throw new HarnessError('bad_task', 'Invalid tool arguments.')
            }
            if (!args || typeof args !== 'object' || Array.isArray(args))
                throw new HarnessError('bad_task', 'Expected tool arguments as an object.')
            return { name: call.function.name, id: call.id, args }
        })
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
