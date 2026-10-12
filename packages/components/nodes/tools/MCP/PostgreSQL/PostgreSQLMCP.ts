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
    queryAnalyst: (sql: string | Record<string, unknown>, options?: { env?: NodeJS.ProcessEnv; workspace?: string }) => Promise<unknown>
    analystSqlText: (input: unknown) => string
    analystToolSpec: (engine?: string) => { description: string; schema: Record<string, unknown> }
    queryAnalystUrl: (postgresUrl: string, input: Record<string, unknown>) => Promise<unknown>
    analystUrlToolSpec: () => { description: string; schema: Record<string, unknown> }
}

const importEsm = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>

let analystPostgres: Promise<AnalystPostgresModule> | undefined
let analystStore: Promise<AnalystStoreModule> | undefined

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
        this.version = 1.0
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

        return tools.filter((tool: any) => mcpActions.includes(tool.name))
    }

    async getTools(nodeData: INodeData, options: ICommonObject): Promise<Tool[]> {
        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const configured = getCredentialParam('postgresUrl', credentialData, nodeData)
        // A selected PostgresUrl credential wins, then CUTTLELY_POSTGRES_URL.
        // Both refuse the application database. CUTTLELY_ANALYST=auto is the remaining path.
        const { resolveAnalystConnection } = await loadAnalystPostgres()
        const decision = resolveAnalystConnection({
            credentialUrl: typeof configured === 'string' ? configured : '',
            analystUrl: process.env.CUTTLELY_POSTGRES_URL,
            env: process.env
        })
        // Each workspace has its own analyst area. A harness run also passes its workspace with the call.
        const workspace = options?.searchOptions?.workspaceId?._value || options?.workspaceId || ''
        if (decision.kind === 'auto') return this.isolatedTools(typeof workspace === 'string' ? workspace : '')
        return this.urlTools(decision.postgresUrl)
    }

    async isolatedTools(workspace = ''): Promise<Tool[]> {
        const store = await loadAnalystStore()
        const ready = await store.ensureAnalystStore(process.env, { workspace })
        const spec = store.analystToolSpec(ready?.engine)
        const query = tool(
            async (input: { sql?: string; statement?: string; query?: string; cursor?: string; page?: number }): Promise<string> => {
                try {
                    const result = await store.queryAnalyst(input || {}, { workspace })
                    return JSON.stringify(result)
                } catch (error) {
                    const outcome = (error as { cuttlelyOutcome?: string })?.cuttlelyOutcome
                    if (outcome === 'expected' || outcome === 'transport') {
                        const message = error instanceof Error ? error.message : 'The analyst query failed.'
                        return JSON.stringify({ error: message, cuttlelyOutcome: outcome })
                    }
                    throw error
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

    // The URL path runs in Cuttlely, read only, with the same 100-row cap, page line and cursor as the isolated store.
    async urlTools(postgresUrl: string): Promise<Tool[]> {
        const store = await loadAnalystStore()
        const spec = store.analystUrlToolSpec()
        const query = tool(
            async (input: { sql?: string; statement?: string; query?: string; cursor?: string; page?: number }): Promise<string> => {
                try {
                    return JSON.stringify(await store.queryAnalystUrl(postgresUrl, input || {}))
                } catch (error) {
                    const outcome = (error as { cuttlelyOutcome?: string })?.cuttlelyOutcome
                    if (outcome === 'expected' || outcome === 'transport') {
                        const message = error instanceof Error ? error.message : 'The analyst query failed.'
                        return JSON.stringify({ error: message, cuttlelyOutcome: outcome })
                    }
                    throw error
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
}

module.exports = { nodeClass: PostgreSQL_MCP }
