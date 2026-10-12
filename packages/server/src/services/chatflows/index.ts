import { randomBytes } from 'crypto'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { ICommonObject, removeFolderFromStorage } from '@cuttlely/components'
import { StatusCodes } from 'http-status-codes'
import { In, IsNull, QueryRunner, type DataSource, type EntityManager } from 'typeorm'
import { validate as isValidUUID } from 'uuid'
import { ChatflowType, IReactFlowObject, ScheduleInputMode, StartInputType } from '../../Interface'
import { FLOWISE_COUNTER_STATUS, FLOWISE_METRIC_COUNTERS } from '../../Interface.Metrics'
import { UsageCacheManager } from '../../UsageCacheManager'
import { ChatFlow, EnumChatflowType } from '../../database/entities/ChatFlow'
import { FlowVersionState } from '../../database/entities/FlowVersionState'
import { Lead } from '../../database/entities/Lead'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { ChatMessageFeedback } from '../../database/entities/ChatMessageFeedback'
import { ScheduleTriggerType } from '../../database/entities/ScheduleRecord'
import { UpsertHistory } from '../../database/entities/UpsertHistory'
import { Workspace } from '../../database/entities/identity'
import { OSS_PRODUCT_ID } from '../../identity/ossPlatform'
import { getWorkspaceSearchOptions } from '../../identity/workspaceScope'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import { ScheduleBeat } from '../../schedule/ScheduleBeat'
import documentStoreService from '../../services/documentstore'
import etlService, { orgIdForWorkspace } from '../../services/etl'
import scheduleService from '../../services/schedule'
import {
    constructGraphs,
    databaseEntities,
    decryptCredentialData,
    encryptCredentialData,
    getAppVersion,
    getEndingNodes,
    getTelemetryFlowObj,
    isFlowValidForStream
} from '../../utils'
import { containsBase64File, updateFlowDataWithFilePaths } from '../../utils/fileRepository'
import { sanitizeAllowedUploadMimeTypesFromConfig } from '../../utils/fileValidation'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { utilGetUploadsConfig } from '../../utils/getUploadsConfig'
import logger from '../../utils/logger'
import flowVersionsService from '../flow-versions'
import flowDraftsService, { withChatflowLock } from '../flow-drafts'
import { VersionActor } from '../flow-versions/author'
import { VersionKind } from '../flow-versions/store'
import { updateStorageUsage } from '../../utils/quotaUsage'
import { flowDataForPublicChatbotConfig } from '../../utils/sanitizeFlowData'

export const enum ChatflowErrorMessage {
    INVALID_CHATFLOW_TYPE = 'Invalid Chatflow Type',
    INVALID_CHATFLOW_ID = 'Invalid Chatflow ID',
    WORKSPACE_ID_REQUIRED = 'Workspace ID is required'
}

export function validateChatflowType(type: ChatflowType | undefined) {
    if (!Object.values(EnumChatflowType).includes(type as EnumChatflowType))
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, ChatflowErrorMessage.INVALID_CHATFLOW_TYPE)
}

// Check if chatflow valid for streaming
const checkIfChatflowIsValidForStreaming = async (chatflowId: string): Promise<any> => {
    try {
        const appServer = getRunningExpressApp()
        //**
        const chatflow = await appServer.AppDataSource.getRepository(ChatFlow).findOneBy({
            id: chatflowId
        })
        if (!chatflow) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${chatflowId} not found`)
        }

        /* Check for post-processing settings, if available isStreamValid is always false */
        let chatflowConfig: ICommonObject = {}
        if (chatflow.chatbotConfig) {
            chatflowConfig = JSON.parse(chatflow.chatbotConfig)
            if (chatflowConfig?.postProcessing?.enabled === true) {
                return { isStreaming: false }
            }
        }

        if (chatflow.type === 'AGENTFLOW') {
            return { isStreaming: true }
        }

        /*** Get Ending Node with Directed Graph  ***/
        const flowData = chatflow.flowData
        const parsedFlowData: IReactFlowObject = JSON.parse(flowData)
        const nodes = parsedFlowData.nodes
        const edges = parsedFlowData.edges
        const { graph, nodeDependencies } = constructGraphs(nodes, edges)

        const endingNodes = getEndingNodes(nodeDependencies, graph, nodes)

        let isStreaming = false
        for (const endingNode of endingNodes) {
            const endingNodeData = endingNode.data
            const isEndingNode = endingNodeData?.outputs?.output === 'EndingNode'
            // Once custom function ending node exists, flow is always unavailable to stream
            if (isEndingNode) {
                return { isStreaming: false }
            }
            isStreaming = isFlowValidForStream(nodes, endingNodeData)
        }

        // If it is a Multi/Sequential Agents, always enable streaming
        if (endingNodes.filter((node) => node.data.category === 'Multi Agents' || node.data.category === 'Sequential Agents').length > 0) {
            return { isStreaming: true }
        }

        const dbResponse = { isStreaming: isStreaming }
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.checkIfChatflowIsValidForStreaming - ${getErrorMessage(error)}`
        )
    }
}

