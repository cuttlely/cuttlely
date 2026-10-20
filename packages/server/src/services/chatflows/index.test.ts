/**
 * Unit tests for chatflowsService.saveChatflow and chatflowsService.updateChatflow.
 * All infrastructure (TypeORM, ScheduleService, ScheduleBeat, telemetry, etc.)
 * is mocked — no DB or Express app required.
 */

// ─── Shared repo mock ─────────────────────────────────────────────────────────

const mockRepo = {
    findOneBy: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    merge: jest.fn(),
    update: jest.fn(),
    countBy: jest.fn(),
    createQueryBuilder: jest.fn()
}

let casExecute: ((qb: any) => Promise<{ affected: number }>) | null = null
function makeQb() {
    const qb: any = {
        _set: null,
        _wheres: [] as { sql: string; params?: Record<string, unknown> }[],
        update: () => qb,
        set: (value: unknown) => {
            qb._set = value
            return qb
        },
        where: (sql: string, params?: Record<string, unknown>) => {
            qb._wheres.push({ sql, params })
            return qb
        },
        andWhere: (sql: string, params?: Record<string, unknown>) => {
            qb._wheres.push({ sql, params })
            return qb
        },
        execute: async () => (casExecute ? casExecute(qb) : { affected: 1 })
    }
    return qb
}

const mockAppServer = {
    AppDataSource: {
        getRepository: jest.fn().mockReturnValue(mockRepo),
        transaction: jest.fn(async (fn: (manager: any) => Promise<unknown>) =>
            fn({ getRepository: () => mockRepo, createQueryBuilder: () => makeQb() })
        ),
        driver: { escape: (name: string) => `"${name}"` },
        options: {},
        getMetadata: () => ({ tableName: 'flow_version_state' })
    },
    telemetry: {
        sendTelemetry: jest.fn().mockResolvedValue(undefined)
    },
    identityManager: {
        getProductIdFromSubscription: jest.fn().mockResolvedValue('prod-1')
    },
    metricsProvider: {
        incrementCounter: jest.fn()
    },
    usageCacheManager: {}
}

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn().mockReturnValue(mockAppServer)
}))
jest.mock('../../database/entities/ChatFlow', () => ({
    ChatFlow: class ChatFlow {},
    EnumChatflowType: { AGENTFLOW: 'AGENTFLOW', CHATFLOW: 'CHATFLOW', MULTIAGENT: 'MULTIAGENT', HARNESS: 'HARNESS' }
}))
jest.mock('../../database/entities/ChatMessage', () => ({ ChatMessage: class ChatMessage {} }))
jest.mock('../../database/entities/ChatMessageFeedback', () => ({ ChatMessageFeedback: class ChatMessageFeedback {} }))
jest.mock('../../database/entities/UpsertHistory', () => ({ UpsertHistory: class UpsertHistory {} }))
jest.mock('../../database/entities/Lead', () => ({ Lead: class Lead {} }))
jest.mock('../../database/entities/ScheduleRecord', () => ({
    ScheduleRecord: class ScheduleRecord {},
    ScheduleTriggerType: { AGENTFLOW: 'AGENTFLOW' }
}))
jest.mock('../../database/entities/identity/Workspace', () => ({ Workspace: class Workspace {} }))
jest.mock('../../errors/appError', () => ({
    AppError: class AppError extends Error {
        constructor(public statusCode: number, message: string) {
            super(message)
        }
    }
}))
jest.mock('../../errors/utils', () => ({ getErrorMessage: (e: unknown) => String(e) }))
jest.mock('../../services/documentstore', () => ({
    __esModule: true,
    default: { updateDocumentStoreUsage: jest.fn().mockResolvedValue(undefined) }
}))
jest.mock('../../utils', () => ({
    constructGraphs: jest.fn().mockReturnValue({ graph: {}, nodeDependencies: {} }),
    getAppVersion: jest.fn().mockResolvedValue('1.0.0'),
    getEndingNodes: jest.fn().mockReturnValue([]),
    getTelemetryFlowObj: jest.fn().mockReturnValue({}),
    isFlowValidForStream: jest.fn().mockReturnValue(false)
}))
jest.mock('../../utils/fileValidation', () => ({
    sanitizeAllowedUploadMimeTypesFromConfig: jest.fn((x: string) => x)
}))
jest.mock('../../utils/fileRepository', () => ({
    containsBase64File: jest.fn().mockReturnValue(false),
    updateFlowDataWithFilePaths: jest.fn().mockImplementation(async (_id: string, fd: string) => fd)
}))
jest.mock('../../utils/sanitizeFlowData', () => jest.requireActual('../../utils/sanitizeFlowData'))
jest.mock('../../utils/getUploadsConfig', () => ({ utilGetUploadsConfig: jest.fn().mockResolvedValue(null) }))
jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() }
}))
jest.mock('../../utils/quotaUsage', () => ({ updateStorageUsage: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../../services/schedule', () => ({
    __esModule: true,
    default: {
        resolveScheduleCron: jest.fn().mockReturnValue({ valid: true, cronExpression: '* * * * *' }),
        canScheduleEnable: jest.fn().mockReturnValue(true),
        createOrUpdateSchedule: jest.fn().mockResolvedValue({ id: 'sched-1', enabled: true }),
        deleteScheduleForTarget: jest.fn().mockResolvedValue(undefined)
    }
}))
jest.mock('../../schedule/ScheduleBeat', () => ({
    ScheduleBeat: {
        getInstance: jest.fn().mockReturnValue({
            onScheduleChanged: jest.fn().mockResolvedValue(undefined)
        })
    }
}))
jest.mock('@cuttlely/components', () => ({ removeFolderFromStorage: jest.fn().mockResolvedValue({ totalSize: 0 }) }), { virtual: true })
jest.mock('uuid', () => ({ validate: jest.fn().mockReturnValue(true) }))
jest.mock('../flow-versions', () => ({
    __esModule: true,
    default: {
        recordFlowVersion: jest.fn().mockResolvedValue(null),
        recordFlowDeletion: jest.fn().mockResolvedValue(null)
    }
}))
jest.mock('http-status-codes', () => ({
    StatusCodes: { OK: 200, BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, INTERNAL_SERVER_ERROR: 500 }
}))

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import chatflowsService, { liveWriteHooks, validateReferencedHarnesses } from './index'
import harnessesService from '../../services/harnesses'
import scheduleService from '../../services/schedule'
import { ScheduleBeat } from '../../schedule/ScheduleBeat'
import { containsBase64File } from '../../utils/fileRepository'
import { EnumChatflowType } from '../../database/entities/ChatFlow'
import { ScheduleTriggerType } from '../../database/entities/ScheduleRecord'
import flowVersionsService from '../flow-versions'
import documentStoreService from '../../services/documentstore'

