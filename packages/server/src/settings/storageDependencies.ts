export interface StorageDependency {
    flow: string
    workspace: string
    revision: string
    node: string
    input: string
    location: string
    resolution: string
}
export type StoredCanvas = { flow: string; workspace: string; revision: string; graph: string }
let catalog: Set<string> | undefined
function knownNodes() {
    if (!catalog) {
        const { nodes } = require('@cuttlely/components/module-catalog') as { nodes: Array<{ name: string }> }
        catalog = new Set(nodes.map((node) => node.name))
    }
    return catalog
}
const fileInputs: Record<string, string[]> = {
    SQLiteRecordManager: ['databaseFilePath'],
    sqliteAgentMemory: ['databaseFilePath'],
    faiss: ['basePath'],
    folderFiles: ['folderPath'],
    notionFolder: ['notionFolder'],
    etlRepoSource: ['repoPath'],
    milvus: ['clientPemPath', 'clientKeyPath', 'caPemPath']
}

const resolutions: Record<string, string> = {
    SQLiteRecordManager:
        'Migrate the record-manager keys and timestamps to a supported PostgreSQL record manager, then verify an unchanged input before rerunning preflight.',
    sqliteAgentMemory: 'Move existing checkpoints to a compatible PostgreSQL memory store and verify that a saved conversation resumes.',
    agentMemory: 'Move existing checkpoints to the PostgreSQL backend and verify a saved conversation before switching the node.',
    sqlDatabaseChain:
        'Migrate the source tables to a durable database supported by the chain, then update its connection and verify a representative query.',
    etlRepoSource: 'Use a recoverable Git URL and verify the intended revision and files, including any local changes.',
    milvus: 'Supply the certificate or key at the required path through the host secret manager on every replacement instance.',
    faiss: 'Move the index to a supported durable vector store, or rebuild from verified durable source data and compare retrieval results.'
}

// Only display literal paths to the designated operator. Connection strings, expressions, code and inline data stay out of reports.
function location(value: unknown): string {
    if (!value) return 'Node default on local disk'
    if (typeof value !== 'string' || /[\r\n?#@{}]|:\/\//.test(value) || value.length > 512) return 'Inspect the configured input'
    return value
}

type EtlContext = {
    canvases: StoredCanvas[]
    hostFile(input: unknown): boolean
    etlSource(input: string, workspace: string): 'external' | 'sample' | 'upload' | 'host'
}

export function canvasStorageDependencies(canvases: Iterable<StoredCanvas>, etl?: EtlContext) {
    const rebuildable = new Set<string>()
    const issues: StorageDependency[] = []
    for (const { flow, workspace, revision, graph } of canvases) {
        const note = (node: string, input: string, description: string, resolution: string) =>
            issues.push({ flow, workspace, revision, node, input, location: description, resolution })
        let nodes
        try {
            nodes = JSON.parse(graph).nodes
        } catch {
            /* An unreadable canvas must not be silently skipped. */
        }
        if (!Array.isArray(nodes)) {
            note('Canvas', 'flowData', 'Unreadable canvas', 'Restore or repair the graph, then rerun preflight.')
            continue
        }
        for (const item of nodes) {
            const name = item?.data?.name,
                id = String(item?.id || name || 'Unknown node')
            if (typeof name !== 'string' || !knownNodes().has(name)) {
                // Canvas notes are presentation elements and have no executable node inputs.
                if (item?.type !== 'stickyNote' && item?.type !== 'stickyNoteNode')
                    note(
                        id,
                        'plugin',
                        'Unrecognized node',
                        'Inspect the plugin files and replace the node with a supported durable integration, or retire the dependency.'
                    )
                continue
            }
            if (name === 'bufferMemory' || name === 'bufferWindowMemory') {
                const label = name === 'bufferMemory' ? 'Buffer Memory' : 'Buffer Window Memory'
                rebuildable.add(
                    label + ' reloads saved messages for the same flow and session from the application database on the next request.'
                )
            }
            const inputs = item.data.inputs || {}
            if (name === 'etlFileSource' && etl) {
                const paths = Array.isArray(inputs.paths) ? inputs.paths : String(inputs.paths || '').split(/[\n,]/)
                for (const value of paths) {
                    const file = String(value).trim()
                    if (file && etl.etlSource(file, workspace) === 'external')
                        note(
                            id,
                            'paths',
                            location(file),
                            'Supply a recoverable source or upload the file through this pipeline, then rerun preflight.'
                        )
                }
            }
            let fields = fileInputs[name] || []
            if (name === 'agentMemory' && (!inputs.databaseType || inputs.databaseType === 'sqlite')) fields = ['databaseFilePath']
            if (name === 'sqlDatabaseChain' && inputs.database === 'sqlite') fields = ['url']
            for (const field of fields) {
                if (name === 'milvus' && etl?.hostFile(inputs[field])) continue
                if ((name === 'etlRepoSource' || name === 'milvus') && !inputs[field]) continue
                note(
                    id,
                    field,
                    location(inputs[field]),
                    resolutions[name] ||
                        'Move the source to a supported durable integration and verify it on an empty instance, or retire the dependency.'
                )
            }
        }
    }
    return { dependencies: issues, rebuildable: [...rebuildable].sort() }
}

export async function applicationStorageDependencies(query: (sql: string) => Promise<StoredCanvas[]>, etl?: EtlContext) {
    const canvases =
        await query(`SELECT CAST(id AS text) AS flow,CAST("workspaceId" AS text) AS workspace,'live' AS revision,"flowData" AS graph FROM chat_flow
        UNION ALL SELECT CAST("chatflowId" AS text),CAST("workspaceId" AS text),'draft',"draftFlowData" FROM flow_version_state WHERE "draftFlowData" IS NOT NULL`)
    return canvasStorageDependencies([...canvases, ...(etl?.canvases || [])], etl)
}