// Check if chatflow valid for uploads
const checkIfChatflowIsValidForUploads = async (chatflowId: string): Promise<any> => {
    try {
        const dbResponse = await utilGetUploadsConfig(chatflowId)
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.checkIfChatflowIsValidForUploads - ${getErrorMessage(error)}`
        )
    }
}

const deleteChatflow = async (
    chatflowId: string,
    orgId: string,
    workspaceId: string,
    userPermittedTypes: EnumChatflowType[],
    actor?: VersionActor
): Promise<any> => {
    try {
        const appServer = getRunningExpressApp()

        const chatflow = await getChatflowById(chatflowId, workspaceId)
        if (!userPermittedTypes.includes(chatflow.type as EnumChatflowType))
            throw new InternalFlowiseError(StatusCodes.FORBIDDEN, `You do not have permission to delete this chatflow type`)

        // The flow row and the rows that hold what people typed into it (leads with name, email and phone, messages,
        // feedback, upsert history) go in one transaction: if any of them fails, the flow stays and nothing is half gone.
        const dbResponse = await appServer.AppDataSource.transaction(async (manager) => {
            await manager.getRepository(Lead).delete({ chatflowid: chatflowId })
            await manager.getRepository(ChatMessageFeedback).delete({ chatflowid: chatflowId })
            await manager.getRepository(ChatMessage).delete({ chatflowid: chatflowId })
            await manager.getRepository(UpsertHistory).delete({ chatflowid: chatflowId })
            return manager.getRepository(ChatFlow).delete({ id: chatflowId })
        })
        void flowVersionsService.recordFlowDeletion(chatflow, actor)
        // The flow's draft and Publish instantly setting go with it. A leftover row is harmless, so a failure here
        // does not stop the delete.
        await flowDraftsService
            .deleteStateFor(chatflowId)
            .catch((error: unknown) => logger.warn(`[server]: draft cleanup for ${chatflowId} failed: ${getErrorMessage(error)}`))

        // Update document store usage
        await documentStoreService.updateDocumentStoreUsage(chatflowId, undefined, workspaceId)

        if (chatflow.type === EnumChatflowType.ETL) await etlService.deletePipeline(chatflowId)

        // delete schedules related to the chatflow if it's an agentflow
        if (chatflow.type === EnumChatflowType.AGENTFLOW) {
            const existingRecord = await scheduleService.deleteScheduleForTarget(chatflow.id, ScheduleTriggerType.AGENTFLOW, workspaceId)
            if (existingRecord) {
                await ScheduleBeat.getInstance().onScheduleChanged(existingRecord.id, 'delete')
            }
        }

        try {
            // Delete all uploads corresponding to this chatflow
            const { totalSize } = await removeFolderFromStorage(orgId, chatflowId)
            await updateStorageUsage(orgId, workspaceId, totalSize, appServer.usageCacheManager)
        } catch (e) {
            logger.error(`[server]: Error deleting file storage for chatflow ${chatflowId}`)
        }
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.deleteChatflow - ${getErrorMessage(error)}`
        )
    }
}

const getAllChatflows = async (type?: ChatflowType, workspaceId?: string, page: number = -1, limit: number = -1) => {
    try {
        const appServer = getRunningExpressApp()

        const queryBuilder = appServer.AppDataSource.getRepository(ChatFlow)
            .createQueryBuilder('chat_flow')
            .orderBy('chat_flow.updatedDate', 'DESC')

        if (page > 0 && limit > 0) {
            queryBuilder.skip((page - 1) * limit)
            queryBuilder.take(limit)
        }
        if (type === 'MULTIAGENT') {
            queryBuilder.andWhere('chat_flow.type = :type', { type: 'MULTIAGENT' })
        } else if (type === 'AGENTFLOW') {
            queryBuilder.andWhere('chat_flow.type = :type', { type: 'AGENTFLOW' })
        } else if (type === 'ASSISTANT') {
            queryBuilder.andWhere('chat_flow.type = :type', { type: 'ASSISTANT' })
        } else if (type === 'CHATFLOW') {
            // fetch all chatflows that are not agentflow
            queryBuilder.andWhere('chat_flow.type = :type', { type: 'CHATFLOW' })
        } else if (type === 'HARNESS') {
            queryBuilder.andWhere('chat_flow.type = :type', { type: 'HARNESS' })
        } else if (type === 'ETL') {
            queryBuilder.andWhere('chat_flow.type = :type', { type: 'ETL' })
        }
        if (workspaceId) queryBuilder.andWhere('chat_flow.workspaceId = :workspaceId', { workspaceId })
        const [data, total] = await queryBuilder.getManyAndCount()

        if (page > 0 && limit > 0) {
            return { data, total }
        } else {
            return data
        }
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.getAllChatflows - ${getErrorMessage(error)}`
        )
    }
}

async function getAllChatflowsCountByOrganization(type: ChatflowType, organizationId: string): Promise<number> {
    try {
        const appServer = getRunningExpressApp()

        const workspaces = await appServer.AppDataSource.getRepository(Workspace).findBy({ organizationId })
        const workspaceIds = workspaces.map((workspace) => workspace.id)
        const chatflowsCount = await appServer.AppDataSource.getRepository(ChatFlow).countBy({
            type,
            workspaceId: In(workspaceIds)
        })

        return chatflowsCount
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.getAllChatflowsCountByOrganization - ${getErrorMessage(error)}`
        )
    }
}

