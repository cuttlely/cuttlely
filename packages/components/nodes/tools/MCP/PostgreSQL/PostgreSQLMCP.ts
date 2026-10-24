import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { tool, Tool } from '@langchain/core/tools'
import { ICommonObject, INode, INodeData, INodeOptionsValue, INodeParams } from '../../../../src/Interface'
import { getCredentialData, getCredentialParam } from '../../../../src/utils'

// tsc rewrites import() into require(), which cannot load the ESM analyst modules.
type AnalystConnection = { kind: 'url'; postgresUrl: string } | { kind: 'auto' }

type AnalystPostgresModule = {
    resolveAnalystConnection: (input: { credentialUrl?: unknown; analystUrl?: string; env?: NodeJS.ProcessEnv }) => AnalystConnection
}

type AnalystStoreModule = {
    ensureAnalystStore: (env?: NodeJS.ProcessEnv, options?: { workspace?: string }) => Promise<{ engine?: string }>
    queryAnalyst: (
        sql: string | Record<string, unknown>,
        options?: { env?: NodeJS.ProcessEnv; workspace?: string; rowCap?: number; statementTimeoutMs?: number }
    ) => Promise<unknown>
    analystSqlText: (input: unknown) => string
    analystToolSpec: (engine?: string, rowCap?: number) => { description: string; schema: Record<string, unknown> }
    analystCallLimits: (
        requested?: { rowCap?: number; statementTimeoutMs?: number },
        env?: NodeJS.ProcessEnv
    ) => { rowCap: number; timeoutMs: number }
    queryAnalystUrl: (
        postgresUrl: string,
        input: Record<string, unknown>,
        options?: { rowCap?: number; statementTimeoutMs?: number; relations?: string[]; readOnlySql?: boolean }
    ) => Promise<unknown>
    analystUrlToolSpec: (rowCap?: number, relations?: AnalystRelation[] | null) => { description: string; schema: Record<string, unknown> }
    analystDescribeToolSpec: () => { description: string; schema: Record<string, unknown> }
    listAnalystUrlRelations: (postgresUrl: string, options?: { timeoutMs?: number }) => Promise<AnalystRelation[]>
    analystUrlRelations: (postgresUrl: string, names: string[], options?: { timeoutMs?: number }) => Promise<AnalystRelation[]>
    describeAnalystUrlRelation: (
        postgresUrl: string,
        input: Record<string, unknown>,
        names: string[],
        options?: { timeoutMs?: number }
    ) => Promise<unknown>
}

type AnalystRelation = { name: string; kind: string; columns: number; comment: string }

type AnalystRelationsModule = {
    parseRelationSelection: (value: unknown) => string[]
}

const RELATION_LOOKUP_MS = 10000
// checkReadOnlySql in packages/harness/runtime/analyst-relations.mjs refuses anything else before connecting.
const READ_ONLY_SQL_NOTE =
    'Send one SELECT or WITH query with a LIMIT and no semicolon. SET, RESET, BEGIN, COMMIT, COPY, DO, INSERT, UPDATE, DELETE, set_config and pg_sleep are refused.'

// ANALYST_RULES_MAX_CHARS in packages/harness/store.mjs, which refuses a longer save.
const ANALYST_RULES_MAX_CHARS = 2000

function optionalPositive(value: unknown): number | undefined {
    if (value === undefined || value === null || String(value).trim() === '') return undefined
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : undefined
}

const importEsm = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>

let analystPostgres: Promise<AnalystPostgresModule> | undefined
let analystStore: Promise<AnalystStoreModule> | undefined
let analystRelations: Promise<AnalystRelationsModule> | undefined

function loadModule<T>(
    fileName: string,
    slot: () => Promise<T> | undefined,
    set: (value: Promise<T> | undefined) => void,
    missing: string
) {
    const existing = slot()
    if (existing) return existing
    const pending = findModule<T>(fileName, missing).catch((error) => {
        set(undefined)
        throw error
    })
    set(pending)
    return pending
}