const mockContainsBase64File = containsBase64File as jest.Mock
const { removeFolderFromStorage } = jest.requireMock('@cuttlely/components') as { removeFolderFromStorage: jest.Mock }
const mockCreateOrUpdateSchedule = scheduleService.createOrUpdateSchedule as jest.Mock
const mockDeleteScheduleForTarget = scheduleService.deleteScheduleForTarget as jest.Mock
const mockResolveScheduleCron = scheduleService.resolveScheduleCron as jest.Mock
const mockCanScheduleEnable = scheduleService.canScheduleEnable as jest.Mock

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal scheduleInput AGENTFLOW flowData JSON */
const makeScheduleFlowData = (inputs: Record<string, unknown> = {}) =>
    JSON.stringify({
        nodes: [
            {
                id: 'start-0',
                data: {
                    name: 'startAgentflow',
                    inputs: {
                        startInputType: 'scheduleInput',
                        scheduleCronExpression: '* * * * *',
                        scheduleTimezone: 'UTC',
                        scheduleInputMode: 'text',
                        scheduleDefaultInput: 'hello',
                        ...inputs
                    }
                }
            }
        ],
        edges: []
    })

/** Build a non-schedule AGENTFLOW flowData JSON (chatInput start) */
const makeChatInputFlowData = () =>
    JSON.stringify({
        nodes: [{ id: 'start-0', data: { name: 'startAgentflow', inputs: { startInputType: 'chatInput' } } }],
        edges: []
    })

/** Build a plain (non-agentflow) flowData JSON */
const makePlainFlowData = () => JSON.stringify({ nodes: [], edges: [] })

const makeChatflow = (overrides: Record<string, unknown> = {}) => ({
    id: 'flow-1',
    type: EnumChatflowType.AGENTFLOW,
    flowData: makeScheduleFlowData(),
    workspaceId: 'ws-1',
    chatbotConfig: undefined,
    ...overrides
})

const SAVE_ARGS = {
    orgId: 'org-1',
    workspaceId: 'ws-1',
    subscriptionId: 'sub-1',
    usageCacheManager: {} as any
}

beforeEach(() => {
    jest.clearAllMocks()
    casExecute = null
    liveWriteHooks.beforeLiveWrite = null
    liveWriteHooks.beforeConditionalWrite = null
    mockRepo.findOneBy.mockReset()
    mockRepo.update.mockReset()
    mockAppServer.AppDataSource.getRepository.mockReturnValue(mockRepo)
    mockRepo.create.mockImplementation((x: unknown) => x)
    mockRepo.save.mockResolvedValue(makeChatflow())
    mockRepo.merge.mockImplementation((_existing: any, updates: any) => ({ ...makeChatflow(), ...updates }))
    mockContainsBase64File.mockReturnValue(false)
    mockCreateOrUpdateSchedule.mockResolvedValue({ id: 'sched-1', enabled: true })
    mockDeleteScheduleForTarget.mockResolvedValue(undefined)
    mockResolveScheduleCron.mockReturnValue({ valid: true, cronExpression: '* * * * *' })
    mockCanScheduleEnable.mockReturnValue(true)
    ;(ScheduleBeat.getInstance as jest.Mock).mockReturnValue({
        onScheduleChanged: jest.fn().mockResolvedValue(undefined)
    })
})

// ─── saveChatflow ─────────────────────────────────────────────────────────────