const getAllChatflowsCount = async (type?: ChatflowType, workspaceId?: string): Promise<number> => {
    try {
        const appServer = getRunningExpressApp()
        if (type) {
            const dbResponse = await appServer.AppDataSource.getRepository(ChatFlow).countBy({
                type,
                ...getWorkspaceSearchOptions(workspaceId)
            })
            return dbResponse
        }
        const dbResponse = await appServer.AppDataSource.getRepository(ChatFlow).countBy(getWorkspaceSearchOptions(workspaceId))
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.getAllChatflowsCount - ${getErrorMessage(error)}`
        )
    }
}

/** Fields an API-key holder may see. The canvas and other configuration stay off this route. */
export type ApiKeyChatflowListing = {
    id: string
    name: string
    deployed: boolean
    category: string | null
    type: string | null
}

export const toApiKeyChatflowListing = (row: {
    id: string
    name: string
    deployed?: boolean | null
    category?: string | null
    type?: string | null
}): ApiKeyChatflowListing => ({
    id: row.id,
    name: row.name,
    deployed: row.deployed === true,
    category: typeof row.category === 'string' && row.category.length > 0 ? row.category : null,
    type: typeof row.type === 'string' && row.type.length > 0 ? row.type : null
})

const getChatflowByApiKey = async (apiKeyId: string, workspaceId: string): Promise<ApiKeyChatflowListing[]> => {
    try {
        if (!apiKeyId || !workspaceId) {
            throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, `Unauthorized`)
        }
        const appServer = getRunningExpressApp()
        const dbResponse = await appServer.AppDataSource.getRepository(ChatFlow)
            .createQueryBuilder('cf')
            .select(['cf.id', 'cf.name', 'cf.deployed', 'cf.category', 'cf.type', 'cf.apikeyid', 'cf.workspaceId'])
            .where('cf.workspaceId = :workspaceId', { workspaceId })
            .andWhere('cf.apikeyid = :apikeyid', { apikeyid: apiKeyId })
            .orderBy('cf.name', 'ASC')
            .getMany()
        const owned = dbResponse.filter((row) => row.apikeyid === apiKeyId && row.workspaceId === workspaceId)
        if (owned.length < 1) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow not found in the database!`)
        }
        return owned.map((row) => toApiKeyChatflowListing(row))
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.getChatflowByApiKey - ${getErrorMessage(error)}`
        )
    }
}

const getChatflowById = async (chatflowId: string, workspaceId?: string): Promise<any> => {
    try {
        if (!isValidUUID(chatflowId)) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, ChatflowErrorMessage.INVALID_CHATFLOW_ID)
        }
        const appServer = getRunningExpressApp()
        const dbResponse = await appServer.AppDataSource.getRepository(ChatFlow).findOne({
            where: {
                id: chatflowId,
                ...(workspaceId ? { workspaceId } : {})
            }
        })
        if (!dbResponse) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${chatflowId} not found in the database!`)
        }
        return dbResponse
    } catch (error) {
        if (error instanceof InternalFlowiseError) {
            throw error
        }
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.getChatflowById - ${getErrorMessage(error)}`
        )
    }
}

/** Resolves a chatflow only if it belongs to the given workspace; rejects when workspaceId is missing (prevents unscoped lookup). */
const getChatflowByIdForWorkspace = async (chatflowId: string, workspaceId: string | undefined): Promise<any> => {
    if (!workspaceId) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, ChatflowErrorMessage.WORKSPACE_ID_REQUIRED)
    }
    return getChatflowById(chatflowId, workspaceId)
}

/** Ensures every id exists as a chatflow in workspaceId. One DB query; pass queryRunner when inside a transaction for consistent reads. */
const assertChatflowIdsInWorkspace = async (chatflowIds: string[], workspaceId: string, queryRunner?: QueryRunner): Promise<void> => {
    try {
        if (chatflowIds.length === 0) return
        for (const id of chatflowIds) {
            if (!isValidUUID(id)) {
                throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, ChatflowErrorMessage.INVALID_CHATFLOW_ID)
            }
        }
        const appServer = getRunningExpressApp()
        const manager = queryRunner?.manager ?? appServer.AppDataSource.manager
        const found = await manager.getRepository(ChatFlow).find({
            where: { id: In(chatflowIds), workspaceId },
            select: ['id']
        })
        if (found.length !== chatflowIds.length) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                'Error: chatflowsService.assertChatflowIdsInWorkspace - one or more chatflows were not found in the workspace!'
            )
        }
    } catch (error) {
        if (error instanceof InternalFlowiseError) {
            throw error
        }
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.assertChatflowIdsInWorkspace - ${getErrorMessage(error)}`
        )
    }
}