function loadAnalystPostgres() {
    return loadModule<AnalystPostgresModule>(
        'analyst-postgres.mjs',
        () => analystPostgres,
        (value) => {
            analystPostgres = value
        },
        'PostgreSQL MCP could not load the analyst database check.'
    )
}

function loadAnalystStore() {
    return loadModule<AnalystStoreModule>(
        'analyst-store.mjs',
        () => analystStore,
        (value) => {
            analystStore = value
        },
        'PostgreSQL MCP could not load analyst storage.'
    )
}

function loadAnalystRelations() {
    return loadModule<AnalystRelationsModule>(
        'analyst-relations.mjs',
        () => analystRelations,
        (value) => {
            analystRelations = value
        },
        'PostgreSQL MCP could not load the table picker.'
    )
}

function toolError(error: unknown): string {
    const outcome = (error as { cuttlelyOutcome?: string })?.cuttlelyOutcome
    if (outcome === 'expected' || outcome === 'transport') {
        const message = error instanceof Error ? error.message : 'The analyst query failed.'
        return JSON.stringify({ error: message, cuttlelyOutcome: outcome })
    }
    throw error
}

async function analystToolsAreMissing() {
    try {
        const status = await loadModule<{ analystToolsMissing: (dataDir?: string) => boolean }>(
            'analyst-mcp-status.mjs',
            () => undefined,
            () => {},
            'PostgreSQL MCP could not load the analyst tool status.'
        )
        return status.analystToolsMissing()
    } catch {
        return false
    }
}

async function findModule<T>(fileName: string, missing: string) {
    let dir = __dirname
    for (let i = 0; i < 10; i += 1) {
        const packaged = path.join(dir, 'packages', 'harness', 'runtime', fileName)
        if (fs.existsSync(packaged)) return importEsm<T>(pathToFileURL(packaged).href)
        const runtime = path.join(dir, 'harness', 'runtime', fileName)
        if (fs.existsSync(runtime)) return importEsm<T>(pathToFileURL(runtime).href)
        const candidate = path.join(dir, 'scripts', fileName)
        if (fs.existsSync(candidate)) return importEsm<T>(pathToFileURL(candidate).href)
        dir = path.dirname(dir)
    }
    throw new Error(missing)
}