describe('saveChatflow', () => {
    it('saves and returns the chatflow', async () => {
        const newFlow = makeChatflow({ type: EnumChatflowType.AGENTFLOW })
        const saved = makeChatflow()
        mockRepo.save.mockResolvedValue(saved)

        const result = await chatflowsService.saveChatflow(
            newFlow as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockRepo.save).toHaveBeenCalled()
        expect(result).toBe(saved)
        expect(flowVersionsService.recordFlowVersion).toHaveBeenCalledWith(saved, {})
    })

    it('records the signed-in user as the author of a new flow', async () => {
        const newFlow = makeChatflow({ type: EnumChatflowType.AGENTFLOW })
        const saved = makeChatflow()
        mockRepo.save.mockResolvedValue(saved)
        await chatflowsService.saveChatflow(
            newFlow as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager,
            { id: 'user-1', name: 'Dana' }
        )
        expect(flowVersionsService.recordFlowVersion).toHaveBeenCalledWith(saved, { author: { id: 'user-1', name: 'Dana' } })
    })

    it('throws BAD_REQUEST for an invalid chatflow type', async () => {
        const badFlow = makeChatflow({ type: 'INVALID_TYPE' })

        await expect(
            chatflowsService.saveChatflow(
                badFlow as any,
                SAVE_ARGS.orgId,
                SAVE_ARGS.workspaceId,
                SAVE_ARGS.subscriptionId,
                SAVE_ARGS.usageCacheManager
            )
        ).rejects.toMatchObject({ statusCode: 400 })
    })

    // ── schedule sync (AGENTFLOW + scheduleInput) ────────────────────────────

    it('creates or updates the schedule when the start node is scheduleInput', async () => {
        const newFlow = makeChatflow()
        mockRepo.save.mockResolvedValue(makeChatflow({ flowData: makeScheduleFlowData() }))

        await chatflowsService.saveChatflow(
            newFlow as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockCreateOrUpdateSchedule).toHaveBeenCalledWith(
            expect.objectContaining({
                triggerType: ScheduleTriggerType.AGENTFLOW,
                targetId: 'flow-1',
                workspaceId: 'ws-1'
            })
        )
    })

    it('calls onScheduleChanged upsert when the schedule is enabled', async () => {
        mockRepo.save.mockResolvedValue(makeChatflow({ flowData: makeScheduleFlowData() }))
        mockCreateOrUpdateSchedule.mockResolvedValue({ id: 'sched-1', enabled: true })
        mockCanScheduleEnable.mockReturnValue(true)

        await chatflowsService.saveChatflow(
            makeChatflow() as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        const beat = ScheduleBeat.getInstance()
        expect(beat.onScheduleChanged).toHaveBeenCalledWith('sched-1', 'upsert')
    })

    it('does NOT call onScheduleChanged when the schedule is disabled', async () => {
        mockRepo.save.mockResolvedValue(makeChatflow({ flowData: makeScheduleFlowData() }))
        mockCreateOrUpdateSchedule.mockResolvedValue({ id: 'sched-1', enabled: false })
        mockCanScheduleEnable.mockReturnValue(false)

        await chatflowsService.saveChatflow(
            makeChatflow() as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        const beat = ScheduleBeat.getInstance()
        expect(beat.onScheduleChanged).not.toHaveBeenCalled()
    })

    it('passes scheduleEndDate as a Date when set in flowData', async () => {
        const futureDate = new Date(Date.now() + 86_400_000).toISOString()
        mockRepo.save.mockResolvedValue(makeChatflow({ flowData: makeScheduleFlowData({ scheduleEndDate: futureDate }) }))

        await chatflowsService.saveChatflow(
            makeChatflow() as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockCreateOrUpdateSchedule).toHaveBeenCalledWith(expect.objectContaining({ endDate: expect.any(Date) }))
    })

    it('passes undefined endDate when scheduleEndDate is not set', async () => {
        mockRepo.save.mockResolvedValue(makeChatflow({ flowData: makeScheduleFlowData() }))

        await chatflowsService.saveChatflow(
            makeChatflow() as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockCreateOrUpdateSchedule).toHaveBeenCalledWith(expect.objectContaining({ endDate: undefined }))
    })

    // ── schedule input mode ───────────────────────────────────────────────────

    it("defaults scheduleInputMode to 'text' and passes defaultInput when mode is not set", async () => {
        mockRepo.save.mockResolvedValue(makeChatflow({ flowData: makeScheduleFlowData() }))

        await chatflowsService.saveChatflow(
            makeChatflow() as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockCreateOrUpdateSchedule).toHaveBeenCalledWith(
            expect.objectContaining({ scheduleInputMode: 'text', defaultInput: 'hello', defaultForm: undefined })
        )
    })

    it("passes defaultForm (stringified) when scheduleInputMode is 'form'", async () => {
        mockRepo.save.mockResolvedValue(
            makeChatflow({
                flowData: makeScheduleFlowData({
                    scheduleInputMode: 'form',
                    scheduleFormDefaults: { team: 'eng', metric: 'p95' },
                    scheduleDefaultInput: ''
                })
            })
        )

        await chatflowsService.saveChatflow(
            makeChatflow() as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        const call = mockCreateOrUpdateSchedule.mock.calls[0][0]
        expect(call.scheduleInputMode).toBe('form')
        expect(call.defaultInput).toBe('') // cleared in form mode
        expect(JSON.parse(call.defaultForm)).toEqual({ team: 'eng', metric: 'p95' })
    })

    it("passes empty defaultInput and no defaultForm when scheduleInputMode is 'none'", async () => {
        mockRepo.save.mockResolvedValue(
            makeChatflow({ flowData: makeScheduleFlowData({ scheduleInputMode: 'none', scheduleDefaultInput: 'ignored' }) })
        )

        await chatflowsService.saveChatflow(
            makeChatflow() as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockCreateOrUpdateSchedule).toHaveBeenCalledWith(
            expect.objectContaining({ scheduleInputMode: 'none', defaultInput: '', defaultForm: undefined })
        )
    })

    it('does not create a schedule when the start node type is chatInput', async () => {
        mockRepo.save.mockResolvedValue(makeChatflow({ flowData: makeChatInputFlowData() }))

        await chatflowsService.saveChatflow(
            makeChatflow({ flowData: makeChatInputFlowData() }) as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockCreateOrUpdateSchedule).not.toHaveBeenCalled()
    })

    it('does not create a schedule for a non-AGENTFLOW type', async () => {
        const chatflow = makeChatflow({ type: EnumChatflowType.CHATFLOW, flowData: makePlainFlowData() })
        mockRepo.save.mockResolvedValue(chatflow)

        await chatflowsService.saveChatflow(
            chatflow as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockCreateOrUpdateSchedule).not.toHaveBeenCalled()
    })

    // ── telemetry ─────────────────────────────────────────────────────────────

    it('sends chatflow_created telemetry after saving', async () => {
        mockRepo.save.mockResolvedValue(makeChatflow({ flowData: makePlainFlowData() }))

        await chatflowsService.saveChatflow(
            makeChatflow({ type: EnumChatflowType.CHATFLOW, flowData: makePlainFlowData() }) as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockAppServer.telemetry.sendTelemetry).toHaveBeenCalledWith('chatflow_created', expect.any(Object), SAVE_ARGS.orgId)
    })
})

// ─── updateChatflow ───────────────────────────────────────────────────────────

describe('updateChatflow', () => {
    const existingFlow = makeChatflow()

    it('saves and returns the merged chatflow', async () => {
        const updates = makeChatflow({ flowData: makeScheduleFlowData() })
        const merged = { ...existingFlow, ...updates }
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)

        const result = await chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', 'ws-1', 'sub-1')

        expect(mockRepo.merge).toHaveBeenCalled()
        expect(mockRepo.save).toHaveBeenCalled()
        expect(result).toBe(merged)
        expect(flowVersionsService.recordFlowVersion).toHaveBeenCalledWith(merged, {})
    })

    it('writes Live when the flow requires a passing test set', async () => {
        const updates = makeChatflow({ flowData: makePlainFlowData() })
        const merged = { ...existingFlow, ...updates }
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)
        mockRepo.findOneBy.mockResolvedValue({
            chatflowId: existingFlow.id,
            publishGate: true,
            publishGateResult: null
        })
        const result = await chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', 'ws-1', 'sub-1')
        expect(result.flowData).toBe(updates.flowData)
        expect(mockRepo.save).toHaveBeenCalled()
    })

    it('passes a history label with this one save and hands back its record result', async () => {
        const updates = makeChatflow({ flowData: makeScheduleFlowData() })
        const merged = { ...existingFlow, ...updates }
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)
        ;(flowVersionsService.recordFlowVersion as jest.Mock).mockResolvedValueOnce('abc1234')
        let queued: Promise<string | null> | undefined
        await chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', 'ws-1', 'sub-1', {
            versionRecord: { kind: 'restore', title: 'Restored: Changed instructions (abcdef1)' },
            onVersionQueued: (result) => {
                queued = result
            }
        })
        expect(flowVersionsService.recordFlowVersion).toHaveBeenCalledWith(merged, {
            kind: 'restore',
            title: 'Restored: Changed instructions (abcdef1)'
        })
        expect(await queued).toBe('abc1234')
    })

    const DRAFT_CANVAS = JSON.stringify({ nodes: [{ id: 'llm_0', data: { name: 'chatOpenAI', inputs: {} } }], edges: [] })

    it('Publish saves only while Live is still the canvas it checked, then records the saved row', async () => {
        const updates = makeChatflow({ flowData: DRAFT_CANVAS })
        const merged = { ...existingFlow, ...updates }
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockClear()
        mockRepo.update.mockResolvedValueOnce({ affected: 1 })
        mockRepo.findOneBy.mockResolvedValueOnce({ ...existingFlow, flowData: 'LIVE BEFORE' })
        const result = await chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', 'ws-1', 'sub-1', {
            versionRecord: { kind: 'publish', titlePrefix: 'Published: ' },
            expectedFlowData: 'LIVE BEFORE'
        })
        expect(mockRepo.save).not.toHaveBeenCalled()
        // Only the canvas (and its time) is written, and only while Live is still the canvas and type Publish checked:
        // a type change landing meanwhile makes the write fail instead of publishing the draft under another type.
        const [where, patch] = mockRepo.update.mock.calls.slice(-1)[0]
        expect(where).toEqual({ id: existingFlow.id, workspaceId: 'ws-1', flowData: 'LIVE BEFORE', type: existingFlow.type })
        expect(Object.keys(patch).sort()).toEqual(['flowData', 'updatedDate'])
        expect(patch.flowData).toBe(DRAFT_CANVAS)
        // The result is what the write stored. The read before it only confirms the canvas that was checked.
        expect(result.flowData).toBe(DRAFT_CANVAS)
        expect(mockRepo.findOneBy).toHaveBeenCalledTimes(1)
        expect(result).toMatchObject({
            id: existingFlow.id,
            flowData: DRAFT_CANVAS,
            type: existingFlow.type,
            updatedDate: patch.updatedDate
        })
        expect(flowVersionsService.recordFlowVersion).toHaveBeenCalledWith(result, { kind: 'publish', titlePrefix: 'Published: ' })
        // Document store usage before the write, as on an ordinary save, so a later save's usage lands last;
        // history queued right after the write.
        const usageAt = (documentStoreService.updateDocumentStoreUsage as jest.Mock).mock.invocationCallOrder.slice(-1)[0]
        const writeAt = mockRepo.update.mock.invocationCallOrder.slice(-1)[0]
        const recordedAt = (flowVersionsService.recordFlowVersion as jest.Mock).mock.invocationCallOrder.slice(-1)[0]
        expect(usageAt).toBeLessThan(writeAt)
        expect(writeAt).toBeLessThan(recordedAt)
    })

    it('Publish is refused with 409, and records nothing, when Live moved while publishing', async () => {
        const updates = makeChatflow({ flowData: DRAFT_CANVAS })
        mockRepo.merge.mockReturnValue({ ...existingFlow, ...updates })
        mockRepo.update.mockResolvedValueOnce({ affected: 0 })
        // The canvas Publish checked, then Live as it is now, read back to put document store usage back.
        mockRepo.findOneBy
            .mockResolvedValueOnce({ ...existingFlow, flowData: 'LIVE BEFORE' })
            .mockResolvedValueOnce({ ...existingFlow, flowData: makeScheduleFlowData() })
        ;(flowVersionsService.recordFlowVersion as jest.Mock).mockClear()
        ;(documentStoreService.updateDocumentStoreUsage as jest.Mock).mockClear()
        await expect(
            chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', 'ws-1', 'sub-1', {
                expectedFlowData: 'LIVE BEFORE'
            })
        ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('nothing was published') })
        expect(flowVersionsService.recordFlowVersion).not.toHaveBeenCalled()
        // Usage was updated for the draft before the write (as on every save), then put back for the Live canvas.
        expect(documentStoreService.updateDocumentStoreUsage).toHaveBeenCalledTimes(2)
        expect(mockRepo.findOneBy).toHaveBeenLastCalledWith({ id: existingFlow.id, workspaceId: 'ws-1' })
    })

    it('changing the type while the flow has unpublished changes is refused, before anything is saved', async () => {
        mockRepo.save.mockClear()
        mockRepo.findOneBy.mockResolvedValueOnce({ chatflowId: existingFlow.id, draftFlowData: '{"nodes":[],"edges":[]}' })
        const updates = { ...makeChatflow(), type: 'CHATFLOW' }
        await expect(
            chatflowsService.updateChatflow({ ...existingFlow } as any, updates as any, 'org-1', 'ws-1', 'sub-1')
        ).rejects.toMatchObject({
            statusCode: 409,
            message: expect.stringContaining('unpublished changes')
        })
        expect(mockRepo.save).not.toHaveBeenCalled()
    })

    it('changing the type with no draft open goes ahead', async () => {
        const updates = { ...makeChatflow({ flowData: makeScheduleFlowData() }), type: 'CHATFLOW' }
        const merged = { ...existingFlow, ...updates }
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockClear()
        mockRepo.findOneBy.mockResolvedValue(null)
        let clause = ''
        casExecute = async (qb) => {
            clause = qb._wheres.map((where: { sql: string }) => where.sql).join('\n')
            return { affected: 1 }
        }
        const result = await chatflowsService.updateChatflow({ ...existingFlow } as any, updates as any, 'org-1', 'ws-1', 'sub-1')
        expect(mockRepo.save).not.toHaveBeenCalled()
        expect(clause).toContain('NOT EXISTS')
        expect(result).toMatchObject({ type: 'CHATFLOW', flowData: makeScheduleFlowData() })
    })

    it('a type change is checked against the stored type even though merge writes into the flow it is given', async () => {
        const current = { ...existingFlow, type: 'CHATFLOW', flowData: 'LIVE BEFORE' }
        const updates = { ...makeChatflow({ flowData: makeScheduleFlowData() }), type: 'AGENTFLOW' }
        // TypeORM's merge copies the update into the entity it is given and returns that same object.
        mockRepo.merge.mockImplementation((into: any, from: any) => Object.assign(into, from))
        mockRepo.findOneBy.mockResolvedValue(null)
        let wheres: { sql: string; params?: Record<string, unknown> }[] = []
        casExecute = async (qb) => {
            wheres = qb._wheres
            return { affected: 1 }
        }
        const result = await chatflowsService.updateChatflow(current as any, updates as any, 'org-1', 'ws-1', 'sub-1', {
            expectedFlowData: 'LIVE BEFORE'
        })
        expect(wheres.find((where) => where.params && 'expectedType' in where.params)?.params).toEqual({ expectedType: 'CHATFLOW' })
        expect(wheres.map((where) => where.sql).join('\n')).toContain('NOT EXISTS')
        expect(result).toMatchObject({ type: 'AGENTFLOW' })
    })

    it('a Live update landing after Publish checked the canvas is a conflict, and that update stays', async () => {
        const row = { ...existingFlow, flowData: 'LIVE BEFORE' }
        const updates = makeChatflow({ flowData: DRAFT_CANVAS })
        mockRepo.merge.mockReturnValue({ ...existingFlow, ...updates })
        mockRepo.findOneBy.mockImplementation(async (where: any) => {
            if (where?.chatflowId) return null
            if (where?.id) return { ...row }
            return null
        })
        mockRepo.update.mockImplementation(async (where: any, patch: any) => {
            if (where.flowData !== undefined && row.flowData !== where.flowData) return { affected: 0 }
            if (where.type !== undefined && row.type !== where.type) return { affected: 0 }
            Object.assign(row, patch)
            return { affected: 1 }
        })
        liveWriteHooks.beforeLiveWrite = async () => {
            row.flowData = 'CONCURRENT PUT'
        }
        ;(flowVersionsService.recordFlowVersion as jest.Mock).mockClear()
        await expect(
            chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', 'ws-1', 'sub-1', {
                versionRecord: { kind: 'publish', titlePrefix: 'Published: ' },
                expectedFlowData: 'LIVE BEFORE'
            })
        ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('nothing was published') })
        expect(row.flowData).toBe('CONCURRENT PUT')
        expect(flowVersionsService.recordFlowVersion).not.toHaveBeenCalled()
    })

    it('a draft saved after the type check still blocks the type change, and the old type stays', async () => {
        const row = { ...existingFlow }
        let draft: { draftFlowData?: string | null } | null = null
        mockRepo.findOneBy.mockImplementation(async (where: any) => (where?.chatflowId ? draft : { ...row }))
        mockRepo.save.mockClear()
        casExecute = async (qb) => {
            const sql = qb._wheres.map((where: { sql: string }) => where.sql).join('\n')
            const params = Object.assign({}, ...qb._wheres.map((where: { params?: any }) => where.params || {}))
            if (sql.includes('NOT EXISTS') && draft?.draftFlowData) return { affected: 0 }
            if (params.expectedType !== undefined && row.type !== params.expectedType) return { affected: 0 }
            Object.assign(row, qb._set)
            return { affected: 1 }
        }
        liveWriteHooks.beforeConditionalWrite = async () => {
            draft = { draftFlowData: '{"nodes":[],"edges":[]}' }
        }
        await expect(
            chatflowsService.updateChatflow(
                { ...existingFlow } as any,
                { ...makeChatflow(), type: 'CHATFLOW' } as any,
                'org-1',
                'ws-1',
                'sub-1'
            )
        ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('unpublished changes') })
        expect(row.type).toBe(existingFlow.type)
        expect(mockRepo.save).not.toHaveBeenCalled()
    })

    it('a Live update landing after Roll back read the canvas is a conflict, and that update stays', async () => {
        const row = { ...existingFlow, flowData: 'LIVE BEFORE' }
        const versionCanvas = makePlainFlowData()
        mockRepo.merge.mockReturnValue({ ...existingFlow, flowData: versionCanvas, name: 'Rolled back' })
        mockRepo.findOneBy.mockImplementation(async () => ({ ...row }))
        casExecute = async (qb) => {
            const params = Object.assign({}, ...qb._wheres.map((where: { params?: any }) => where.params || {}))
            if (params.expectedFlowData !== undefined && row.flowData !== params.expectedFlowData) return { affected: 0 }
            if (params.expectedType !== undefined && row.type !== params.expectedType) return { affected: 0 }
            Object.assign(row, qb._set)
            return { affected: 1 }
        }
        liveWriteHooks.beforeConditionalWrite = async () => {
            row.flowData = 'CONCURRENT PUT'
        }
        await expect(
            chatflowsService.updateChatflow(
                existingFlow as any,
                makeChatflow({ flowData: versionCanvas, name: 'Rolled back' }) as any,
                'org-1',
                'ws-1',
                'sub-1',
                {
                    versionRecord: { kind: 'rollback', title: 'Rolled back Live to: Old (abcdef1)' },
                    expectedFlowData: 'LIVE BEFORE'
                }
            )
        ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('nothing was changed') })
        expect(row.flowData).toBe('CONCURRENT PUT')
        expect(flowVersionsService.recordFlowVersion).not.toHaveBeenCalled()
    })

    it('records the signed-in user with the save, next to a history label', async () => {
        const updates = makeChatflow({ flowData: makeScheduleFlowData() })
        const merged = { ...existingFlow, ...updates }
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)
        await chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', 'ws-1', 'sub-1', {
            versionRecord: { kind: 'restore', title: 'Restored: Changed instructions (abcdef1)' },
            actor: { id: 'user-1', name: 'Dana' }
        })
        expect(flowVersionsService.recordFlowVersion).toHaveBeenCalledWith(merged, {
            kind: 'restore',
            title: 'Restored: Changed instructions (abcdef1)',
            author: { id: 'user-1', name: 'Dana' }
        })
    })

    it('does not record a version when the save fails', async () => {
        mockRepo.save.mockRejectedValue(new Error('db down'))
        await expect(
            chatflowsService.updateChatflow(existingFlow as any, makeChatflow() as any, 'org-1', 'ws-1', 'sub-1')
        ).rejects.toThrow()
        expect(flowVersionsService.recordFlowVersion).not.toHaveBeenCalled()
    })

    it('throws BAD_REQUEST when updateChatFlow.type is invalid', async () => {
        const updates = makeChatflow({ type: 'BAD_TYPE' })

        await expect(chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', 'ws-1', 'sub-1')).rejects.toMatchObject({
            statusCode: 400
        })
    })

    it('preserves existing type when updateChatFlow.type is not provided', async () => {
        const updates = { flowData: makeScheduleFlowData() } // no type field
        const merged = { ...existingFlow, flowData: makeScheduleFlowData() }
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)

        await chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', 'ws-1', 'sub-1')

        // Type should have been copied from existing flow
        expect(updates).toMatchObject({ type: existingFlow.type })
    })

    it('throws BAD_REQUEST when chatbotConfig is invalid JSON', async () => {
        const updates = makeChatflow({ chatbotConfig: 'not-json' })

        await expect(chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', 'ws-1', 'sub-1')).rejects.toMatchObject({
            statusCode: 400
        })
    })

    // ── schedule sync — scheduleInput branch ─────────────────────────────────

    it('creates or updates the schedule when start node is scheduleInput', async () => {
        const updates = makeChatflow({ flowData: makeScheduleFlowData() })
        const merged = { ...existingFlow, flowData: makeScheduleFlowData(), type: EnumChatflowType.AGENTFLOW }
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)

        await chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', 'ws-1', 'sub-1')

        expect(mockCreateOrUpdateSchedule).toHaveBeenCalledWith(
            expect.objectContaining({ triggerType: ScheduleTriggerType.AGENTFLOW, targetId: 'flow-1', workspaceId: 'ws-1' })
        )
    })

    it('calls onScheduleChanged upsert when the updated schedule is enabled', async () => {
        const merged = makeChatflow({ flowData: makeScheduleFlowData() })
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)
        mockCreateOrUpdateSchedule.mockResolvedValue({ id: 'sched-1', enabled: true })

        await chatflowsService.updateChatflow(existingFlow as any, makeChatflow() as any, 'org-1', 'ws-1', 'sub-1')

        const beat = ScheduleBeat.getInstance()
        expect(beat.onScheduleChanged).toHaveBeenCalledWith('sched-1', 'upsert')
    })

    it('calls onScheduleChanged delete when the updated schedule is disabled', async () => {
        const merged = makeChatflow({ flowData: makeScheduleFlowData() })
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)
        mockCreateOrUpdateSchedule.mockResolvedValue({ id: 'sched-1', enabled: false })
        mockCanScheduleEnable.mockReturnValue(false)

        await chatflowsService.updateChatflow(existingFlow as any, makeChatflow() as any, 'org-1', 'ws-1', 'sub-1')

        const beat = ScheduleBeat.getInstance()
        expect(beat.onScheduleChanged).toHaveBeenCalledWith('sched-1', 'delete')
    })

    it('sets enabled=false in createOrUpdateSchedule when canScheduleEnable returns false', async () => {
        const merged = makeChatflow({ flowData: makeScheduleFlowData() })
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)
        mockCanScheduleEnable.mockReturnValue(false)
        mockCreateOrUpdateSchedule.mockResolvedValue({ id: 'sched-1', enabled: false })

        await chatflowsService.updateChatflow(existingFlow as any, makeChatflow() as any, 'org-1', 'ws-1', 'sub-1')

        expect(mockCreateOrUpdateSchedule).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
    })

    it('passes undefined enabled in createOrUpdateSchedule when canScheduleEnable returns true (preserve existing)', async () => {
        const merged = makeChatflow({ flowData: makeScheduleFlowData() })
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)
        mockCanScheduleEnable.mockReturnValue(true)
        mockCreateOrUpdateSchedule.mockResolvedValue({ id: 'sched-1', enabled: true })

        await chatflowsService.updateChatflow(existingFlow as any, makeChatflow() as any, 'org-1', 'ws-1', 'sub-1')

        expect(mockCreateOrUpdateSchedule).toHaveBeenCalledWith(expect.objectContaining({ enabled: undefined }))
    })

    // ── schedule sync — non-scheduleInput branch ──────────────────────────────

    it('deletes existing schedule when start node switches away from scheduleInput', async () => {
        const merged = makeChatflow({ flowData: makeChatInputFlowData() })
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)

        await chatflowsService.updateChatflow(
            existingFlow as any,
            makeChatflow({ flowData: makeChatInputFlowData() }) as any,
            'org-1',
            'ws-1',
            'sub-1'
        )

        expect(mockDeleteScheduleForTarget).toHaveBeenCalledWith('flow-1', ScheduleTriggerType.AGENTFLOW, 'ws-1')
    })

    it('calls onScheduleChanged delete after deleting the existing schedule record', async () => {
        const merged = makeChatflow({ flowData: makeChatInputFlowData() })
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)
        mockDeleteScheduleForTarget.mockResolvedValue({ id: 'sched-old' })

        await chatflowsService.updateChatflow(
            existingFlow as any,
            makeChatflow({ flowData: makeChatInputFlowData() }) as any,
            'org-1',
            'ws-1',
            'sub-1'
        )

        const beat = ScheduleBeat.getInstance()
        expect(beat.onScheduleChanged).toHaveBeenCalledWith('sched-old', 'delete')
    })

    it('does not call onScheduleChanged when no existing schedule was found', async () => {
        const merged = makeChatflow({ flowData: makeChatInputFlowData() })
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)
        mockDeleteScheduleForTarget.mockResolvedValue(undefined)

        await chatflowsService.updateChatflow(
            existingFlow as any,
            makeChatflow({ flowData: makeChatInputFlowData() }) as any,
            'org-1',
            'ws-1',
            'sub-1'
        )

        const beat = ScheduleBeat.getInstance()
        expect(beat.onScheduleChanged).not.toHaveBeenCalled()
    })

    it('does not touch schedules for a non-AGENTFLOW type', async () => {
        const nonAgentFlow = makeChatflow({ type: EnumChatflowType.CHATFLOW, flowData: makePlainFlowData() })
        mockRepo.merge.mockReturnValue(nonAgentFlow)
        mockRepo.save.mockResolvedValue(nonAgentFlow)

        await chatflowsService.updateChatflow(existingFlow as any, nonAgentFlow as any, 'org-1', 'ws-1', 'sub-1')

        expect(mockCreateOrUpdateSchedule).not.toHaveBeenCalled()
        expect(mockDeleteScheduleForTarget).not.toHaveBeenCalled()
    })
})