const saveChatflow = async (
    newChatFlow: ChatFlow,
    orgId: string,
    workspaceId: string,
    subscriptionId: string,
    usageCacheManager: UsageCacheManager,
    actor?: VersionActor,
    // Promote labels the first version of a flow it creates, and gets the result of that record.
    record?: Pick<UpdateChatflowOptions, 'versionRecord' | 'onVersionQueued'>
): Promise<any> => {
    validateChatflowType(newChatFlow.type)
    await validateHarnessCanvas(newChatFlow)
    await validateEtlCanvas(newChatFlow)
    const appServer = getRunningExpressApp()

    let dbResponse: ChatFlow
    if (containsBase64File(newChatFlow)) {
        // we need a 2-step process, as we need to save the chatflow first and then update the file paths
        // this is because we need the chatflow id to create the file paths

        // step 1 - save with empty flowData
        const incomingFlowData = newChatFlow.flowData
        newChatFlow.flowData = JSON.stringify({})
        const chatflow = appServer.AppDataSource.getRepository(ChatFlow).create(newChatFlow)
        const step1Results = await appServer.AppDataSource.getRepository(ChatFlow).save(chatflow)

        // step 2 - convert base64 to file paths and update the chatflow
        step1Results.flowData = await updateFlowDataWithFilePaths(
            step1Results.id,
            incomingFlowData,
            orgId,
            workspaceId,
            subscriptionId,
            usageCacheManager
        )
        await _checkAndUpdateDocumentStoreUsage(step1Results, newChatFlow.workspaceId)
        dbResponse = await appServer.AppDataSource.getRepository(ChatFlow).save(step1Results)
    } else {
        const chatflow = appServer.AppDataSource.getRepository(ChatFlow).create(newChatFlow)
        dbResponse = await appServer.AppDataSource.getRepository(ChatFlow).save(chatflow)
    }
    // Queued at the save so history keeps database save order.
    const recorded = flowVersionsService.recordFlowVersion(dbResponse, {
        ...(record?.versionRecord || {}),
        ...(actor ? { author: actor } : {})
    })
    record?.onVersionQueued?.(recorded)

    // Check if the flow is agentflow and if it has a schedule node, if yes then notify the beat to sync the schedule
    if (dbResponse.type === EnumChatflowType.AGENTFLOW) {
        /*** Get chatflows and prepare data  ***/
        const flowData = dbResponse.flowData
        const parsedFlowData: IReactFlowObject = JSON.parse(flowData)
        const nodes = (parsedFlowData.nodes || []).filter((node) => node.data.name !== 'stickyNoteAgentflow')
        const startNode = nodes.find((node) => node.data.name === 'startAgentflow')
        const startInputType = startNode?.data?.inputs?.startInputType as StartInputType | undefined
        if (startInputType === 'scheduleInput') {
            const scheduleInputMode = startNode?.data?.inputs?.scheduleInputMode as ScheduleInputMode | undefined
            if (!scheduleInputMode) {
                throw new InternalFlowiseError(
                    StatusCodes.BAD_REQUEST,
                    'Schedule Input Mode is required on the Start node when Start Input Type is Schedule.'
                )
            }
            const resolvedCron = scheduleService.resolveScheduleCron(startNode?.data?.inputs || {})
            const scheduleTimezone = startNode?.data?.inputs?.scheduleTimezone || 'UTC'
            const scheduleDefaultInput = startNode?.data?.inputs?.scheduleDefaultInput || ''
            const scheduleFormDefaultsRaw = startNode?.data?.inputs?.scheduleFormDefaults
            const scheduleFormDefaults =
                scheduleInputMode === 'form'
                    ? typeof scheduleFormDefaultsRaw === 'string'
                        ? scheduleFormDefaultsRaw
                        : JSON.stringify(scheduleFormDefaultsRaw ?? {})
                    : undefined
            const scheduleEndDate = startNode?.data?.inputs?.scheduleEndDate ? new Date(startNode.data.inputs.scheduleEndDate) : undefined
            const enabled = scheduleService.canScheduleEnable(startNode?.data?.inputs ?? {})
            const record = await scheduleService.createOrUpdateSchedule({
                triggerType: ScheduleTriggerType.AGENTFLOW,
                targetId: dbResponse.id,
                nodeId: startNode?.id,
                cronExpression: resolvedCron.cronExpression || '',
                timezone: scheduleTimezone,
                enabled: enabled,
                scheduleInputMode,
                defaultInput: scheduleInputMode === 'text' ? scheduleDefaultInput : '',
                defaultForm: scheduleFormDefaults,
                workspaceId,
                endDate: scheduleEndDate
            })
            if (enabled) {
                // Notify the beat to sync the schedule
                await ScheduleBeat.getInstance().onScheduleChanged(record.id, 'upsert')
            }
        }
    }

    const productId = OSS_PRODUCT_ID

    await appServer.telemetry.sendTelemetry(
        'chatflow_created',
        {
            version: await getAppVersion(),
            chatflowId: dbResponse.id,
            flowGraph: getTelemetryFlowObj(JSON.parse(dbResponse.flowData)?.nodes, JSON.parse(dbResponse.flowData)?.edges),
            productId,
            subscriptionId
        },
        orgId
    )

    appServer.metricsProvider?.incrementCounter(
        dbResponse?.type === 'MULTIAGENT' ? FLOWISE_METRIC_COUNTERS.AGENTFLOW_CREATED : FLOWISE_METRIC_COUNTERS.CHATFLOW_CREATED,
        { status: FLOWISE_COUNTER_STATUS.SUCCESS }
    )

    await syncHarnessCanvas(dbResponse)
    await syncEtlCanvas(dbResponse)
    return dbResponse
}

// Options for the history record of this one save. Restore labels its own save this way, and gets the
// result of that record, so another save of the same flow at the same moment is never mislabeled.
export interface UpdateChatflowOptions {
    versionRecord?: { kind: VersionKind; title?: string; titlePrefix?: string; promotedFrom?: string }
    onVersionQueued?: (recorded: Promise<string | null>) => void
    // The signed-in user who made this save, for version history. None for API keys and system saves.
    actor?: VersionActor
    // Publish, and Roll back / Restore when they put a version Live: the conditional write matches this
    // canvas (and the type on the row). A Live update that lands after the check changes zero rows and
    // the save returns 409 instead of overwriting it. Publish writes only flowData. A version put Live
    // writes the whole row, still only while this canvas is the one stored.
    expectedFlowData?: string
}

// Test seam. A race test updates Live or inserts a draft after the check and before the conditional write.
export const liveWriteHooks: {
    beforeLiveWrite: null | (() => Promise<void>)
    beforeConditionalWrite: null | (() => Promise<void>)
} = { beforeLiveWrite: null, beforeConditionalWrite: null }

const PUBLISH_CONFLICT = 'Live changed while publishing, so nothing was published. Try again.'
const SAVE_CONFLICT = 'Live changed while this was being saved, so nothing was changed. Try again.'
const TYPE_CONFLICT = "This flow has unpublished changes. Publish or discard them before changing the flow's type."

