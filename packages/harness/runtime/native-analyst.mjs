import { prepareModule, readyToolSpecs } from '../bridge.mjs'
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

// The released template configures no SQL actions, pins or destination. Its node still
// discovers its genuine workspace-scoped empty-action result, or its configuration error.
export function emptyNativeAnalystCard(binding) {
    if (
        binding?.nodeName !== 'postgreSQLMCP' ||
        binding.category !== 'Tools (MCP)' ||
        (binding.credential != null && binding.credential !== '') ||
        binding.nodeData
    )
        return false
    if (Object.keys(binding.upstream || {}).length || String(process.env.CUTTLELY_POSTGRES_URL || '').trim()) return false
    const inputs = binding.inputs || {}
    return inputs.allowPinDefinitions === false && Object.keys(inputs).every((name) => name === 'allowPinDefinitions')
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

// This symbol stays in-process. A tool returning similarly shaped JSON cannot offer a smaller, trusted presentation.
export const verifiedSourceEvidence = Symbol('verified source evidence')

export function modelSourceReceipt(specialist, pin, encoded) {
    const contracts = specialist.trustedOutputs?.filter((entry) => entry.pin === pin) || []
    if (contracts.length !== 1 || contracts[0].mode !== 'markdown') return encoded
    const receipt = JSON.parse(encoded)
    const evidence = receipt.interpretationEvidence
    const entries = evidence?.sourceEvidence
    if (
        receipt.status !== 'source_captured' ||
        receipt.hash !== contracts[0].hash ||
        !receipt.sourceOverview?.complete ||
        !Array.isArray(entries) ||
        !entries.length
    )
        return encoded
    const coverage = evidence.evidenceCoverage
    const shortened = (kept) =>
        JSON.stringify({
            ...receipt,
            interpretationEvidence: {
                ...evidence,
                sourceEvidence: entries.slice(0, kept),
                evidenceCoverage: { ...coverage, complete: false, omittedFields: coverage.omittedFields + entries.length - kept }
            }
        })
    const minimum = shortened(0)
    if (minimum.length >= encoded.length) return encoded
    return {
        content: encoded,
        [verifiedSourceEvidence]: {
            minimum,
            fit(maxChars) {
                if (encoded.length <= maxChars) return encoded
                // Add whole observations. The omission count can only shrink as entries are restored.
                let kept = 0,
                    used = minimum.length
                for (const entry of entries) {
                    const size = JSON.stringify(entry).length + (kept === 0 ? 0 : 1)
                    if (used + size > maxChars) break
                    used += size
                    kept++
                }
                return kept ? shortened(kept) : minimum
            }
        }
    }
}

// Native and bundled lookups use different namespaces, including when a client supplies a crafted chat ID.
export function analystCaptureIdentity(context, native = context?.nativeSpecialists) {
    if (!native) return { harness: context?.name, chatId: context?.chatId }
    const owner = context.recall?.receipt?.ownerScope
    if (!owner && !context.turnId) throw new HarnessError('forbidden', 'Native Analyst requires an admitted turn.')
    // A slash is forbidden in saved harness names. An unowned turn cannot resume an earlier turn's cursor.
    return { harness: 'native/' + context.name, chatId: owner || context.turnId }
}

export async function prepareEmptyAnalystCard(context, binding, assertCurrent) {
    assertCurrent()
    if (!emptyNativeAnalystCard(binding)) throw new HarnessError('forbidden', 'The saved Analyst card changed.')
    const owner = await pinnedCallContext(context.roster, context.moduleOptions, context.chatId)
    const workspace = owner.flowOptions?.workspaceId
    const scoped = owner.flowOptions?.searchOptions?.workspaceId?._value
    if (!workspace || workspace !== context.roster.workspaceId || (scoped && scoped !== workspace))
        throw new HarnessError('forbidden', 'The Analyst workspace does not match the saved team.')
    assertCurrent()
    const item = await prepareModule(binding, '', {
        ...context.moduleOptions,
        nodeCache: undefined,
        flowOptions: { ...owner.flowOptions, requireReadOnlyAnalystUrl: false }
    })
    assertCurrent()
    if (item.runs || readyToolSpecs(item).length) throw new HarnessError('forbidden', 'The empty Analyst card exposed an action.')
    return item
}

// The binding's real node discovers and checks its saved actions, stamps, credential and guard settings.
// Route metadata lives for one delegation. Source receipts use the unique specialist turn. Cursors use the admitted owner and canvas generation.
export async function openNativeAnalyst({ context, specialist, assertCurrent, fitEvidence = false }) {
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
    const identity = analystCaptureIdentity(context, true)
    const scope = analystScopeKey(identity.harness, identity.chatId)
    const routeProfile = 'native-analyst-' + randomUUID()
    let closed = false
    const close = () => {
        if (closed) return
        closed = true
        endAnalystCalls(identity.harness, specialist.name, identity.chatId)
        forgetNativeToolRoutes(routeProfile)
    }
    try {
        beginAnalystCalls(identity.harness, specialist.name, identity.chatId)
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
                    captureHarness: identity.harness,
                    chatId: identity.chatId,
                    scope,
                    sourceTurn,
                    moduleOptions,
                    formatSourceReceipt: fitEvidence ? (receipt) => modelSourceReceipt(specialist, name, receipt) : undefined
                })
                if (result?.[verifiedSourceEvidence]) return result
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
