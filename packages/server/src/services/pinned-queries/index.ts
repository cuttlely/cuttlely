import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { Request } from 'express'
import { hasAnyPermission } from '../../identity/rbac'
import {
    CALLER_URL_MESSAGE,
    functionLines,
    NormalizedEntry,
    PinnedRequestError,
    BODY_KEYS,
    SUGGEST_KEYS,
    assertExactKeys,
    columnProbeSql,
    findPostgresNode,
    flowNodes,
    normalizeEntry,
    optionalPositive,
    pinnedQueriesEnabled,
    plainGuard,
    relationNames,
    sampleArgs,
    savedPins,
    sameSpec,
    scanParamNames,
    statementLimit,
    successGuard,
    uncastCompiled,
    updatePermissionFor
} from './sql'

const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>

export interface CompiledPin {
    runText: string
    checkText: string
    binds: unknown[] | null
    order: string[]
    statementHash: string
}

// Matches recordPinnedQueryTest. Values stay out: names only, and cred is the id.
export interface PinnedTestEvent {
    organizationId: string
    workspaceId?: string | null
    userId?: string | null
    flow: string
    node: string
    pin: string
    version?: number | string | null
    hash?: string | null
    cred?: string | null
    paramNames?: string[] | null
}

export interface PinnedDeps {
    pinnedQueriesEnabled: (env?: NodeJS.ProcessEnv) => boolean
    hasAnyPermission: (req: Request, permission: string) => Promise<boolean>
    getChatflowByIdForWorkspace: (chatflowId: string, workspaceId: string) => Promise<any>
    flowDataForTestChat: (flow: any) => Promise<string>
    loadCredentialUrl: (credentialId: string, workspaceId: string) => Promise<string>
    resolveAnalystConnection: (input: { credentialUrl?: string; analystUrl?: string; env?: NodeJS.ProcessEnv }) => {
        kind: string
        postgresUrl?: string
    }
    analystCallLimits: (
        requested: { rowCap?: number; statementTimeoutMs?: number },
        env?: NodeJS.ProcessEnv
    ) => { rowCap: number; timeoutMs: number }
    compilePinned: (entry: unknown, args?: unknown) => CompiledPin
    validateArgs: (entry: unknown, args: unknown) => unknown[]
    stampPayload: (fields: {
        workspaceId: string
        cred: string
        statementHash: string
        params: unknown
        tables: string[]
        functions: string[]
        testedColumns: { name: string; type: string }[]
    }) => string
    computeStamp: (key: Buffer, payload: string) => string
    pinnedToolDefinition: (entry: unknown) => { name: string; description: string; inputSchema: unknown }
    getPinnedQueryKey: () => Promise<Buffer>
    queryAnalystUrl: (postgresUrl: string, input: Record<string, unknown>, options: Record<string, unknown>) => Promise<unknown>
    recordTest: (event: PinnedTestEvent) => Promise<void>
}

let overrides: Partial<PinnedDeps> = {}

let runtimeModules: Promise<any> | null = null

export function setPinnedQueryDeps(next: Partial<PinnedDeps> | null): void {
    overrides = next || {}
    if (!next) runtimeModules = null
}

function runtimeFile(fileName: string): string {
    let dir = __dirname
    for (let i = 0; i < 8; i += 1) {
        const packaged = path.join(dir, 'packages', 'harness', 'runtime', fileName)
        if (fs.existsSync(packaged)) return packaged
        const near = path.join(dir, 'harness', 'runtime', fileName)
        if (fs.existsSync(near)) return near
        dir = path.dirname(dir)
    }
    throw new PinnedRequestError(500, 'Pinned queries could not load the query runner.')
}

async function loadRuntime(): Promise<any> {
    const pinned = await importEsm(pathToFileURL(runtimeFile('pinned-query.mjs')).href)
    const store = await importEsm(pathToFileURL(runtimeFile('analyst-store.mjs')).href)
    const postgres = await importEsm(pathToFileURL(runtimeFile('analyst-postgres.mjs')).href)
    return { pinned, store, postgres }
}