const ROW_KEYS = [
    'name',
    'flowData',
    'deployed',
    'isPublic',
    'apikeyid',
    'chatbotConfig',
    'apiConfig',
    'analytic',
    'speechToText',
    'textToSpeech',
    'followUpPrompts',
    'category',
    'type',
    'mcpServerConfig',
    'webhookSecret',
    'webhookSecretConfigured',
    'workspaceId'
] as const

function rowPatch(flow: ChatFlow, updatedDate: Date, workspaceId: string): Partial<ChatFlow> {
    const patch: Partial<ChatFlow> = { updatedDate, workspaceId }
    for (const key of ROW_KEYS) {
        if (key === 'workspaceId') continue
        const value = flow[key]
        if (value !== undefined) (patch as Record<string, unknown>)[key] = value
    }
    return patch
}

async function inTransaction<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    const ds = getRunningExpressApp().AppDataSource
    if (typeof ds.transaction === 'function') return ds.transaction(fn)
    return fn(ds.manager)
}

function quote(ds: DataSource, name: string): string {
    return ds.driver?.escape ? ds.driver.escape(name) : `"${name}"`
}

// A type change is one statement: it lands only while no draft is stored. A draft inserted after the
// earlier read still makes this write change zero rows.
function noDraftClause(ds: DataSource): string {
    let table = 'flow_version_state'
    if (typeof ds.getMetadata === 'function') {
        try {
            table = ds.getMetadata(FlowVersionState).tableName
        } catch {
            // The unit-test data source has no metadata. The real one does.
        }
    }
    return `NOT EXISTS (SELECT 1 FROM ${quote(ds, table)} d WHERE d.${quote(ds, 'chatflowId')} = :id AND d.${quote(
        ds,
        'draftFlowData'
    )} IS NOT NULL)`
}

// Publish: one transaction. The read confirms the canvas the caller checked, then one UPDATE writes
// flowData only while that canvas and type are still stored. A Live update in between matches zero rows.
// Only flowData is written, so a concurrent change to another column is kept. The result is what this
// write stored, not a later read, so a later update cannot be recorded as this publish.
async function saveIfLiveUnchanged(flow: ChatFlow, workspaceId: string, expected: string, expectedType?: string | null): Promise<ChatFlow> {
    return inTransaction(async (manager) => {
        const repo = manager.getRepository(ChatFlow)
        const current = await repo.findOneBy({ id: flow.id, workspaceId })
        if (!current || current.flowData !== expected || (current.type ?? null) !== (expectedType ?? null)) {
            throw new InternalFlowiseError(StatusCodes.CONFLICT, PUBLISH_CONFLICT)
        }
        if (liveWriteHooks.beforeLiveWrite) await liveWriteHooks.beforeLiveWrite()
        const updatedDate = new Date()
        const result = await repo.update(
            { id: flow.id, workspaceId, flowData: expected, type: (expectedType ?? IsNull()) as any },
            { flowData: flow.flowData, updatedDate }
        )
        if (!result.affected) throw new InternalFlowiseError(StatusCodes.CONFLICT, PUBLISH_CONFLICT)
        return Object.assign(new ChatFlow(), flow, { type: expectedType ?? flow.type, updatedDate })
    })
}

// Roll back, Restore, and a type change: one conditional UPDATE. `expectedFlowData` keeps a version from
// overwriting a Live canvas that moved. A type change also requires that no draft is stored, in the same
// statement, so a draft saved after the earlier check still blocks it.
async function saveIfRowUnchanged(
    flow: ChatFlow,
    workspaceId: string,
    expectedType: string | null | undefined,
    requireNoDraft: boolean,
    expectedFlowData: string | undefined,
    conflictMessage: string
): Promise<ChatFlow> {
    const write = async (manager: EntityManager) => {
        if (liveWriteHooks.beforeConditionalWrite) await liveWriteHooks.beforeConditionalWrite()
        const ds = getRunningExpressApp().AppDataSource
        const updatedDate = new Date()
        const qb = manager.createQueryBuilder().update(ChatFlow).set(rowPatch(flow, updatedDate, workspaceId))
        qb.where(`${quote(ds, 'id')} = :id`, { id: flow.id })
        qb.andWhere(`${quote(ds, 'workspaceId')} = :workspaceId`, { workspaceId })
        if (expectedType == null) qb.andWhere(`${quote(ds, 'type')} IS NULL`)
        else qb.andWhere(`${quote(ds, 'type')} = :expectedType`, { expectedType })
        if (expectedFlowData !== undefined) qb.andWhere(`${quote(ds, 'flowData')} = :expectedFlowData`, { expectedFlowData })
        if (requireNoDraft) qb.andWhere(noDraftClause(ds))
        const result = await qb.execute()
        if (!result.affected) {
            if (requireNoDraft) {
                const state = await manager.getRepository(FlowVersionState).findOneBy({ chatflowId: flow.id })
                if (state?.draftFlowData) throw new InternalFlowiseError(StatusCodes.CONFLICT, TYPE_CONFLICT)
            }
            throw new InternalFlowiseError(StatusCodes.CONFLICT, conflictMessage)
        }
        return Object.assign(new ChatFlow(), flow, { updatedDate, workspaceId })
    }
    // The draft row and this type change share the chatflow row lock, so one commits before the other checks.
    if (requireNoDraft) return withChatflowLock(flow.id, write)
    return inTransaction(write)
}

async function restoreDocumentStoreUsage(chatflowId: string, workspaceId: string): Promise<void> {
    try {
        const live = await getRunningExpressApp().AppDataSource.getRepository(ChatFlow).findOneBy({ id: chatflowId, workspaceId })
        if (live) await _checkAndUpdateDocumentStoreUsage(live, workspaceId)
    } catch (error) {
        logger.warn(`[server]: Could not restore document store usage for ${chatflowId}: ${getErrorMessage(error)}`)
    }
}

