import { randomUUID } from 'node:crypto'
import { beginAnalystCalls, endAnalystCalls } from '../analyst-capture.mjs'
import { HarnessError } from '../errors.mjs'
import { callOfferedTool, forgetNativeToolRoutes, offeredPinnedTools, pinnedCallContext } from '../gateway.mjs'
import { specialistSessionId } from '../specialist-run.mjs'
import { analystScopeKey } from './analyst-store.mjs'
import guard from './node-guard.cjs'
import { isPinnedToolName } from './pinned-query.mjs'

function selectedActions(binding) {
    const actions = binding.inputs?.mcpActions || []
    try {
        const parsed = typeof actions === 'string' ? JSON.parse(actions) : actions
        return Array.isArray(parsed) ? parsed : null
    } catch {
        return null
    }
}

export function nativeAnalystBinding(binding) {
    if (binding?.nodeName !== 'postgreSQLMCP' || Object.keys(binding.upstream || {}).length) return false
    if (
        binding.nodeData ||
        binding.inputs?.postgresUrl !== undefined ||
        (binding.credential != null && typeof binding.credential !== 'string')
    )
        return false
    const actions = selectedActions(binding)
    const pins = guard.readPinnedEntries(binding.inputs?.pinnedQueries)
    if (!actions || pins.invalid || actions.some((action) => !['query', 'describe'].includes(action))) return false
    if (!binding.credential && !process.env.CUTTLELY_POSTGRES_URL) return false
    // A saved pin is a fixed statement attested to this destination. Free queries require a saved relation selection.
    return actions.length === 0 || guard.nodeGuardSettings(binding.inputs).relations.length > 0
}

export function nativeAnalystSpecialistSupported(specialist) {
    if (!specialist.trustedOutputs?.length) return true
    const pins = new Set(
        [...(specialist.modules || []), ...(specialist.mcpServers || [])]
            .filter(nativeAnalystBinding)
            .flatMap((binding) => guard.readPinnedEntries(binding.inputs?.pinnedQueries).entries.map((entry) => entry.name))
    )
    return specialist.trustedOutputs.every((contract) => pins.has(contract.pin))
}

// The binding's real node discovers and checks its saved actions, stamps, credential and guard settings.
// Route metadata lives for one delegation. The source turn and cursor retain their released specialist/chat identity.
export async function openNativeAnalyst({ context, specialist, assertCurrent }) {
    const bindings = [...(specialist.modules || []), ...(specialist.mcpServers || [])].filter(nativeAnalystBinding)
    if (!bindings.length) return { tools: [], close() {} }
    if (!specialist.profileName || typeof assertCurrent !== 'function')
        throw new HarnessError('forbidden', 'Native Analyst requires an admitted specialist turn.')
    const assertCall = () => {
        context.workSignal?.throwIfAborted()
        assertCurrent()
    }
    assertCall()
    const assigned = bindings.map((binding) => ({ ...binding, category: 'Tools (MCP)' }))
    const record = { ...context.roster, specialists: [{ ...specialist, modules: [], mcpServers: assigned }] }
    const profileName = specialist.profileName
    const sourceTurn = specialistSessionId(profileName, context.chatId, context.turnId)
    const scope = analystScopeKey(context.name, context.chatId)
    const routeProfile = 'native-analyst-' + randomUUID()
    let closed = false
    const close = () => {
        if (closed) return
        closed = true
        endAnalystCalls(context.name, specialist.name, context.chatId)
        forgetNativeToolRoutes(routeProfile)
    }
    try {
        beginAnalystCalls(context.name, specialist.name, context.chatId)
        const owner = await pinnedCallContext(context.roster, context.moduleOptions, context.chatId)
        assertCall()
        const workspace = owner.flowOptions?.workspaceId || ''
        const searchWorkspace = owner.flowOptions?.searchOptions?.workspaceId?._value
        if (workspace !== (record.workspaceId || '') || (searchWorkspace && searchWorkspace !== workspace))
            throw new HarnessError('wrong_workspace', 'Analyst tools require their saved workspace.')
        const moduleOptions = {
            ...owner,
            // Never borrow a similarly named card initialized for another specialist, transport or workspace.
            nodeCache: undefined,
            // This option is internal and is supplied after resolving the saved owner.
            flowOptions: { ...owner.flowOptions, requireReadOnlyAnalystUrl: true },
            signal: context.workSignal,
            beforeCall: assertCall,
            assertCall
        }
        const specs = await offeredPinnedTools(record, specialist.name, moduleOptions, routeProfile)
        assertCall()
        const actions = new Map()
        for (const spec of specs) {
            // Empty/stale discovery may return a generic card placeholder. It is never an executable action.
            if (!isPinnedToolName(spec.name) && !['query', 'describe', 'pin_definition'].includes(spec.name)) continue
            if (!actions.has(spec.name)) actions.set(spec.name, spec)
        }
        return {
            tools: [...actions.values()].map(({ name, description, inputSchema }) => ({
                type: 'function',
                function: { name, description, parameters: inputSchema }
            })),
            async execute(name, args, callId = randomUUID()) {
                assertCall()
                if (closed || !actions.has(name)) throw new HarnessError('forbidden', 'The requested Analyst tool is unavailable.')
                // Correlation and scope come from this admission. Model arguments never carry either value.
                const result = await callOfferedTool({
                    record,
                    specialistName: specialist.name,
                    profileName,
                    routeProfile,
                    toolName: name,
                    args,
                    callId,
                    chatId: context.chatId,
                    scope,
                    sourceTurn,
                    moduleOptions
                })
                const content = typeof result === 'string' ? result : JSON.stringify(result)
                let body
                try {
                    body = JSON.parse(content)
                } catch {
                    return content
                }
                return body?.error || ['expected', 'transport'].includes(body?.cuttlelyOutcome) ? { content, error: true } : content
            },
            close
        }
    } catch (error) {
        close()
        throw error
    }
}
