/**
 * Pinned query audit: create, edit, and delete on a live save, a test event,
 * and no audit when a draft is saved. No database.
 */

import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'

const audits: Array<{
    type: string
    organizationId: string
    workspaceId: string | null
    userId: string | null
    actorId: string | null
    summary: string
    detail: Record<string, unknown>
}> = []

const mockRepo = {
    findOneBy: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((row: unknown) => row),
    save: jest.fn(async (row: unknown) => row),
    delete: jest.fn(),
    merge: jest.fn((existing: Record<string, unknown>, updates: Record<string, unknown>) => Object.assign(existing, updates)),
    update: jest.fn(async () => ({ affected: 1 })),
    countBy: jest.fn(),
    createQueryBuilder: jest.fn()
}

const mockAppServer = {
    AppDataSource: {
        getRepository: jest.fn().mockReturnValue(mockRepo),
        transaction: jest.fn(async (fn: (manager: { getRepository: () => typeof mockRepo }) => Promise<unknown>) =>
            fn({ getRepository: () => mockRepo })
        ),
        driver: { escape: (name: string) => `"${name}"` },
        options: {},
        getMetadata: () => ({ tableName: 'flow_version_state' })
    },
    telemetry: { sendTelemetry: jest.fn().mockResolvedValue(undefined) },
    identityManager: { getProductIdFromSubscription: jest.fn().mockResolvedValue('prod-1') },
    metricsProvider: { incrementCounter: jest.fn() },
    usageCacheManager: {}
}

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
jest.mock('../../errors/utils', () => ({ getErrorMessage: (error: unknown) => String(error) }))
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
    sanitizeAllowedUploadMimeTypesFromConfig: jest.fn((value: string) => value)
}))
jest.mock('../../utils/fileRepository', () => ({
    containsBase64File: jest.fn().mockReturnValue(false),
    updateFlowDataWithFilePaths: jest.fn(async (_id: string, flowData: string) => flowData)
}))
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
    ScheduleBeat: { getInstance: jest.fn().mockReturnValue({ onScheduleChanged: jest.fn().mockResolvedValue(undefined) }) }
}))
jest.mock('@cuttlely/components', () => ({ removeFolderFromStorage: jest.fn().mockResolvedValue({ totalSize: 0 }) }), { virtual: true })
jest.mock('uuid', () => ({ validate: jest.fn().mockReturnValue(true) }))
jest.mock('../flow-versions', () => ({
    __esModule: true,
    default: { recordFlowVersion: jest.fn().mockResolvedValue(null), recordFlowDeletion: jest.fn().mockResolvedValue(null) }
}))
jest.mock('http-status-codes', () => ({
    StatusCodes: { OK: 200, BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, INTERNAL_SERVER_ERROR: 500 }
}))
jest.mock('../../identity/production', () => ({
    applicationSql: () => ({ type: 'sqlite', query: async () => [] })
}))
jest.mock('../../identity/auditLog', () => {
    const actual = jest.requireActual('../../identity/auditLog')
    return {
        ...actual,
        safeRecordAudit: async (_sql: unknown, event: (typeof audits)[number]) => {
            audits.push(event)
        }
    }
})

import chatflowsService from './index'
import { saveDraft } from '../flow-drafts'
import { AUDIT_TYPES, redactAudit } from '../../identity/auditLog'
import {
    auditPinnedQuerySave,
    diffPinnedQueries,
    pinnedAuditDetail,
    recordPinnedQueryTest,
    setPinnedQueryHashForTests
} from './pinnedQueryAudit'

const SQL = "SELECT region, sum(amount) AS revenue FROM demo_sales WHERE region = 'ZZ-TEST-LITERAL' AND month = :month LIMIT 100"
const DEFAULT_VALUE = 'ZZ-TEST-DEFAULT'
const ALLOWED_VALUE = 'ZZ-TEST-ALLOWED'
const SAMPLE_VALUE = 'ZZ-TEST-SAMPLE'
const PURPOSE = 'ZZ-TEST-PURPOSE revenue by region'
const USER_NAME = 'ZZ-TEST-DISPLAY-NAME'
const FLOW = 'ZZ-TEST-FLOW'
const ORG = 'ZZ-TEST-ORG'
const WS = 'ZZ-TEST-WS'
const USER = 'ZZ-TEST-USER'
const CRED = 'ZZ-TEST-CRED'
const NODE = 'ZZ-TEST-NODE'
const NODE_B = 'ZZ-TEST-NODE-B'