const secretGraph = JSON.stringify({
    nodes: [
        {
            id: 'start-0',
            data: {
                name: 'startAgentflow',
                credential: 'cred-secret',
                inputs: {
                    startInputType: 'formInput',
                    formTitle: 'Contact',
                    formDescription: 'Hi',
                    formInputTypes: [{ name: 'email', type: 'string', label: 'Email' }],
                    startState: [{ key: 'apiKey', value: 'sk-live' }],
                    webhookURL: 'https://internal.example/hook'
                }
            }
        },
        {
            id: 'llm-1',
            data: {
                name: 'chatOpenAI',
                credential: 'cred-openai',
                inputs: { systemMessage: 'SECRET-PROMPT-CANARY' }
            }
        }
    ],
    edges: [{ id: 'e1', source: 'start-0', target: 'llm-1' }]
})

describe('getSinglePublicChatbotConfig', () => {
    const savedConfig = JSON.stringify({
        title: 'Bot',
        titleAvatarSrc: 'https://img.example/a.png',
        welcomeMessage: 'Hello',
        starterPrompts: { 0: { prompt: 'What is new?' }, 1: { prompt: 'use sk-FAKE-START-1 please' } },
        botMessage: { showAvatar: true, avatarSrc: 'https://img.example/b.png', backgroundColor: '#fff', extra: 'x' },
        textInput: { placeholder: 'Ask', sendButtonColor: '#123456' },
        chatFeedback: { status: true },
        allowedOrigins: ['https://ok.example'],
        overrideConfig: { openAIApiKey: 'sk-FAKE-OVERRIDE-1' },
        leads: { status: true, email: 'owner@example.com' },
        flowData: 'x'
    })

    it.each([
        ['private', { isPublic: false, apikeyid: '' }],
        ['key-protected', { apikeyid: 'apikey-1' }],
        ['public', { isPublic: true, apikeyid: '' }]
    ])('returns only display fields for a %s chatflow, never flowData', async (_label, extra) => {
        mockRepo.findOneBy.mockResolvedValue({
            id: 'flow-1',
            chatbotConfig: savedConfig,
            flowData: secretGraph,
            textToSpeech: null,
            ...extra
        })

        const result = await chatflowsService.getSinglePublicChatbotConfig('flow-1')
        const serialized = JSON.stringify(result)

        expect(Object.keys(result).sort()).toEqual(
            [
                'botMessage',
                'chatFeedback',
                'isTTSEnabled',
                'starterPrompts',
                'textInput',
                'title',
                'titleAvatarSrc',
                'uploads',
                'welcomeMessage'
            ].sort()
        )
        expect(result).not.toHaveProperty('flowData')
        expect(result.title).toBe('Bot')
        expect(result.botMessage).toEqual({ showAvatar: true, avatarSrc: 'https://img.example/b.png', backgroundColor: '#fff' })
        expect(result.starterPrompts).toEqual({ 0: { prompt: 'What is new?' }, 1: {} })
        for (const leak of ['SECRET-PROMPT-CANARY', 'cred-openai', 'sk-', 'allowedOrigins', 'overrideConfig', 'owner@example.com']) {
            expect(serialized).not.toContain(leak)
        }
    })

    it('answers 404 for a missing chatflow', async () => {
        mockRepo.findOneBy.mockResolvedValue(null)
        await expect(chatflowsService.getSinglePublicChatbotConfig('nope')).rejects.toMatchObject({ statusCode: 404 })
    })
})