async function defaultLoadCredentialUrl(credentialId: string, workspaceId: string): Promise<string> {
    const { getCredentialData } = await import('@cuttlely/components')
    const { getRunningExpressApp } = await import('../../utils/getRunningExpressApp')
    const { databaseEntities } = await import('../../utils')
    const appServer = getRunningExpressApp()
    const data = await getCredentialData(credentialId, {
        appDataSource: appServer.AppDataSource,
        databaseEntities,
        workspaceId
    })
    return typeof data?.postgresUrl === 'string' ? data.postgresUrl : ''
}

async function defaultGetPinnedQueryKey(): Promise<Buffer> {
    const { getPinnedQueryKey } = await import('@cuttlely/components')
    if (typeof getPinnedQueryKey !== 'function') {
        throw new PinnedRequestError(500, 'Pinned queries could not stamp this test.')
    }
    return getPinnedQueryKey()
}

async function defaultRecordTest(event: PinnedTestEvent): Promise<void> {
    try {
        const mod = await import('../chatflows/pinnedQueryAudit')
        const fn = (mod as { recordPinnedQueryTest?: (event: PinnedTestEvent) => Promise<void> }).recordPinnedQueryTest
        if (typeof fn === 'function') await fn(event)
    } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (message.includes('Cannot find module') || message.includes('pinnedQueryAudit')) return
        // A missed audit line must not hide a test that already ran.
    }
}

function deps(): PinnedDeps {
    const base: PinnedDeps = {
        pinnedQueriesEnabled,
        hasAnyPermission: (req, permission) => hasAnyPermission(req, permission),
        // Loaded when a request uses the real services. A static import pulls in the server entry.
        getChatflowByIdForWorkspace: async (id, workspaceId) => {
            const { default: chatflowsService } = await import('../chatflows')
            return chatflowsService.getChatflowByIdForWorkspace(id, workspaceId)
        },
        flowDataForTestChat: async (flow) => {
            const { default: flowDraftsService } = await import('../flow-drafts')
            return flowDraftsService.flowDataForTestChat(flow)
        },
        loadCredentialUrl: defaultLoadCredentialUrl,
        resolveAnalystConnection: () => {
            throw new PinnedRequestError(500, 'Pinned queries could not resolve the saved connection.')
        },
        analystCallLimits: () => ({ rowCap: 100, timeoutMs: 15000 }),
        compilePinned: () => {
            throw new PinnedRequestError(500, 'Pinned queries could not compile this statement.')
        },
        validateArgs: () => {
            throw new PinnedRequestError(500, 'Pinned queries could not check the sample values.')
        },
        stampPayload: () => {
            throw new PinnedRequestError(500, 'Pinned queries could not stamp this test.')
        },
        computeStamp: () => {
            throw new PinnedRequestError(500, 'Pinned queries could not stamp this test.')
        },
        pinnedToolDefinition: () => {
            throw new PinnedRequestError(500, 'Pinned queries could not describe the tool.')
        },
        getPinnedQueryKey: defaultGetPinnedQueryKey,
        queryAnalystUrl: () => {
            throw new PinnedRequestError(500, 'Pinned queries could not load the query runner.')
        },
        recordTest: defaultRecordTest
    }
    return { ...base, ...overrides }
}

async function ensureRuntime(target: PinnedDeps): Promise<void> {
    if (overrides.compilePinned && overrides.queryAnalystUrl && overrides.resolveAnalystConnection && overrides.analystCallLimits) return
    if (!runtimeModules) {
        runtimeModules = loadRuntime().catch((error) => {
            runtimeModules = null
            throw error
        })
    }
    const { pinned, store, postgres } = await runtimeModules
    if (!overrides.compilePinned) target.compilePinned = pinned.compilePinned
    if (!overrides.validateArgs) target.validateArgs = pinned.validateArgs
    if (!overrides.stampPayload) target.stampPayload = pinned.stampPayload
    if (!overrides.computeStamp) target.computeStamp = pinned.computeStamp
    if (!overrides.pinnedToolDefinition) target.pinnedToolDefinition = pinned.pinnedToolDefinition
    if (!overrides.queryAnalystUrl) target.queryAnalystUrl = store.queryAnalystUrl
    if (!overrides.resolveAnalystConnection) target.resolveAnalystConnection = postgres.resolveAnalystConnection
    if (!overrides.analystCallLimits) target.analystCallLimits = store.analystCallLimits
}