const FORBIDDEN_KEY =
    /password|token|secret|question|authorization|cookie|credential|query|api[-_]?key|setupcode|bearer|user-?agent|identifier|email|(^|[_.-])ip($|[_.-])/i

function pin(overrides: Record<string, unknown> = {}) {
    return {
        id: 'ZZ-TEST-PIN',
        name: 'pq_revenue_by_region',
        purpose: PURPOSE,
        description: 'Made-up demo_sales revenue',
        sql: SQL,
        params: [
            {
                name: 'month',
                type: 'date',
                required: true,
                default: DEFAULT_VALUE,
                allowedValues: [ALLOWED_VALUE],
                min: '2020-01-01',
                max: '2030-01-01',
                secure: false
            }
        ],
        version: 3,
        testedStamp: 'abc',
        sampleValues: { month: SAMPLE_VALUE },
        ...overrides
    }
}

function canvas(pins: unknown[], nodeId = NODE, extraNodes: unknown[] = []) {
    return JSON.stringify({
        nodes: [
            {
                id: nodeId,
                data: {
                    name: 'postgreSQLMCP',
                    credential: CRED,
                    inputs: { mcpActions: '["query"]', pinnedQueries: JSON.stringify(pins) }
                }
            },
            ...extraNodes
        ],
        edges: []
    })
}

function flow(flowData: string, overrides: Record<string, unknown> = {}) {
    return {
        id: FLOW,
        type: 'CHATFLOW',
        name: 'ZZ-TEST-CANVAS',
        flowData,
        workspaceId: WS,
        ...overrides
    }
}

function hashOf(entry: unknown): string {
    return createHash('sha256')
        .update('pin:' + String((entry as { sql?: string })?.sql || ''))
        .digest('hex')
}

function assertNoValues(serialized: string) {
    for (const secret of [SQL, DEFAULT_VALUE, ALLOWED_VALUE, SAMPLE_VALUE, PURPOSE, USER_NAME, 'ZZ-TEST-LITERAL']) {
        expect(serialized).not.toContain(secret)
    }
}

function assertKeysAllowed(value: unknown): void {
    if (Array.isArray(value)) {
        for (const item of value) assertKeysAllowed(item)
        return
    }
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        expect(key).not.toMatch(FORBIDDEN_KEY)
        assertKeysAllowed(item)
    }
}

beforeEach(() => {
    audits.length = 0
    jest.clearAllMocks()
    mockAppServer.AppDataSource.getRepository.mockReturnValue(mockRepo)
    mockRepo.create.mockImplementation((row: unknown) => row)
    mockRepo.save.mockImplementation(async (row: unknown) => row)
    mockRepo.merge.mockImplementation((existing: Record<string, unknown>, updates: Record<string, unknown>) =>
        Object.assign(existing, updates)
    )
    mockRepo.findOneBy.mockResolvedValue(null)
    mockRepo.update.mockResolvedValue({ affected: 1 })
    setPinnedQueryHashForTests(hashOf)
})

afterEach(() => {
    setPinnedQueryHashForTests(null)
})

describe('ZZ-TEST-pinned query diff', () => {
    it('ZZ-TEST-reports create, edit, and delete, and ignores sample fields and order', () => {
        const before = canvas([
            pin(),
            pin({ id: 'ZZ-TEST-PIN-2', name: 'pq_top_products', version: 1, sql: 'SELECT product FROM demo_sales LIMIT 20' })
        ])
        const edited = pin({ sql: SQL.replace('LIMIT 100', 'LIMIT 50'), version: 4 })
        const added = pin({ id: 'ZZ-TEST-PIN-3', name: 'pq_units_by_region', version: 1 })
        const after = canvas([added, edited])
        const changes = diffPinnedQueries(before, after, FLOW)
        expect(changes.map((change) => `${change.kind}:${change.pin}`).sort()).toEqual([
            'create:pq_units_by_region',
            'delete:pq_top_products',
            'edit:pq_revenue_by_region'
        ])
        const same = diffPinnedQueries(
            canvas([pin(), pin({ id: 'ZZ-TEST-PIN-2', name: 'pq_top_products' })]),
            canvas([pin({ id: 'ZZ-TEST-PIN-2', name: 'pq_top_products' }), pin()]),
            FLOW
        )
        expect(same).toEqual([])
        const samples = diffPinnedQueries(canvas([pin()]), canvas([pin({ sampleValues: { month: 'other' } })]), FLOW)
        expect(samples).toEqual([])
    })

    it('ZZ-TEST-diffs every node and treats a move as a delete plus a create', () => {
        const other = {
            id: NODE_B,
            data: {
                name: 'postgreSQLMCP',
                credential: CRED,
                inputs: { pinnedQueries: [pin({ id: 'ZZ-TEST-PIN-B', name: 'pq_units_by_region' })] }
            }
        }
        const before = canvas([pin()], NODE, [other])
        const moved = canvas([], NODE, [
            {
                ...other,
                data: {
                    ...other.data,
                    inputs: { pinnedQueries: [pin(), pin({ id: 'ZZ-TEST-PIN-B', name: 'pq_units_by_region' })] }
                }
            }
        ])
        const changes = diffPinnedQueries(before, moved, FLOW)
        expect(changes.map((change) => `${change.kind}:${change.node}:${change.pin}`).sort()).toEqual([
            `create:${NODE_B}:pq_revenue_by_region`,
            `delete:${NODE}:pq_revenue_by_region`
        ])
    })
})

