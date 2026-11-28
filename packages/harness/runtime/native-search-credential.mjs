import { isDeepStrictEqual } from 'node:util'
import { supportsNativeCanvasBinding, unboundNativeSerp } from '../../../scripts/native-canvas-bindings.mjs'
import { prepareModule } from '../bridge.mjs'
import { publishedCanvasSource } from '../canvas-ownership.mjs'
import { HarnessError } from '../errors.mjs'
import { managedUploadActor } from '../prediction-files.mjs'
import { getHarness } from '../store.mjs'

const fields = ['workspaceId', 'flowId', 'generation', 'revision', 'role', 'nodeId', 'credentialId']
const unavailable = () =>
    new HarnessError(
        'bad_binding',
        'The published SerpAPI credential binding is unavailable. Review the selected workspace credential and publication.'
    )

// The host supplies metadata only. A serialized Try, a draft or a similarly named card cannot stand in for this publication.
export function publishedSearchCredential(roster, specialist, binding) {
    const raw = process.env.CUTTLELY_NATIVE_SEARCH_CREDENTIALS
    if (!raw || raw.length > 32768 || !unboundNativeSerp(binding) || !binding.nodeId || !roster.workspaceId || !roster.chatflowId) return
    const current = roster.tryId ? publishedCanvasSource(roster, { livePrediction: true }) : getHarness(roster.name)
    if (
        !current?.createdAt ||
        !current.updatedAt ||
        current.tryId ||
        current.workspaceId !== roster.workspaceId ||
        current.chatflowId !== roster.chatflowId
    )
        return
    if (!roster.tryId && (roster.createdAt !== current.createdAt || roster.updatedAt !== current.updatedAt)) return
    const role = current.specialists.find((item) => item.name === specialist.name)
    if (!role || !isDeepStrictEqual(role.modules, specialist.modules)) return
    if (['shell', 'browser', 'codeExecution', 'fileAccess'].some((flag) => Boolean(role[flag]) !== Boolean(specialist[flag]))) return
    const matches = role.modules.filter((card) => card.nodeId === binding.nodeId)
    if (matches?.length !== 1 || !isDeepStrictEqual(matches[0], binding)) return
    let entries
    try {
        entries = JSON.parse(raw)
    } catch {
        return
    }
    if (!Array.isArray(entries) || entries.length > 128) return
    const selected = entries.filter(
        (e) =>
            e &&
            e.workspaceId === current.workspaceId &&
            e.flowId === current.chatflowId &&
            e.generation === current.createdAt &&
            e.revision === current.updatedAt &&
            e.role === role.name &&
            e.nodeId === binding.nodeId
    )
    if (selected.length !== 1) return
    const entry = selected[0]
    if (
        Object.keys(entry).length !== fields.length ||
        fields.some((key) => !Object.hasOwn(entry, key)) ||
        typeof entry.credentialId !== 'string' ||
        !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(entry.credentialId)
    )
        return
    return entry.credentialId
}

// A browser specialist can perform its separately assigned, operator-bound search under on-demand
// admission. There is no page or browser tool in this mode. A saved clock can provide date context.
export function publishedBrowserSearch(roster, role) {
    if (
        !process.env.CUTTLELY_NATIVE_SEARCH_CREDENTIALS ||
        !role.browser ||
        role.shell ||
        role.codeExecution ||
        role.fileAccess ||
        role.mcpServers?.length ||
        role.playbooks?.length ||
        role.trustedOutputs?.length ||
        !role.modules?.length ||
        role.modules.length > 2
    )
        return
    const searches = role.modules.filter(unboundNativeSerp)
    if (
        searches.length !== 1 ||
        role.modules.some((b) => b !== searches[0] && (b.nodeName !== 'currentDateTime' || !supportsNativeCanvasBinding(b)))
    )
        return
    if (publishedSearchCredential(roster, role, searches[0])) return searches[0]
}

// The component still resolves and decrypts its normal saved credential. Its single database read must match the
// pinned ID, the actual workspace owner and the SerpAPI type in the same query. Explicit sharing does not grant this host binding.
export async function preparePublishedSearch(context, specialist, binding, input, credentialId) {
    const options = context.moduleOptions
    const flow = options.flowOptions || {}
    const entity = flow.databaseEntities?.Credential
    const workspaceId = context.roster.workspaceId
    const caller = flow.nestedFlowCaller
    const actor = managedUploadActor(caller)
    if (
        !actor ||
        flow.nestedFlowDepth !== 0 ||
        caller.via !== flow.harnessCaller?.via ||
        caller.apiKeyId !== flow.harnessCaller.apiKeyId ||
        (context.roster.tryId && context.roster.tryOwner !== actor) ||
        (!context.roster.tryId &&
            caller.via === 'api_key' &&
            (flow.harnessCaller.harnessIds?.[context.roster.name] !== context.roster.chatflowId ||
                flow.expectedHarnessChatflowId !== context.roster.chatflowId)) ||
        !entity ||
        !flow.appDataSource?.getRepository ||
        flow.workspaceId !== workspaceId
    )
        throw unavailable()
    function assertBinding() {
        context.assertNativeAuthority()
        if (publishedSearchCredential(context.roster, specialist, binding) !== credentialId) throw unavailable()
    }
    const appDataSource = {
        getRepository(requested) {
            if (entity !== requested) throw unavailable()
            return {
                findOneBy(criteria) {
                    if (criteria?.id !== credentialId) throw unavailable()
                    return flow.appDataSource.getRepository(entity).findOneBy({ id: credentialId, workspaceId, credentialName: 'serpApi' })
                }
            }
        }
    }
    async function currentTool() {
        assertBinding()
        try {
            const prepared = await prepareModule({ ...binding, credential: credentialId }, input, {
                ...options,
                nodeCache: new Map(),
                flowOptions: { ...flow, appDataSource }
            })
            assertBinding()
            if (typeof prepared.tool?.invoke !== 'function') throw unavailable()
            return prepared.tool
        } catch (error) {
            if (error?.harnessError && error.code !== 'bad_binding') throw error
            throw unavailable()
        }
    }
    const current = await currentTool()
    const tool = {
        name: current.name,
        description: current.description,
        schema: current.schema,
        async invoke(value) {
            const fresh = await currentTool()
            assertBinding()
            try {
                return await fresh.invoke(value)
            } catch (error) {
                context.assertNativeAuthority()
                // Permit the bridge's schema-only retry without returning inputs or provider diagnostics.
                if (error?.name === 'ZodError' || /did not match expected schema/i.test(String(error?.message)))
                    throw new HarnessError('bad_input', 'Input did not match expected schema.')
                throw new HarnessError('bad_binding', 'The SerpAPI search request did not complete.')
            }
        }
    }
    return { binding, tool, ready: tool, runs: false }
}