describe('getChatflowByApiKey', () => {
    const calls: { method: string; args: unknown[] }[] = []
    const chain: Record<string, jest.Mock> = {}
    for (const method of ['select', 'where', 'andWhere', 'orWhere', 'orderBy']) {
        chain[method] = jest.fn((...args: unknown[]) => {
            calls.push({ method, args })
            return chain
        })
    }
    chain.getMany = jest.fn()

    const canvas = '{"nodes":[{"data":{"inputs":{"systemMessage":"SECRET-CANVAS"}}}]}'

    beforeEach(() => {
        calls.length = 0
        mockRepo.createQueryBuilder.mockReturnValue(chain)
        chain.getMany.mockReset()
        for (const method of ['select', 'where', 'andWhere', 'orWhere', 'orderBy']) chain[method].mockClear()
    })

    it('returns only flows bound to that key, without flowData or other config', async () => {
        chain.getMany.mockResolvedValue([
            {
                id: 'bound-1',
                name: 'Bound',
                deployed: true,
                category: 'support',
                type: 'CHATFLOW',
                apikeyid: 'key-1',
                workspaceId: 'ws-1',
                flowData: canvas,
                chatbotConfig: '{"title":"hidden-config"}',
                apiConfig: '{"override":true}',
                analytic: 'secret-analytic',
                speechToText: 'stt-config',
                followUpPrompts: 'follow-ups',
                mcpServerConfig: 'mcp-config'
            },
            {
                id: 'keyless-1',
                name: 'Keyless',
                deployed: true,
                category: 'open',
                type: 'CHATFLOW',
                apikeyid: null,
                workspaceId: 'ws-1',
                flowData: '{"nodes":[{"data":{"inputs":{"systemMessage":"KEYLESS-CANVAS"}}}]}'
            },
            {
                id: 'keyless-empty',
                name: 'Keyless empty',
                deployed: false,
                category: null,
                type: 'CHATFLOW',
                apikeyid: '',
                workspaceId: 'ws-1',
                flowData: 'KEYLESS-EMPTY-CANVAS'
            },
            {
                id: 'other-key',
                name: 'Other key',
                deployed: true,
                category: 'other',
                type: 'AGENTFLOW',
                apikeyid: 'key-2',
                workspaceId: 'ws-1',
                flowData: 'OTHER-KEY-CANVAS'
            },
            {
                id: 'other-ws',
                name: 'Other workspace',
                deployed: true,
                category: 'elsewhere',
                type: 'CHATFLOW',
                apikeyid: 'key-1',
                workspaceId: 'ws-2',
                flowData: 'OTHER-WORKSPACE-CANVAS'
            }
        ])

        const result = await chatflowsService.getChatflowByApiKey('key-1', 'ws-1')
        const serialized = JSON.stringify(result)

        expect(result).toEqual([{ id: 'bound-1', name: 'Bound', deployed: true, category: 'support', type: 'CHATFLOW' }])
        expect(serialized).not.toContain('flowData')
        expect(serialized).not.toContain('SECRET-CANVAS')
        expect(serialized).not.toContain('KEYLESS-CANVAS')
        expect(serialized).not.toContain('KEYLESS-EMPTY-CANVAS')
        expect(serialized).not.toContain('OTHER-KEY-CANVAS')
        expect(serialized).not.toContain('OTHER-WORKSPACE-CANVAS')
        expect(serialized).not.toContain('hidden-config')
        expect(serialized).not.toContain('secret-analytic')
        expect(serialized).not.toContain('chatbotConfig')
        expect(serialized).not.toContain('apiConfig')
        expect(serialized).not.toContain('keyless-1')
        expect(serialized).not.toContain('other-key')
        expect(serialized).not.toContain('other-ws')
        expect(Object.keys(result[0]).sort()).toEqual(['category', 'deployed', 'id', 'name', 'type'])

        const sql = JSON.stringify(calls)
        expect(sql).toContain('cf.workspaceId = :workspaceId')
        expect(sql).toContain('cf.apikeyid = :apikeyid')
        expect(sql).not.toContain('IS NULL')
        expect(sql).not.toContain('apikeyid = \\"\\"')
        expect(calls.some((call) => call.method === 'orWhere')).toBe(false)
        expect(calls.some((call) => call.method === 'select' && JSON.stringify(call.args).includes('cf.flowData'))).toBe(false)
        const whereParams = calls.filter((call) => call.method === 'where' || call.method === 'andWhere').map((call) => call.args[1])
        expect(whereParams).toEqual(expect.arrayContaining([{ workspaceId: 'ws-1' }, { apikeyid: 'key-1' }]))
    })

    it('is 404 when the key has no bound flow', async () => {
        chain.getMany.mockResolvedValue([])
        await expect(chatflowsService.getChatflowByApiKey('key-1', 'ws-1')).rejects.toMatchObject({ statusCode: 404 })
    })

    it('is 401 when the key id or workspace is missing', async () => {
        await expect(chatflowsService.getChatflowByApiKey('', 'ws-1')).rejects.toMatchObject({ statusCode: 401 })
        await expect(chatflowsService.getChatflowByApiKey('key-1', '')).rejects.toMatchObject({ statusCode: 401 })
        expect(chain.getMany).not.toHaveBeenCalled()
    })
})