describe('ZZ-TEST-pinned query audit rows', () => {
    it('ZZ-TEST-keeps secure values out of save and test audit rows', async () => {
        const secureValue = 'ZZ-TEST-SECURE-VALUE'
        const entry = pin({
            params: [{ name: 'month', type: 'date', secure: true, default: secureValue, allowedValues: [secureValue] }],
            sampleValues: { month: secureValue }
        })
        await auditPinnedQuerySave({
            flowId: FLOW,
            organizationId: ORG,
            workspaceId: WS,
            actor: { id: USER },
            previousFlowData: canvas([]),
            nextFlowData: canvas([entry])
        })
        await recordPinnedQueryTest({
            organizationId: ORG,
            flow: FLOW,
            node: NODE,
            pin: entry.name,
            paramNames: ['month'],
            ...({ params: entry.params, values: { month: secureValue }, sql: SQL } as object)
        })
        expect(audits).toHaveLength(2)
        expect(JSON.stringify(audits)).not.toContain(secureValue)
        assertNoValues(JSON.stringify(audits))
        for (const event of audits) {
            expect(Object.keys(event.detail).sort()).toEqual(
                (event.detail.kind === 'create'
                    ? ['kind', 'flow', 'node', 'pin', 'version', 'hash', 'cred', 'paramNames', 'user']
                    : ['kind', 'flow', 'node', 'pin', 'paramNames']
                ).sort()
            )
        }
    })

    it('ZZ-TEST-records a test without values, and drops a hash that is not a statement hash', async () => {
        await recordPinnedQueryTest({
            organizationId: ORG,
            workspaceId: WS,
            userId: USER,
            flow: FLOW,
            node: NODE,
            pin: 'pq_revenue_by_region',
            version: 3,
            hash: hashOf({ sql: SQL }),
            cred: CRED,
            paramNames: ['month'],
            // The route may have these on the object it already holds. They must not be copied.
            ...({
                sql: SQL,
                purpose: PURPOSE,
                params: [{ name: 'month', default: DEFAULT_VALUE, allowedValues: [ALLOWED_VALUE] }],
                sampleValues: { month: SAMPLE_VALUE },
                name: USER_NAME
            } as object)
        })
        await recordPinnedQueryTest({
            organizationId: ORG,
            workspaceId: WS,
            userId: USER,
            flow: FLOW,
            node: NODE,
            pin: 'pq_top_products',
            version: 1,
            hash: SQL,
            cred: CRED,
            paramNames: ['month', 'n']
        })
        expect(audits).toHaveLength(2)
        expect(audits[0].type).toBe('pinned_query_change')
        expect(audits[0].userId).toBe(USER)
        expect(audits[0].actorId).toBe(USER)
        expect(audits[0].detail).toEqual({
            kind: 'test',
            flow: FLOW,
            node: NODE,
            pin: 'pq_revenue_by_region',
            version: 3,
            hash: hashOf({ sql: SQL }),
            cred: CRED,
            paramNames: ['month'],
            user: USER
        })
        expect(audits[1].detail.hash).toBeUndefined()
        const serialized = JSON.stringify(audits)
        assertNoValues(serialized)
        assertKeysAllowed(audits[0].detail)
        const redacted = redactAudit({ type: 'pinned_query_change', summary: audits[0].summary, detail: audits[0].detail })
        expect(redacted.detail).toEqual(audits[0].detail)
    })

    it('ZZ-TEST-writes create, edit, and delete from the two live save paths and skips an unchanged save', async () => {
        const created = flow(canvas([pin(), pin({ id: 'ZZ-TEST-PIN-2', name: 'pq_top_products', version: 1 })]))
        await chatflowsService.saveChatflow(created as any, ORG, WS, 'sub', {} as any, { id: USER, name: USER_NAME })
        expect(audits.map((event) => event.detail.kind).sort()).toEqual(['create', 'create'])
        expect(audits.every((event) => event.userId === USER && event.actorId === USER && event.workspaceId === WS)).toBe(true)
        expect(audits.every((event) => event.detail.cred === CRED && event.detail.flow === FLOW)).toBe(true)
        assertNoValues(JSON.stringify(audits))
        for (const event of audits) {
            assertKeysAllowed(event.detail)
            expect(redactAudit({ type: 'pinned_query_change', summary: event.summary, detail: event.detail }).detail).toEqual(event.detail)
        }

        audits.length = 0
        const existing = flow(canvas([pin(), pin({ id: 'ZZ-TEST-PIN-2', name: 'pq_top_products', version: 1 })]))
        const next = flow(
            canvas([
                pin({ sql: SQL.replace('LIMIT 100', 'LIMIT 50'), version: 4 }),
                pin({ id: 'ZZ-TEST-PIN-3', name: 'pq_units_by_region', version: 1 })
            ])
        )
        await chatflowsService.updateChatflow(existing as any, next as any, ORG, WS, 'sub', { actor: { id: USER, name: USER_NAME } })
        expect(audits.map((event) => `${event.detail.kind}:${event.detail.pin}`).sort()).toEqual([
            'create:pq_units_by_region',
            'delete:pq_top_products',
            'edit:pq_revenue_by_region'
        ])
        const edited = audits.find((event) => event.detail.kind === 'edit')
        expect(edited?.detail.hash).toBe(hashOf({ sql: SQL.replace('LIMIT 100', 'LIMIT 50') }))
        expect(edited?.detail.paramNames).toEqual(['month'])
        expect(edited?.detail.version).toBe(4)
        expect(edited?.userId).toBe(USER)
        assertNoValues(JSON.stringify(audits))

        audits.length = 0
        const steady = flow(canvas([pin()]))
        await chatflowsService.updateChatflow(flow(canvas([pin()])) as any, { name: 'ZZ-TEST-RETITLED-CANVAS' } as any, ORG, WS, 'sub', {
            actor: { id: USER }
        })
        await auditPinnedQuerySave({
            flowId: FLOW,
            organizationId: ORG,
            workspaceId: WS,
            actor: { id: USER },
            previousFlowData: steady.flowData,
            nextFlowData: steady.flowData
        })
        expect(audits).toEqual([])
    })

    it('ZZ-TEST-still records the change when the statement hash cannot be computed', async () => {
        setPinnedQueryHashForTests(() => {
            throw new Error(SQL)
        })
        await auditPinnedQuerySave({
            flowId: FLOW,
            organizationId: ORG,
            workspaceId: WS,
            actor: { id: USER, name: USER_NAME },
            previousFlowData: canvas([]),
            nextFlowData: canvas([pin()])
        })
        expect(audits).toHaveLength(1)
        expect(audits[0].detail.kind).toBe('create')
        expect(audits[0].detail.hash).toBeUndefined()
        assertNoValues(JSON.stringify(audits))
        expect(pinnedAuditDetail({ kind: 'create', flow: FLOW, node: NODE, pin: 'pq_revenue_by_region', hash: SQL }).hash).toBeUndefined()
    })

    it('ZZ-TEST-does not audit a draft save that adds a pin', async () => {
        const live = canvas([])
        const draft = canvas([pin()])
        mockRepo.findOneBy.mockImplementation(async (where: { id?: string }) =>
            where?.id === FLOW ? { id: FLOW, type: 'CHATFLOW', flowData: live, workspaceId: WS } : null
        )
        const status = await saveDraft(flow(live) as any, draft, { orgId: ORG, subscriptionId: 'sub', userId: USER })
        expect(status.draft).not.toBeNull()
        expect(audits).toEqual([])
        expect(JSON.stringify(mockRepo.save.mock.calls)).toContain('pq_revenue_by_region')
        assertNoValues(JSON.stringify(audits))
    })
})

describe('ZZ-TEST-pinned_query_change is a listed audit type', () => {
    it('ZZ-TEST-fits the type column and is on the audit screen', () => {
        expect(AUDIT_TYPES).toContain('pinned_query_change')
        expect('pinned_query_change'.length).toBeLessThanOrEqual(32)
        const ui = fs.readFileSync(path.resolve(__dirname, '../../../../ui/src/views/audit/query.js'), 'utf8')
        expect(ui).toContain("value: 'pinned_query_change'")
        expect(ui).toContain("label: 'Pinned query change'")
    })
})
