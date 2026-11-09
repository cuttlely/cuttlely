import type { ICommonObject, INestedFlowRequest, RunNestedFlow } from '@cuttlely/components'
import { v4 as uuidv4 } from 'uuid'
import { ChatFlow } from '../database/entities/ChatFlow'
import { AppError } from '../errors/appError'
import { AccessKeyAuthenticationError } from '../services/accessKeys/errors'
import { authorizeNestedFlowKey } from '../services/accessKeys/authorization'
import { ChatType, IComponentNodes, IHarnessCaller, INestedFlowCaller, IPredictionQueueAppServer } from '../Interface'

export const MAX_NESTED_FLOW_DEPTH = 8

export interface NestedFlowNodeOptions extends ICommonObject {
    nestedFlowCaller: INestedFlowCaller
    nestedFlowDepth: number
    runNestedFlow: RunNestedFlow
}

interface NestedFlowRuntime extends IPredictionQueueAppServer {
    parentFlowId: string
    parentWorkspaceId: string
    caller: INestedFlowCaller
    depth: number
    baseURL: string
    orgId: string
    subscriptionId: string
    productId: string
    signal?: AbortController
}

export function nestedFlowCallerFromHarness(caller?: IHarnessCaller): INestedFlowCaller | undefined {
    if (!caller) return undefined
    return caller.via === 'api_key' ? { via: 'api_key', apiKeyId: caller.apiKeyId } : { via: caller.via }
}

export async function authorizeNestedFlowCaller(
    caller: INestedFlowCaller,
    parentWorkspaceId: string,
    target: ChatFlow
): Promise<IHarnessCaller> {
    if (target.workspaceId !== parentWorkspaceId) throw new AppError(403, 'A nested flow must belong to the parent workspace.')
    if (caller.via === 'session') return { via: 'session' }
    if (caller.via === 'api_key') return authorizeNestedFlowKey(caller.apiKeyId, target)
    if (target.apiAccessMode === 'public' && !target.apikeyid) return { via: 'flow' }
    throw new AccessKeyAuthenticationError()
}

async function runNestedFlow(runtime: NestedFlowRuntime, request: INestedFlowRequest): Promise<ICommonObject> {
    if (request.targetFlowId === runtime.parentFlowId) throw new AppError(400, 'A flow cannot call itself.')
    if (runtime.depth >= MAX_NESTED_FLOW_DEPTH) throw new AppError(400, `Nested flow calls are limited to ${MAX_NESTED_FLOW_DEPTH} levels.`)

    const target = await runtime.appDataSource.getRepository(ChatFlow).findOneBy({ id: request.targetFlowId })
    if (!target) throw new AppError(404, `Chatflow ${request.targetFlowId} not found`)
    const harnessCaller = await authorizeNestedFlowCaller(runtime.caller, runtime.parentWorkspaceId, target)
    const chatId = request.chatId || uuidv4()
    const incomingInput = {
        question: request.question,
        chatId,
        overrideConfig: request.overrideConfig || {},
        streaming: false
    }

    if (target.type === 'HARNESS') {
        const { default: harnessesService } = await import('../services/harnesses')
        const outcome = await harnessesService.startCanvasRun(target, incomingInput, {
            source: 'playground',
            caller: harnessCaller,
            canvas: 'live',
            nestedFlowCaller: runtime.caller,
            nestedFlowDepth: runtime.depth + 1,
            ...(runtime.signal ? { signal: runtime.signal.signal } : {})
        })
        return { chatId: outcome.chatId, run: outcome.run, ...(outcome.payload || {}) }
    }

    const { executeFlow } = await import('./buildChatflow')
    const result = await executeFlow({
        componentNodes: runtime.componentNodes as IComponentNodes,
        incomingInput,
        chatflow: target,
        chatId,
        appDataSource: runtime.appDataSource,
        telemetry: runtime.telemetry,
        cachePool: runtime.cachePool,
        usageCacheManager: runtime.usageCacheManager,
        sseStreamer: runtime.sseStreamer,
        baseURL: runtime.baseURL,
        isInternal: true,
        isTool: true,
        chatType: ChatType.INTERNAL,
        orgId: runtime.orgId,
        workspaceId: runtime.parentWorkspaceId,
        subscriptionId: runtime.subscriptionId,
        productId: runtime.productId,
        signal: runtime.signal,
        harnessCaller,
        nestedFlowCaller: runtime.caller,
        nestedFlowDepth: runtime.depth + 1
    })
    return result && typeof result === 'object' ? result : { text: result == null ? '' : String(result) }
}

export function nestedFlowNodeOptions(runtime: NestedFlowRuntime): NestedFlowNodeOptions {
    return {
        nestedFlowCaller: { ...runtime.caller },
        nestedFlowDepth: runtime.depth,
        runNestedFlow: (request: INestedFlowRequest) => runNestedFlow(runtime, request)
    }
}
