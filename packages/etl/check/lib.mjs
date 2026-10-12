// Shared state for etl:check: the temp root, the environment, the API and the check helpers. Imported first, so the
// environment is set before any engine module loads.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-check-'))
process.env.CUTTLELY_DATA_DIR = path.join(root, 'data')
process.env.CUTTLELY_ETL_ROOTS = root
// Test-only faults (ctx.faults) are honored only with this set.
process.env.ETL_CHECK = '1'

export const api = await import('../api.mjs')
export const readers = await import('../readers.mjs')
export const ignore = await import('../ignore.mjs')
export const embed = await import('../embed.mjs')
export const { chunkId } = await import('../execute.mjs')
export const { LocalVectorStore } = await import('../stores.mjs')

// Every pipeline in etl:check belongs to this workspace unless a case says otherwise.
export const WS = 'ws-check'

export const tally = { passed: 0, pending: [] }
export const check = (name, ok, detail = '') => {
    if (!ok) {
        console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`)
        process.exitCode = 1
        throw new Error(name)
    }
    tally.passed += 1
    console.log(`ok ${name}`)
}

// A spec case that belongs to an item outside this change (spec section 7). Listed, never counted as passed.
export const pending = (name, item) => {
    tally.pending.push(name)
    console.log(`PENDING ${name} (${item})`)
}

export const flowFor = (file, collection) => ({
    nodes: [
        {
            id: 'src',
            data: {
                name: 'etlFileSource',
                label: 'Streaming Files',
                category: 'ETL',
                inputs: { paths: file, textColumns: 'name, notes', idColumn: 'sku' }
            }
        },
        { id: 'tx', data: { name: 'etlTransform', label: 'Clean & Transform', category: 'ETL', inputs: { minChars: 1 } } },
        {
            id: 'emb',
            data: { name: 'localHashEmbeddings', label: 'Local Hash Embeddings', category: 'Embeddings', inputs: { dimensions: 64 } }
        },
        { id: 'vs', data: { name: 'etlLocalVectorStore', label: 'Local Vector Store', category: 'Vector Stores', inputs: { collection } } }
    ],
    edges: [
        { source: 'src', target: 'tx' },
        { source: 'tx', target: 'vs' },
        { source: 'emb', target: 'vs' }
    ]
})

export async function runPipeline(id, name, flow, mode = 'incremental') {
    const saved = api.recordVersion({ workspaceId: WS, id, name, flowData: flow })
    check(`${name} compiles`, saved.problems.length === 0, saved.problems.join('; '))
    const run = api.startRun(id, { mode, settings: { batchSize: 32, concurrency: 2, maxRetries: 2, maxErrors: 5 } })
    await api.waitForIdle()
    return api.runDetail(run.id)
}