// ─── deleteChatflow ───────────────────────────────────────────────────────────

describe('deleteChatflow', () => {
    type Call = { inTransaction: boolean; entity: string; where: unknown }

    /** Records every repository delete with the entity name and whether it ran inside the transaction. */
    const trackDeletes = (failOn?: string) => {
        const calls: Call[] = []
        const repoFor = (inTransaction: boolean) => (entity: { name: string }) => ({
            ...mockRepo,
            delete: jest.fn(async (where: unknown) => {
                calls.push({ inTransaction, entity: entity.name, where })
                if (inTransaction && entity.name === failOn) throw new Error(`${failOn} delete failed`)
                return { affected: 1, raw: [] }
            })
        })
        mockAppServer.AppDataSource.getRepository.mockImplementation(repoFor(false) as any)
        mockAppServer.AppDataSource.transaction.mockImplementationOnce(async (fn: (manager: any) => Promise<unknown>) =>
            fn({ getRepository: repoFor(true) })
        )
        return calls
    }

    beforeEach(() => {
        mockRepo.findOne.mockResolvedValue(makeChatflow({ type: EnumChatflowType.CHATFLOW }))
    })

    afterEach(() => {
        mockAppServer.AppDataSource.getRepository.mockReset()
        mockAppServer.AppDataSource.getRepository.mockReturnValue(mockRepo)
    })

    it("deletes the flow's leads in the same transaction as the flow", async () => {
        const calls = trackDeletes()

        await chatflowsService.deleteChatflow('flow-1', 'org-1', 'ws-1', [EnumChatflowType.CHATFLOW])

        const inTransaction = calls.filter((c) => c.inTransaction)
        expect(inTransaction).toEqual(
            expect.arrayContaining([
                { inTransaction: true, entity: 'Lead', where: { chatflowid: 'flow-1' } },
                { inTransaction: true, entity: 'ChatMessage', where: { chatflowid: 'flow-1' } },
                { inTransaction: true, entity: 'ChatMessageFeedback', where: { chatflowid: 'flow-1' } },
                { inTransaction: true, entity: 'UpsertHistory', where: { chatflowid: 'flow-1' } },
                { inTransaction: true, entity: 'ChatFlow', where: { id: 'flow-1' } }
            ])
        )
        // Nothing that holds a flow's rows is deleted outside the transaction.
        expect(calls.filter((c) => !c.inTransaction && ['Lead', 'ChatMessage', 'ChatFlow'].includes(c.entity))).toEqual([])
        expect(mockAppServer.AppDataSource.transaction).toHaveBeenCalledTimes(1)
    })

    it('rolls back the whole delete when the lead delete fails', async () => {
        const calls = trackDeletes('Lead')

        await expect(chatflowsService.deleteChatflow('flow-1', 'org-1', 'ws-1', [EnumChatflowType.CHATFLOW])).rejects.toThrow(
            /Lead delete failed/
        )

        // The flow delete never ran, and nothing after the transaction (history, uploads) happened.
        expect(calls.some((c) => c.entity === 'ChatFlow')).toBe(false)
        expect(flowVersionsService.recordFlowDeletion).not.toHaveBeenCalled()
        expect(removeFolderFromStorage).not.toHaveBeenCalled()
        expect(documentStoreService.updateDocumentStoreUsage).not.toHaveBeenCalled()
    })

    it('rolls back when the flow delete itself fails, leaving the leads in place', async () => {
        trackDeletes('ChatFlow')

        await expect(chatflowsService.deleteChatflow('flow-1', 'org-1', 'ws-1', [EnumChatflowType.CHATFLOW])).rejects.toThrow(
            /ChatFlow delete failed/
        )
        expect(flowVersionsService.recordFlowDeletion).not.toHaveBeenCalled()
        expect(removeFolderFromStorage).not.toHaveBeenCalled()
    })

    it('does not start the transaction for a flow type the caller may not delete', async () => {
        const calls = trackDeletes()

        await expect(chatflowsService.deleteChatflow('flow-1', 'org-1', 'ws-1', [EnumChatflowType.AGENTFLOW])).rejects.toThrow()
        expect(calls).toEqual([])
    })
})