const updateChatflow = async (
    chatflow: ChatFlow,
    updateChatFlow: ChatFlow,
    orgId: string,
    workspaceId: string,
    subscriptionId: string,
    options: UpdateChatflowOptions = {}
): Promise<any> => {
    const appServer = getRunningExpressApp()
    if (updateChatFlow.flowData && containsBase64File(updateChatFlow)) {
        updateChatFlow.flowData = await updateFlowDataWithFilePaths(
            chatflow.id,
            updateChatFlow.flowData,
            orgId,
            workspaceId,
            subscriptionId,
            appServer.usageCacheManager
        )
    }
    if (updateChatFlow.type || updateChatFlow.type === '') {
        validateChatflowType(updateChatFlow.type)
    } else {
        updateChatFlow.type = chatflow.type
    }
    // A draft holds a canvas of the flow's current type. Changing the type under an open draft (through the API,
    // Restore or Roll back) would let Publish store that canvas as the wrong kind of flow, so it waits.
    if (
        (updateChatFlow.type || 'CHATFLOW') !== (chatflow.type || 'CHATFLOW') &&
        (await flowDraftsService.getState(chatflow.id))?.draftFlowData
    ) {
        throw new InternalFlowiseError(StatusCodes.CONFLICT, TYPE_CONFLICT)
    }
    if (updateChatFlow.chatbotConfig) {
        try {
            const parsed = JSON.parse(updateChatFlow.chatbotConfig) as ICommonObject
            if (parsed?.fullFileUpload?.allowedUploadFileTypes !== undefined) {
                const current = parsed.fullFileUpload.allowedUploadFileTypes
                const sanitized = sanitizeAllowedUploadMimeTypesFromConfig(typeof current === 'string' ? current : String(current ?? ''))
                parsed.fullFileUpload.allowedUploadFileTypes = sanitized
                updateChatFlow.chatbotConfig = JSON.stringify(parsed)
            }
        } catch (error) {
            const message = getErrorMessage(error)
            logger.error(`[server]: Invalid chatbotConfig JSON in updateChatflow: ${message}`)
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, `Invalid chatbotConfig: ${message}`)
        }
    }
    // merge writes into chatflow, so the type the row has now is read first: the type check and the conditional
    // write compare against the stored row, not the merged one.
    const storedType = chatflow.type
    const newDbChatflow = appServer.AppDataSource.getRepository(ChatFlow).merge(chatflow, updateChatFlow)
    newDbChatflow.workspaceId = workspaceId // defense-in-depth: use trusted param, not chatflow.workspaceId (merge mutates in-place)
    await validateHarnessCanvas(newDbChatflow)
    await validateEtlCanvas(newDbChatflow)
    let dbResponse: ChatFlow
    const typeChanging = (updateChatFlow.type || 'CHATFLOW') !== (storedType || 'CHATFLOW')
    // Publish writes the canvas only. Putting a version Live also writes the name and type, still conditional
    // on the canvas that was checked. A type change is conditional on there being no draft.
    const canvasOnly = options.expectedFlowData !== undefined && !typeChanging && updateChatFlow.name == null
    const conditional = options.expectedFlowData !== undefined || typeChanging
    // Document store usage is updated before the save on both paths, so a later save's update always lands last,
    // as between two ordinary saves.
    await _checkAndUpdateDocumentStoreUsage(newDbChatflow, workspaceId)
    try {
        if (canvasOnly) {
            dbResponse = await saveIfLiveUnchanged(newDbChatflow, workspaceId, options.expectedFlowData as string, storedType)
        } else if (conditional) {
            dbResponse = await saveIfRowUnchanged(
                newDbChatflow,
                workspaceId,
                storedType,
                typeChanging,
                options.expectedFlowData,
                options.versionRecord?.kind === 'publish' ? PUBLISH_CONFLICT : SAVE_CONFLICT
            )
        } else {
            dbResponse = await appServer.AppDataSource.getRepository(ChatFlow).save(newDbChatflow)
        }
    } catch (error) {
        if (conditional) await restoreDocumentStoreUsage(chatflow.id, workspaceId)
        throw error
    }
    // Queued at the save so history keeps database save order.
    const recorded = flowVersionsService.recordFlowVersion(dbResponse, {
        ...(options.versionRecord || {}),
        ...(options.actor ? { author: options.actor } : {})
    })
    options.onVersionQueued?.(recorded)

    // Check if the flow is agentflow and if it has a schedule node, if yes then notify the beat to sync the schedule
    if (dbResponse.type === EnumChatflowType.AGENTFLOW) {
        const flowData = dbResponse.flowData
        const parsedFlowData: IReactFlowObject = JSON.parse(flowData)
        const nodes = (parsedFlowData.nodes || []).filter((node) => node.data.name !== 'stickyNoteAgentflow')
        const startNode = nodes.find((node) => node.data.name === 'startAgentflow')
        const startInputType = startNode?.data?.inputs?.startInputType as StartInputType | undefined
        if (startInputType === 'scheduleInput') {
            const scheduleInputMode = startNode?.data?.inputs?.scheduleInputMode as ScheduleInputMode | undefined
            if (!scheduleInputMode) {
                throw new InternalFlowiseError(
                    StatusCodes.BAD_REQUEST,
                    'Schedule Input Mode is required on the Start node when Start Input Type is Schedule.'
                )
            }
            const resolvedCron = scheduleService.resolveScheduleCron(startNode?.data?.inputs || {})
            const scheduleTimezone = startNode?.data?.inputs?.scheduleTimezone || 'UTC'
            const scheduleDefaultInput = startNode?.data?.inputs?.scheduleDefaultInput || ''
            const scheduleFormDefaultsRaw = startNode?.data?.inputs?.scheduleFormDefaults
            const scheduleFormDefaults =
                scheduleInputMode === 'form'
                    ? typeof scheduleFormDefaultsRaw === 'string'
                        ? scheduleFormDefaultsRaw
                        : JSON.stringify(scheduleFormDefaultsRaw ?? {})
                    : undefined
            const scheduleEndDate = startNode?.data?.inputs?.scheduleEndDate ? new Date(startNode.data.inputs.scheduleEndDate) : undefined
            const canEnable = scheduleService.canScheduleEnable(startNode?.data?.inputs ?? {})
            const record = await scheduleService.createOrUpdateSchedule({
                triggerType: ScheduleTriggerType.AGENTFLOW,
                targetId: dbResponse.id,
                nodeId: startNode?.id,
                cronExpression: resolvedCron.cronExpression || '',
                timezone: scheduleTimezone,
                enabled: canEnable === false ? false : undefined, // automatically disable schedule if it cannot be enabled; otherwise preserve the existing enabled value
                scheduleInputMode,
                defaultInput: scheduleInputMode === 'text' ? scheduleDefaultInput : '',
                defaultForm: scheduleFormDefaults,
                workspaceId,
                endDate: scheduleEndDate
            })
            if (record.enabled) {
                // Notify the beat to sync the (enabled) schedule
                await ScheduleBeat.getInstance().onScheduleChanged(record.id, 'upsert')
            } else {
                // Schedule is disabled; ensure any existing scheduled job is removed
                await ScheduleBeat.getInstance().onScheduleChanged(record.id, 'delete')
            }
        } else {
            // If the start node is not scheduleInput, then we need to delete the existing schedule if it exists
            const existingRecord = await scheduleService.deleteScheduleForTarget(dbResponse.id, ScheduleTriggerType.AGENTFLOW, workspaceId)
            if (existingRecord) {
                await ScheduleBeat.getInstance().onScheduleChanged(existingRecord.id, 'delete')
            }
        }
    }

    await syncHarnessCanvas(dbResponse)
    await syncEtlCanvas(dbResponse)
    return dbResponse
}