function refuseIfOff(env: NodeJS.ProcessEnv, enabled: PinnedDeps['pinnedQueriesEnabled']): void {
    if (!enabled(env)) throw new PinnedRequestError(404, 'Pinned queries are off on this server.')
}

async function savedNode(req: Request, used: PinnedDeps): Promise<{ flow: any; node: any; workspaceId: string }> {
    const workspaceId = typeof req.user?.activeWorkspaceId === 'string' ? req.user.activeWorkspaceId : ''
    if (!workspaceId) throw new PinnedRequestError(404, 'Workspace not found.')
    const chatflowId = String(req.params.chatflowId || '')
    const flow = await used.getChatflowByIdForWorkspace(chatflowId, workspaceId)
    const allowed = await used.hasAnyPermission(req, updatePermissionFor(flow?.type))
    if (!allowed) throw new PinnedRequestError(403, 'You do not have permission to change this type of flow.')
    const canvas = await used.flowDataForTestChat(flow)
    const nodeId = String((req.body || {}).nodeId || '')
    if (!nodeId) throw new PinnedRequestError(400, 'Choose the PostgreSQL MCP node to test.')
    const node = findPostgresNode(flowNodes(canvas), nodeId)
    if (!node || node?.data?.name !== 'postgreSQLMCP') {
        throw new PinnedRequestError(400, 'Pinned queries run on a PostgreSQL MCP node in this flow.')
    }
    return { flow, node, workspaceId }
}

async function connectionFor(node: any, workspaceId: string, used: PinnedDeps): Promise<{ postgresUrl: string; credentialId: string }> {
    const credentialId = String(node?.data?.credential || '')
    let credentialUrl = ''
    if (credentialId) {
        try {
            credentialUrl = await used.loadCredentialUrl(credentialId, workspaceId)
        } catch (error) {
            throw new PinnedRequestError(400, plainGuard(error) || 'The saved credential could not be read.')
        }
    }
    let decision: { kind: string; postgresUrl?: string }
    try {
        decision = used.resolveAnalystConnection({
            credentialUrl,
            analystUrl: process.env.CUTTLELY_POSTGRES_URL,
            env: process.env
        })
    } catch (error) {
        throw new PinnedRequestError(400, plainGuard(error))
    }
    if (decision.kind !== 'url' || !decision.postgresUrl) {
        throw new PinnedRequestError(
            400,
            'Pinned queries need the Postgres URL saved on the node. Isolated analyst storage cannot run them.'
        )
    }
    return { postgresUrl: decision.postgresUrl, credentialId }
}

function guardOptions(node: any, entry: NormalizedEntry | null, used: PinnedDeps) {
    const inputs = (node?.data?.inputs || {}) as Record<string, unknown>
    const relations = relationNames(inputs.analystRelations)
    const functions = functionLines(inputs.analystAllowedFunctions)
    const nodeCap = optionalPositive(inputs.analystRowCap)
    const seconds = optionalPositive(inputs.analystTimeoutSeconds)
    const queryCap = entry?.rowCap
    const requestedCap = queryCap ? (nodeCap ? Math.min(queryCap, nodeCap) : queryCap) : nodeCap
    const limits = used.analystCallLimits(
        { rowCap: requestedCap, statementTimeoutMs: seconds === undefined ? undefined : seconds * 1000 },
        process.env
    )
    return { inputs, relations, functions, limits, storedCap: entry?.rowCap ? Math.min(entry.rowCap, limits.rowCap) : undefined }
}