// ─── Harnesses a canvas names, on every save path ─────────────────────────────

describe('harnesses a saved canvas names', () => {
    const agentTool = (name: string) =>
        JSON.stringify({
            nodes: [
                {
                    id: 'agent-0',
                    data: {
                        name: 'agentAgentflow',
                        inputs: { agentTools: [{ agentSelectedTool: 'harness', agentSelectedToolConfig: { harnessName: name } }] }
                    }
                }
            ],
            edges: []
        })
    const keyCaller = { via: 'api_key' as const, apiKeyId: 'key-1', harnesses: ['bakery'] }
    let assertNameAvailable: jest.SpyInstance

    beforeEach(() => {
        assertNameAvailable = jest.spyOn(harnessesService, 'assertNameAvailable').mockResolvedValue(undefined)
    })
    afterEach(() => assertNameAvailable.mockRestore())

    it('collects a nested Agent harness tool and checks it against the key list and the team', async () => {
        await expect(validateReferencedHarnesses({ flowData: agentTool('payroll'), workspaceId: 'ws-1' }, keyCaller)).rejects.toMatchObject(
            {
                statusCode: 403
            }
        )
        await expect(validateReferencedHarnesses({ flowData: agentTool('payroll'), workspaceId: 'ws-1' }, undefined)).rejects.toMatchObject(
            {
                statusCode: 403
            }
        )
        await validateReferencedHarnesses({ flowData: agentTool('bakery'), workspaceId: 'ws-1' }, keyCaller)
        await validateReferencedHarnesses({ flowData: agentTool('payroll'), workspaceId: 'ws-1' }, { via: 'session' })
        expect(assertNameAvailable.mock.calls).toEqual([
            ['bakery', 'ws-1'],
            ['payroll', 'ws-1']
        ])
    })

    it('reads a harness name whose key is written with a JSON escape, on the reference check and on create', async () => {
        const escaped = agentTool('payroll').replace('"harnessName"', '"harness\\u004eame"')
        expect(escaped.includes('"harnessName"')).toBe(false)
        await expect(validateReferencedHarnesses({ flowData: escaped, workspaceId: 'ws-1' }, keyCaller)).rejects.toMatchObject({
            statusCode: 403
        })
        await expect(
            chatflowsService.saveChatflow(makeChatflow({ flowData: escaped }) as any, 'org-1', 'ws-1', 'sub-1', {} as any, undefined, {
                caller: keyCaller
            })
        ).rejects.toMatchObject({ statusCode: 403 })
        await validateReferencedHarnesses({ flowData: escaped, workspaceId: 'ws-1' }, { via: 'session' })
        expect(assertNameAvailable.mock.calls).toEqual([['payroll', 'ws-1']])
    })

    it('refuses a harness name that is a list or an object on every save, for a person and a key', async () => {
        const listed = agentTool('payroll').replace('"harnessName":"payroll"', '"harnessName":["payroll"]')
        const card = JSON.stringify({ nodes: [{ id: 'h', data: { name: 'harness', inputs: { harnessName: ['payroll'] } } }], edges: [] })
        expect(listed.includes('["payroll"]')).toBe(true)
        for (const flowData of [listed, card]) {
            for (const caller of [{ via: 'session' as const }, keyCaller]) {
                await expect(validateReferencedHarnesses({ flowData, workspaceId: 'ws-1' }, caller)).rejects.toMatchObject({
                    statusCode: 400
                })
            }
            await expect(
                chatflowsService.saveChatflow(makeChatflow({ flowData }) as any, 'org-1', 'ws-1', 'sub-1', {} as any, undefined, {
                    caller: { via: 'session' }
                })
            ).rejects.toMatchObject({ statusCode: 400 })
        }
        expect(assertNameAvailable).not.toHaveBeenCalled()
    })

    it('refuses an import or a Publish, Roll back, or Restore that writes a canvas naming a harness off the key list', async () => {
        const existingFlow = makeChatflow({ flowData: makePlainFlowData() })
        await expect(
            chatflowsService.saveChatflow(
                makeChatflow({ flowData: agentTool('payroll') }) as any,
                'org-1',
                'ws-1',
                'sub-1',
                {} as any,
                undefined,
                {
                    caller: keyCaller
                }
            )
        ).rejects.toMatchObject({ statusCode: 403 })
        await expect(
            chatflowsService.updateChatflow(
                { ...existingFlow } as any,
                { flowData: agentTool('payroll') } as any,
                'org-1',
                'ws-1',
                'sub-1',
                { caller: keyCaller, expectedFlowData: existingFlow.flowData, versionRecord: { kind: 'publish' } }
            )
        ).rejects.toMatchObject({ statusCode: 403 })
        expect(mockRepo.save).not.toHaveBeenCalled()
        expect(mockRepo.update).not.toHaveBeenCalled()
    })

    it('checks the stored canvas when a key unbinds the flow, and leaves an unrelated field alone', async () => {
        const stored = makeChatflow({ flowData: agentTool('payroll'), apikeyid: 'key-x' })
        mockRepo.merge.mockImplementation((existing: any, updates: any) => ({ ...existing, ...updates }))
        await expect(
            chatflowsService.updateChatflow({ ...stored } as any, { apikeyid: null } as any, 'org-1', 'ws-1', 'sub-1', {
                caller: keyCaller
            })
        ).rejects.toMatchObject({ statusCode: 403 })
        mockRepo.save.mockResolvedValue({ ...stored, category: 'x' })
        await chatflowsService.updateChatflow({ ...stored } as any, { category: 'x' } as any, 'org-1', 'ws-1', 'sub-1', {
            caller: keyCaller
        })
        expect(mockRepo.save).toHaveBeenCalledTimes(1)
    })

    it('refuses a HARNESS canvas whose name is off the key list before any row is written', async () => {
        await expect(
            chatflowsService.saveChatflow(
                makeChatflow({ type: 'HARNESS', name: 'payroll', flowData: makePlainFlowData() }) as any,
                'org-1',
                'ws-1',
                'sub-1',
                {} as any,
                undefined,
                { caller: keyCaller }
            )
        ).rejects.toMatchObject({ statusCode: 403 })
        expect(mockRepo.save).not.toHaveBeenCalled()
    })
})