class PostgreSQL_MCP implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]
    credential: INodeParams
    documentation: string
    inputs: INodeParams[]

    constructor() {
        this.label = 'PostgreSQL MCP'
        this.name = 'postgreSQLMCP'
        this.version = 1.3
        this.type = 'PostgreSQL MCP Tool'
        this.icon = 'postgres.svg'
        this.category = 'Tools (MCP)'
        this.description = 'Query a separate Postgres database, or isolated analyst storage when CUTTLELY_ANALYST=auto'
        this.documentation = 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/postgres'
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['PostgresUrl']
        }
        this.inputs = [
            {
                label: 'Available Actions',
                name: 'mcpActions',
                type: 'asyncMultiOptions',
                loadMethod: 'listActions',
                refresh: true
            },
            {
                label: 'Tables and views',
                name: 'analystRelations',
                type: 'asyncMultiOptions',
                loadMethod: 'listRelations',
                checkboxList: true,
                refresh: true,
                optional: true,
                description:
                    'Tick the tables and views the analyst may query. It sees one line per ticked item and describes one when it needs the columns. A query that reads anything else is refused. Leave all unticked to allow every table this login can read. Applies to a database connected by credential or CUTTLELY_POSTGRES_URL.'
            },
            {
                label: 'Rules',
                name: 'analystRules',
                type: 'string',
                rows: 6,
                maxLength: ANALYST_RULES_MAX_CHARS,
                optional: true,
                placeholder:
                    'Use monthly_sales for questions about sales by month.\nStore names are written as in the stores table, for example Old Town.',
                description:
                    'Your own instructions for the analyst on a harness, such as which view answers which question or how names are written. They go into its instructions in a marked section. They cannot widen Tables and views or allow changes.'
            },
            {
                label: 'Row cap',
                name: 'analystRowCap',
                type: 'number',
                optional: true,
                additionalParams: true,
                description:
                    'Most rows one query on this node returns. Leave empty to use the server row cap. A lower number puts less of the table into the prompt. It cannot go above the server cap.'
            },
            {
                label: 'Query timeout (seconds)',
                name: 'analystTimeoutSeconds',
                type: 'number',
                optional: true,
                additionalParams: true,
                description:
                    'How long one statement on this node may run, in seconds. Leave empty to use the server timeout. It cannot go above the server timeout.'
            }
        ]
        this.baseClasses = ['Tool']
    }

    //@ts-ignore
    loadMethods = {
        listActions: async (nodeData: INodeData, options: ICommonObject): Promise<INodeOptionsValue[]> => {
            try {
                const missing = await analystToolsAreMissing()
                if (missing) {
                    return [
                        {
                            label: 'Analyst tool unavailable',
                            name: 'error',
                            description:
                                'Hermes has not registered the analyst query tool. The gateway was not answering when Hermes listed tools. Wait a few seconds and refresh Available Actions, or restart Cuttlely.'
                        }
                    ]
                }
                const toolset = await this.getTools(nodeData, options)
                toolset.sort((a: any, b: any) => a.name.localeCompare(b.name))

                return toolset.map(({ name, ...rest }) => ({
                    label: name.toUpperCase(),
                    name: name,
                    description: rest.description || name
                }))
            } catch (error) {
                const message = error instanceof Error ? error.message : 'No available actions'
                console.error('Error listing actions:', message)
                return [
                    {
                        label: 'No Available Actions',
                        name: 'error',
                        description: message.slice(0, 300)
                    }
                ]
            }
        },
        listRelations: async (nodeData: INodeData, options: ICommonObject): Promise<INodeOptionsValue[]> => {
            try {
                const connection = await this.connection(nodeData, options)
                if (connection.kind === 'auto') {
                    return [
                        {
                            label: 'Isolated analyst storage',
                            name: 'error',
                            description:
                                'The analyst keeps its own tables here, so there is nothing to pick. Choose a PostgresUrl credential to pick tables and views from your database.'
                        }
                    ]
                }
                const store = await loadAnalystStore()
                const relations = await store.listAnalystUrlRelations(connection.postgresUrl, { timeoutMs: RELATION_LOOKUP_MS })
                if (!relations.length) {
                    return [{ label: 'No tables or views', name: 'error', description: 'This login cannot read any table or view.' }]
                }
                return relations.map((relation) => ({
                    label: relation.name,
                    name: relation.name,
                    description: [relation.kind, `${relation.columns} column${relation.columns === 1 ? '' : 's'}`, relation.comment]
                        .filter(Boolean)
                        .join(' · ')
                }))
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Could not list tables and views.'
                return [{ label: 'Could not list tables and views', name: 'error', description: message.slice(0, 300) }]
            }
        }
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const tools = await this.getTools(nodeData, options)

        const _mcpActions = nodeData.inputs?.mcpActions
        let mcpActions = []
        if (_mcpActions) {
            try {
                mcpActions = typeof _mcpActions === 'string' ? JSON.parse(_mcpActions) : _mcpActions
            } catch (error) {
                console.error('Error parsing mcp actions:', error)
            }
        }

        // describe comes with query once a table selection exists, so a saved node does not need to tick it.
        return tools.filter((tool: any) => mcpActions.includes(tool.name) || (tool.name === 'describe' && mcpActions.includes('query')))
    }

    async connection(nodeData: INodeData, options: ICommonObject): Promise<AnalystConnection> {
        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const configured = getCredentialParam('postgresUrl', credentialData, nodeData)
        // A selected PostgresUrl credential wins, then CUTTLELY_POSTGRES_URL.
        // Both refuse the application database. CUTTLELY_ANALYST=auto is the remaining path.
        const { resolveAnalystConnection } = await loadAnalystPostgres()
        return resolveAnalystConnection({
            credentialUrl: typeof configured === 'string' ? configured : '',
            analystUrl: process.env.CUTTLELY_POSTGRES_URL,
            env: process.env
        })
    }

    async getTools(nodeData: INodeData, options: ICommonObject): Promise<Tool[]> {
        const decision = await this.connection(nodeData, options)
        // Each workspace has its own analyst area. A harness run also passes its workspace with the call.
        const workspace = options?.searchOptions?.workspaceId?._value || options?.workspaceId || ''
        const requested = this.nodeLimits(nodeData)
        if (decision.kind === 'auto') return this.isolatedTools(typeof workspace === 'string' ? workspace : '', requested)
        const { parseRelationSelection } = await loadAnalystRelations()
        return this.urlTools(decision.postgresUrl, requested, parseRelationSelection(nodeData?.inputs?.analystRelations))
    }

    nodeLimits(nodeData: INodeData): { rowCap?: number; statementTimeoutMs?: number } {
        const seconds = optionalPositive(nodeData?.inputs?.analystTimeoutSeconds)
        return {
            rowCap: optionalPositive(nodeData?.inputs?.analystRowCap),
            statementTimeoutMs: seconds === undefined ? undefined : Math.round(seconds * 1000)
        }
    }

    async isolatedTools(workspace = '', requested: { rowCap?: number; statementTimeoutMs?: number } = {}): Promise<Tool[]> {
        const store = await loadAnalystStore()
        const limits = store.analystCallLimits(requested, process.env)
        const ready = await store.ensureAnalystStore(process.env, { workspace })
        const spec = store.analystToolSpec(ready?.engine, limits.rowCap)
        const query = tool(
            async (input: { sql?: string; statement?: string; query?: string; cursor?: string; page?: number }): Promise<string> => {
                try {
                    const result = await store.queryAnalyst(input || {}, {
                        workspace,
                        rowCap: limits.rowCap,
                        statementTimeoutMs: limits.timeoutMs
                    })
                    return JSON.stringify(result)
                } catch (error) {
                    return toolError(error)
                }
            },
            {
                name: 'query',
                description: spec.description,
                schema: spec.schema
            }
        )
        return [query as Tool]
    }

    // The URL path runs in Cuttlely, read only, with the same row cap, page line and cursor as the isolated store.
    // A table selection adds one line per selected relation to the query tool, a describe tool, and the scope check.
    async urlTools(
        postgresUrl: string,
        requested: { rowCap?: number; statementTimeoutMs?: number } = {},
        relations: string[] = []
    ): Promise<Tool[]> {
        const store = await loadAnalystStore()
        const limits = store.analystCallLimits(requested, process.env)
        const scoped = relations.length > 0
        let summary: AnalystRelation[] | null = null
        if (scoped) {
            try {
                summary = await store.analystUrlRelations(postgresUrl, relations, { timeoutMs: RELATION_LOOKUP_MS })
            } catch {
                // The database is not answering yet. Name the selection without details; the scope check still applies.
                summary = relations.map((name) => ({ name, kind: '', columns: 0, comment: '' }))
            }
        }
        const spec = store.analystUrlToolSpec(limits.rowCap, summary)
        const query = tool(
            async (input: { sql?: string; statement?: string; query?: string; cursor?: string; page?: number }): Promise<string> => {
                try {
                    return JSON.stringify(
                        await store.queryAnalystUrl(postgresUrl, input || {}, {
                            rowCap: limits.rowCap,
                            statementTimeoutMs: limits.timeoutMs,
                            relations,
                            readOnlySql: true
                        })
                    )
                } catch (error) {
                    return toolError(error)
                }
            },
            {
                name: 'query',
                description: `${spec.description} ${READ_ONLY_SQL_NOTE}`,
                schema: spec.schema
            }
        )
        if (!scoped) return [query as Tool]
        const describeSpec = store.analystDescribeToolSpec()
        const describe = tool(
            async (input: { name?: string }): Promise<string> => {
                try {
                    return JSON.stringify(
                        await store.describeAnalystUrlRelation(postgresUrl, input || {}, relations, { timeoutMs: limits.timeoutMs })
                    )
                } catch (error) {
                    return toolError(error)
                }
            },
            {
                name: 'describe',
                description: describeSpec.description,
                schema: describeSpec.schema
            }
        )
        return [query as Tool, describe as Tool]
    }
}

module.exports = { nodeClass: PostgreSQL_MCP }