async function validateEtlCanvas(chatflow: ChatFlow) {
    if (chatflow.type !== EnumChatflowType.ETL) return
    await etlService.validatePipelineFlow(chatflow)
}

async function syncEtlCanvas(chatflow: ChatFlow) {
    if (chatflow.type !== EnumChatflowType.ETL) return
    await etlService.syncPipelineFromFlow(chatflow)
}

async function validateHarnessCanvas(chatflow: ChatFlow) {
    if (chatflow.type !== EnumChatflowType.HARNESS) return
    const engine = await loadHarnessSync()
    try {
        engine.rosterFromFlow({
            name: chatflow.name,
            chatflowId: chatflow.id,
            flowData: chatflow.flowData,
            workspaceId: chatflow.workspaceId,
            componentNodes: getRunningExpressApp().nodesPool.componentNodes
        })
    } catch (error) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, getErrorMessage(error))
    }
}

async function syncHarnessCanvas(chatflow: ChatFlow) {
    if (chatflow.type !== EnumChatflowType.HARNESS) return
    const engine = await loadHarnessSync()
    const appServer = getRunningExpressApp()
    const componentNodes = appServer.nodesPool.componentNodes
    let orgId: string | undefined
    try {
        orgId = await orgIdForWorkspace(chatflow.workspaceId)
    } catch (error) {
        logger.warn(`[harness] workspace org lookup failed: ${getErrorMessage(error)}`)
    }
    try {
        // Warnings are logged by the harness sync. The chatflow response has no warnings field.
        await engine.syncHarnessFromFlow({
            name: chatflow.name,
            chatflowId: chatflow.id,
            flowData: chatflow.flowData,
            workspaceId: chatflow.workspaceId,
            componentNodes,
            flowOptions: {
                appDataSource: appServer.AppDataSource,
                databaseEntities,
                logger,
                componentNodes,
                chatflowid: chatflow.id,
                workspaceId: chatflow.workspaceId || undefined,
                orgId,
                baseURL: process.env.CUTTLELY_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`,
                cachePool: appServer.cachePool
            }
        })
    } catch (error) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, getErrorMessage(error))
    }
}

async function loadHarnessSync() {
    let dir = __dirname
    let moduleUrl = ''
    for (let i = 0; i < 8; i += 1) {
        const candidates = [path.join(dir, 'packages', 'harness', 'sync-from-flow.mjs'), path.join(dir, 'harness', 'sync-from-flow.mjs')]
        const candidate = candidates.find((file) => fs.existsSync(file))
        if (candidate) {
            moduleUrl = pathToFileURL(candidate).href
            break
        }
        dir = path.dirname(dir)
    }
    if (!moduleUrl) {
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Harness canvas sync could not find the harness engine.')
    }
    // tsc rewrites import() into require(), which cannot load the ESM harness package.
    const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>
    return importEsm(moduleUrl)
}

// Get specific chatflow chatbotConfig via id (PUBLIC endpoint, used to retrieve config for embedded chat).
// An unprotected chatflow gets sanitized flowData. A key-protected chatflow does not get the canvas:
// only the Start node's form fields, which the embed widget reads.
const getSinglePublicChatbotConfig = async (chatflowId: string): Promise<any> => {
    try {
        const appServer = getRunningExpressApp()
        const dbResponse = await appServer.AppDataSource.getRepository(ChatFlow).findOneBy({
            id: chatflowId
        })
        if (!dbResponse) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${chatflowId} not found`)
        }
        const uploadsConfig = await utilGetUploadsConfig(chatflowId)
        // even if chatbotConfig is not set but uploads are enabled
        // send uploadsConfig to the chatbot
        if (dbResponse.chatbotConfig || uploadsConfig) {
            try {
                const parsedConfig = dbResponse.chatbotConfig ? JSON.parse(dbResponse.chatbotConfig) : {}
                const ttsConfig =
                    typeof dbResponse.textToSpeech === 'string' ? JSON.parse(dbResponse.textToSpeech) : dbResponse.textToSpeech

                let isTTSEnabled = false
                if (ttsConfig) {
                    Object.keys(ttsConfig).forEach((provider) => {
                        if (provider !== 'none' && ttsConfig?.[provider]?.status) {
                            isTTSEnabled = true
                        }
                    })
                }
                delete parsedConfig.allowedOrigins
                delete parsedConfig.allowedOriginsError
                const flowData = flowDataForPublicChatbotConfig(dbResponse.flowData, dbResponse.apikeyid)
                return {
                    ...parsedConfig,
                    uploads: uploadsConfig,
                    ...(flowData !== undefined ? { flowData } : {}),
                    isTTSEnabled
                }
            } catch (e) {
                throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Error parsing Chatbot Config for Chatflow ${chatflowId}`)
            }
        }
        return 'OK'
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.getSinglePublicChatbotConfig - ${getErrorMessage(error)}`
        )
    }
}

const _checkAndUpdateDocumentStoreUsage = async (chatflow: ChatFlow, workspaceId?: string) => {
    const parsedFlowData: IReactFlowObject = JSON.parse(chatflow.flowData)
    const nodes = parsedFlowData.nodes
    // from the nodes array find if there is a node with name == documentStore)
    const node = nodes.length > 0 && nodes.find((node) => node.data.name === 'documentStore')
    if (!node || !node.data || !node.data.inputs || node.data.inputs['selectedStore'] === undefined) {
        await documentStoreService.updateDocumentStoreUsage(chatflow.id, undefined, workspaceId)
    } else {
        await documentStoreService.updateDocumentStoreUsage(chatflow.id, node.data.inputs['selectedStore'], workspaceId)
    }
}

const checkIfChatflowHasChanged = async (chatflowId: string, lastUpdatedDateTime: string, workspaceId: string): Promise<any> => {
    try {
        const chatflow = await getChatflowByIdForWorkspace(chatflowId, workspaceId)
        if (!chatflow) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${chatflowId} not found`)
        }
        return { hasChanged: chatflow.updatedDate.toISOString() !== lastUpdatedDateTime }
    } catch (error) {
        if (error instanceof InternalFlowiseError) {
            throw error
        }
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.checkIfChatflowHasChanged - ${getErrorMessage(error)}`
        )
    }
}

const setWebhookSecret = async (chatflowId: string, workspaceId: string): Promise<{ webhookSecret: string }> => {
    try {
        const appServer = getRunningExpressApp()
        const repo = appServer.AppDataSource.getRepository(ChatFlow)
        const chatflow = await repo.findOne({ where: { id: chatflowId, workspaceId } })
        if (!chatflow) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${chatflowId} not found`)
        const plaintext = randomBytes(32).toString('hex')
        chatflow.webhookSecret = await encryptCredentialData({ secret: plaintext })
        chatflow.webhookSecretConfigured = true
        await repo.save(chatflow)
        return { webhookSecret: plaintext }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.setWebhookSecret - ${getErrorMessage(error)}`
        )
    }
}

