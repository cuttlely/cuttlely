import fs from 'node:fs'
import path from 'node:path'
import { api, check, root, WS } from './lib.mjs'
import { estimateSource } from '../sources.mjs'
import { stmt } from '../db.mjs'

const dir = path.join(root, 'responsive-repository')
fs.mkdirSync(dir)
for (let i = 0; i < 110; i += 1) fs.writeFileSync(path.join(dir, `note-${String(i).padStart(3, '0')}.md`), '# Note\nSafe text.\n')

// Slow metadata I/O must not monopolize the server loop until the entire directory is counted.
for (const nodeName of ['etlRepoSource', 'etlFileSource']) {
    const stat = fs.statSync
    const sleeper = new Int32Array(new SharedArrayBuffer(4))
    let ticked = false
    const pending = new Promise((resolve) =>
        setImmediate(() => {
            ticked = true
            resolve()
        })
    )
    try {
        fs.statSync = (...args) => {
            if (String(args[0]).startsWith(`${dir}${path.sep}`)) Atomics.wait(sleeper, 0, 0, 2)
            return stat(...args)
        }
        const estimate = await estimateSource(
            { nodeName, nodeId: 'src', kind: 'stream', inputs: { repoPath: dir, paths: dir } },
            { workspaceId: WS }
        )
        check(`${nodeName} services pending event-loop work during a source scan`, ticked)
        check(`${nodeName} cooperative scan preserves source counts`, estimate.units === 110 && estimate.bytes > 0)
    } finally {
        fs.statSync = stat
        await pending
    }
}

const node = (id, name, category, inputs) => ({ id, data: { name, label: name, category, inputs } })
const flow = {
    nodes: [
        node('src', 'etlRepoSource', 'ETL', { repoPath: dir }),
        node('tx', 'etlTransform', 'ETL', { metadata: JSON.stringify({ oversized: 'x'.repeat(2100) }) }),
        node('sp', 'markdownTextSplitter', 'Text Splitters', { chunkSize: 1200, chunkOverlap: 100 }),
        node('emb', 'localHashEmbeddings', 'Embeddings', { dimensions: 16 }),
        node('vs', 'etlLocalVectorStore', 'Vector Stores', { collection: 'responsive-repository' })
    ],
    edges: [
        { source: 'src', target: 'tx' },
        { source: 'tx', target: 'vs' },
        { source: 'sp', target: 'src' },
        { source: 'emb', target: 'vs' }
    ]
}
const saved = await api.recordVersion({ id: 'error-before-commit', name: 'Error before commit', workspaceId: WS, flowData: flow })
check('uncommitted-error fixture compiles', saved.problems.length === 0, saved.problems.join('; '))
const run = await api.startRun('error-before-commit', { settings: { batchSize: 64, concurrency: 4, maxErrors: 100 } })
await api.waitForIdle()
const result = await api.runDetail(run.id)
check(
    'error limit still stops at 101 errors with no writes',
    result.status === 'failed' && result.counters.errors === 101 && result.counters.chunks === 0 && result.counters.embedded === 0
)
check(
    'error limit retains the first uncommitted validation cause',
    result.error.includes('value_too_long:oversized') &&
        result.error.includes('cap 2000') &&
        result.counters.firstDocumentError?.reason === 'value_too_long:oversized'
)
const events = stmt("SELECT message FROM run_events WHERE run_id = ? AND level = 'error'").all(run.id)
check(
    'first uncommitted validation cause survives in persisted events',
    events.some((event) => event.message.includes('value_too_long:oversized'))
)
check(
    'failed uncommitted run does not publish its pipeline version',
    (await api.pipelineDetail('error-before-commit')).servedVersion == null
)

// Diagnostic size is bounded independently of an authored metadata field name.
{
    const boundedFlow = {
        ...flow,
        nodes: flow.nodes.map((n) =>
            n.id === 'tx'
                ? { ...n, data: { ...n.data, inputs: { metadata: JSON.stringify({ ['oversized'.repeat(500)]: 'x'.repeat(2100) }) } } }
                : n
        )
    }
    const saved = await api.recordVersion({
        id: 'bounded-error-diagnostics',
        name: 'Bounded error diagnostics',
        workspaceId: WS,
        flowData: boundedFlow
    })
    check('bounded diagnostic fixture compiles', saved.problems.length === 0)
    const run = await api.startRun('bounded-error-diagnostics', { settings: { maxErrors: 0 } })
    await api.waitForIdle()
    const result = await api.runDetail(run.id)
    const first = result.counters.firstDocumentError
    check(
        'first error diagnostics remain bounded without changing rejection',
        result.status === 'failed' &&
            result.counters.errors === 1 &&
            first.reason.length <= 200 &&
            first.message.length <= 1200 &&
            first.source.length <= 300 &&
            result.error.length < 1600
    )
}