function rowsOf(value: unknown): { rows: Record<string, unknown>[]; truncated: boolean; total: number | null } {
    let parsed = value
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value)
        } catch {
            parsed = {}
        }
    }
    const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    const rows = Array.isArray(record.rows) ? (record.rows as Record<string, unknown>[]) : []
    const total = typeof record.total === 'number' ? record.total : null
    return { rows, truncated: Boolean(record.truncated), total }
}

function refuseRunner(error: unknown): never {
    if (error instanceof PinnedRequestError) throw error
    throw new PinnedRequestError(400, plainGuard(error))
}

export async function suggestPinnedTypes(req: Request): Promise<{ params: { name: string; type: string | null }[] }> {
    const used = deps()
    await ensureRuntime(used)
    refuseIfOff(process.env, used.pinnedQueriesEnabled)
    const body = req.body || {}
    assertExactKeys(body, SUGGEST_KEYS)
    const sql = typeof body.sql === 'string' ? body.sql : ''
    if (!sql.trim()) throw new PinnedRequestError(400, 'Write the SQL to test.')
    const names = scanParamNames(sql)
    const { node, workspaceId } = await savedNode(req, used)
    const { postgresUrl } = await connectionFor(node, workspaceId, used)
    const { relations, functions, limits } = guardOptions(node, null, used)
    let compiled: CompiledPin
    try {
        compiled = used.compilePinned({
            sql,
            params: names.map((name) => ({ name, type: 'text', required: true }))
        })
    } catch (error) {
        refuseRunner(error)
    }
    const order = compiled!.order.length ? compiled!.order : names
    if (!order.length) return { params: [] }
    // The statement keeps the temporary text casts. suggestParamTypes strips those
    // spans itself and requires the uncast text to match, so $10 is not eaten by $1.
    const suggestion = uncastCompiled(compiled!.runText, order)
    let types: Array<string | null>
    try {
        const result = await used.queryAnalystUrl(
            postgresUrl,
            { sql: compiled!.runText },
            {
                readOnlySql: true,
                relations,
                allowedFunctions: functions.join('\n'),
                checkText: suggestion.check,
                suggestTypesSql: suggestion.uncast,
                binds: [],
                rowCap: limits.rowCap,
                statementTimeoutMs: limits.timeoutMs
            }
        )
        const list = result && typeof result === 'object' ? (result as { paramTypes?: unknown }).paramTypes : undefined
        types = Array.isArray(list) ? list.map((type) => (typeof type === 'string' && type ? type : null)) : order.map(() => null)
    } catch {
        types = order.map(() => null)
    }
    if (types.length < order.length) types = order.map((_name, index) => types[index] ?? null)
    return { params: order.map((name, index) => ({ name, type: types[index] ?? null })) }
}