const clearWebhookSecret = async (chatflowId: string, workspaceId: string): Promise<void> => {
    try {
        const appServer = getRunningExpressApp()
        const repo = appServer.AppDataSource.getRepository(ChatFlow)
        const chatflow = await repo.findOne({ where: { id: chatflowId, workspaceId } })
        if (!chatflow) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${chatflowId} not found`)
        chatflow.webhookSecret = null
        chatflow.webhookSecretConfigured = false
        await repo.save(chatflow)
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.clearWebhookSecret - ${getErrorMessage(error)}`
        )
    }
}

const getWebhookSecret = async (chatflowId: string, workspaceId: string): Promise<string | null> => {
    try {
        const appServer = getRunningExpressApp()
        const dbResponse = await appServer.AppDataSource.getRepository(ChatFlow)
            .createQueryBuilder('chatflow')
            .select('chatflow.webhookSecret')
            .where('chatflow.id = :id', { id: chatflowId })
            .andWhere('chatflow.workspaceId = :workspaceId', { workspaceId })
            .getOne()
        const stored = dbResponse?.webhookSecret
        if (!stored) return null
        const decrypted = await decryptCredentialData(stored)
        return (decrypted?.secret as string | undefined) ?? null
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.getWebhookSecret - ${getErrorMessage(error)}`
        )
    }
}

export default {
    assertChatflowIdsInWorkspace,
    checkIfChatflowIsValidForStreaming,
    checkIfChatflowIsValidForUploads,
    deleteChatflow,
    getAllChatflows,
    getAllChatflowsCount,
    getChatflowByApiKey,
    getChatflowById,
    getChatflowByIdForWorkspace,
    saveChatflow,
    updateChatflow,
    getSinglePublicChatbotConfig,
    checkIfChatflowHasChanged,
    getAllChatflowsCountByOrganization,
    setWebhookSecret,
    clearWebhookSecret,
    getWebhookSecret
}
