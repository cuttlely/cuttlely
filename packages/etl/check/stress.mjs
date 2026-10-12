// etl:check --stress: a 1M-row CSV and a generated repository.
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { api, check, root, tally, WS } from './lib.mjs'

console.log('\nstress: generating a 1,000,000 row CSV and a repository')
const stressRoot = path.join(root, 'stress')
fs.mkdirSync(stressRoot, { recursive: true })
const csvFile = path.join(stressRoot, 'catalog.csv')
{
    const out = fs.createWriteStream(csvFile)
    out.write('sku,name,category,notes\n')
    const categories = ['Tents', 'Sleeping', 'Packs', 'Cooking', 'Safety']
    let pending = ''
    for (let i = 1; i <= 1000000; i += 1) {
        pending += `SKU-${i},Item ${i},${categories[i % 5]},"waterproof gear row ${i}, for alpine trips"\n`
        if (pending.length > 1 << 20) {
            out.write(pending)
            pending = ''
        }
    }
    await new Promise((resolve, reject) => out.end(pending, (error) => (error ? reject(error) : resolve())))
}
const repoDir = path.join(stressRoot, 'repo')
fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true })
fs.mkdirSync(path.join(repoDir, 'logs'), { recursive: true })
fs.writeFileSync(path.join(repoDir, '.gitignore'), 'logs/\n*.tmp\n')
for (let i = 0; i < 400; i += 1) {
    fs.writeFileSync(
        path.join(repoDir, 'src', `module-${i}.ts`),
        `export function item${i}() {\n  return 'module ${i} handles alpine inventory ${i % 7}'\n}\n`
    )
}
for (let i = 0; i < 50; i += 1) fs.writeFileSync(path.join(repoDir, 'logs', `run-${i}.log`), 'ignore me\n')
fs.writeFileSync(path.join(repoDir, 'README.md'), '# Inventory service\n\nTracks alpine gear by SKU.\n')

const stressFlow = {
    nodes: [
        {
            id: 'csv',
            data: {
                name: 'etlFileSource',
                label: 'Streaming Files',
                category: 'ETL',
                inputs: { paths: csvFile, textColumns: 'name, category, notes', idColumn: 'sku' }
            }
        },
        {
            id: 'repo',
            data: {
                name: 'etlRepoSource',
                label: 'Code Repository',
                category: 'ETL',
                inputs: { repoPath: repoDir, repoLabel: 'inventory', include: '**/*.ts, *.md' }
            }
        },
        {
            id: 'emb',
            data: { name: 'localHashEmbeddings', label: 'Local Hash Embeddings', category: 'Embeddings', inputs: { dimensions: 128 } }
        },
        {
            id: 'vs',
            data: { name: 'etlLocalVectorStore', label: 'Local Vector Store', category: 'Vector Stores', inputs: { collection: 'stress' } }
        }
    ],
    edges: [
        { source: 'csv', target: 'vs' },
        { source: 'repo', target: 'vs' },
        { source: 'emb', target: 'vs' }
    ]
}
const samples = []
const timer = setInterval(() => {
    const mem = process.memoryUsage()
    samples.push({ rss: mem.rss, heap: mem.heapUsed, external: mem.external })
}, 250)
const startedAt = performance.now()
api.recordVersion({ workspaceId: WS, id: 'stress', name: 'Stress', flowData: stressFlow })
const stressRun = api.startRun('stress', { settings: { batchSize: 256, concurrency: 2, maxRetries: 1, maxErrors: 10 } })
await api.waitForIdle()
clearInterval(timer)
const elapsed = (performance.now() - startedAt) / 1000
const done = api.runDetail(stressRun.id)
const peakRss = Math.max(...samples.map((sample) => sample.rss))
const peakHeap = Math.max(...samples.map((sample) => sample.heap))
const csvBytes = fs.statSync(csvFile).size
const chunks = done.counters.embedded
const report = {
    status: done.status,
    error: done.error,
    rows: 1000000,
    repoFilesEmbedded: 401,
    chunks,
    seconds: Math.round(elapsed * 10) / 10,
    chunksPerSecond: Math.round(chunks / elapsed),
    megabytesPerSecond: Math.round(csvBytes / elapsed / 1e4) / 100,
    peakRssMb: Math.round(peakRss / 1e6),
    peakHeapMb: Math.round(peakHeap / 1e6),
    csvMb: Math.round(csvBytes / 1e6),
    deleted: done.counters.deleted,
    skipped: done.counters.skipped
}
console.log(`STRESS ${JSON.stringify(report)}`)
check('stress run completes', done.status === 'succeeded', done.error || '')
check('stress embeds the csv and the repo files', chunks === 1000401, String(chunks))
check('stress memory stays under 600 MB', peakRss < 600e6, `${report.peakRssMb} MB`)

const againAt = performance.now()
const again = api.startRun('stress', { settings: { batchSize: 256, concurrency: 2, maxRetries: 1, maxErrors: 10 } })
await api.waitForIdle()
const second = api.runDetail(again.id)
const skipSeconds = Math.round(((performance.now() - againAt) / 1000) * 10) / 10
check(
    'second stress run embeds nothing',
    second.status === 'succeeded' && second.counters.embedded === 0 && second.counters.unitsSkipped === 402,
    JSON.stringify(second.counters)
)
console.log(
    `STRESS_RERUN ${JSON.stringify({
        seconds: skipSeconds,
        unitsSkipped: second.counters.unitsSkipped,
        embedded: second.counters.embedded
    })}`
)
console.log(`${tally.passed} etl checks passed`)