export async function testPinnedQuery(req: Request): Promise<Record<string, unknown>> {
    const used = deps()
    await ensureRuntime(used)
    refuseIfOff(process.env, used.pinnedQueriesEnabled)
    const body = req.body || {}
    assertExactKeys(body, BODY_KEYS, CALLER_URL_MESSAGE)
    const entry = normalizeEntry(body.entry)
    const args = sampleArgs(body.sampleValues)
    const { flow, node, workspaceId } = await savedNode(req, used)
    const inputs = (node?.data?.inputs || {}) as Record<string, unknown>
    const clash = savedPins(inputs).find((pin) => pin && pin.name === entry.name && pin.id !== entry.id)
    if (clash) throw new PinnedRequestError(400, `Another pinned query on this node is already named ${entry.name}.`)
    const { postgresUrl, credentialId } = await connectionFor(node, workspaceId, used)
    const guard = guardOptions(node, entry, used)
    let compiled: CompiledPin
    let binds: unknown[]
    try {
        compiled = used.compilePinned(entry, args)
        binds = Array.isArray(compiled.binds) ? compiled.binds : used.validateArgs(entry, args)
    } catch (error) {
        refuseRunner(error)
    }
    const saved = savedPins(inputs).find((pin) => pin && pin.id === entry.id)
    const version = saved ? (sameSpec(saved, entry) ? Number(saved.version) || 1 : (Number(saved.version) || 1) + 1) : entry.version
    const runOptions = {
        readOnlySql: true,
        relations: guard.relations,
        allowedFunctions: guard.functions.join('\n'),
        binds,
        checkText: compiled!.checkText,
        rowCap: guard.limits.rowCap,
        statementTimeoutMs: guard.limits.timeoutMs,
        pinned: { id: entry.id, version, statementHash: compiled!.statementHash, tool: entry.name }
    }
    const started = Date.now()
    let raw: unknown
    try {
        raw = await used.queryAnalystUrl(postgresUrl, { sql: compiled!.runText }, runOptions)
    } catch (error) {
        refuseRunner(error)
    }
    const timeMs = Date.now() - started
    const shaped = rowsOf(raw)
    const names = shaped.rows[0] ? Object.keys(shaped.rows[0]) : []
    let columns = names.map((name) => ({ name, type: '' }))
    if (names.length) {
        try {
            const probeSql = columnProbeSql(compiled!.runText, names)
            const probeCheck = columnProbeSql(compiled!.checkText, names)
            const probed = rowsOf(
                await used.queryAnalystUrl(postgresUrl, { sql: probeSql }, { ...runOptions, checkText: probeCheck, pinned: undefined })
            )
            const first = probed.rows[0] || {}
            columns = names.map((name) => ({ name, type: typeof first[name] === 'string' ? first[name] : '' }))
        } catch {
            columns = names.map((name) => ({ name, type: '' }))
        }
    }
    const testedColumns = columns.filter((column) => column.name && column.type)
    const payload = used.stampPayload({
        workspaceId,
        cred: credentialId,
        statementHash: compiled!.statementHash,
        params: entry.params,
        tables: guard.relations,
        functions: guard.functions,
        testedColumns
    })
    const stamp = used.computeStamp(await used.getPinnedQueryKey(), payload)
    const limit = statementLimit(compiled!.runText)
    const possiblyTruncated = limit != null && shaped.rows.length === limit
    const testedAt = new Date().toISOString()
    const testedBy = typeof req.user?.id === 'string' ? req.user.id : ''
    const stored: Record<string, unknown> = {
        id: entry.id,
        name: entry.name,
        purpose: entry.purpose,
        description: entry.description,
        sql: entry.sql,
        params: entry.params,
        version,
        testedStamp: stamp,
        testedAt,
        testedBy,
        testedColumns,
        needsRetest: false
    }
    if (guard.storedCap) stored.rowCap = guard.storedCap
    let tool = { name: entry.name, description: entry.description || entry.purpose, inputSchema: { type: 'object', properties: {} } }
    try {
        tool = used.pinnedToolDefinition(stored)
    } catch {
        // The stamp is the part the agent run checks. The preview can fall back to the purpose.
    }
    try {
        const organizationId = typeof req.user?.activeOrganizationId === 'string' ? req.user.activeOrganizationId : ''
        await used.recordTest({
            organizationId,
            workspaceId,
            userId: testedBy,
            flow: String(flow.id),
            node: String(node.id || node.data?.id || ''),
            pin: entry.name,
            version,
            hash: compiled!.statementHash,
            cred: credentialId,
            paramNames: entry.params.map((param) => param.name)
        })
    } catch {
        // Audit failure stays off the builder's result.
    }
    const words = successGuard({ relations: guard.relations, functions: guard.functions })
    if (possiblyTruncated) words.push('The row count equals the statement LIMIT, so the result is possibly truncated.')
    else if (shaped.truncated) words.push('The row cap stopped the result before the statement LIMIT.')
    if (!names.length) words.push('The test returned no rows, so column names and types were not stamped.')
    else if (!testedColumns.length) words.push('Column types could not be read, so they were not stamped.')
    return {
        ok: true,
        timeMs,
        rowCount: shaped.rows.length,
        total: shaped.total,
        possiblyTruncated,
        truncated: shaped.truncated,
        columns,
        rows: shaped.rows.slice(0, guard.limits.rowCap),
        guard: words,
        tool,
        statementHash: compiled!.statementHash,
        entry: stored
    }
}

export { PinnedRequestError }