describe('getAllChatflows for an API key', () => {
    function listChain() {
        const wheres: Array<[string, unknown?]> = []
        const chain: any = {
            orderBy: () => chain,
            skip: () => chain,
            take: () => chain,
            andWhere: (sql: string, params?: unknown) => {
                wheres.push(params === undefined ? [sql] : [sql, params])
                return chain
            },
            getManyAndCount: async () => [[], 0]
        }
        mockRepo.createQueryBuilder.mockReturnValue(chain)
        return wheres
    }

    it('leaves HARNESS rows off the key list out of the rows and the total, and a person sees every row', async () => {
        let wheres = listChain()
        await chatflowsService.getAllChatflows(undefined, 'ws-1', 1, 10, ['bakery'])
        expect(wheres).toContainEqual([
            "(chat_flow.type IS NULL OR chat_flow.type != 'HARNESS' OR chat_flow.name IN (:...harnessScope))",
            { harnessScope: ['bakery'] }
        ])
        wheres = listChain()
        await chatflowsService.getAllChatflows(undefined, 'ws-1', 1, 10, [])
        expect(wheres).toContainEqual(["(chat_flow.type IS NULL OR chat_flow.type != 'HARNESS')"])
        wheres = listChain()
        await chatflowsService.getAllChatflows(undefined, 'ws-1')
        expect(wheres.some(([sql]) => sql.includes('HARNESS'))).toBe(false)
    })
})
