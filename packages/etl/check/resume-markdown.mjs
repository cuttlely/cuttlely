import fs from 'node:fs'
import path from 'node:path'
import { api, check, root, WS } from './lib.mjs'
import { LocalVectorStore } from '../stores.mjs'
const repo = path.join(root, 'resume-markdown-repo')
fs.mkdirSync(repo)
fs.writeFileSync(
    path.join(repo, 'report.md'),
    '# Report\n' + Array.from({ length: 14000 }, (_, i) => `Unique Markdown row ${i} contains safe text.\n`).join('')
)
const node = (id, name, category, inputs) => ({ id, data: { name, label: name, category, inputs } })
const flow = (collection) => ({
    nodes: [
        node('src', 'etlRepoSource', 'ETL', { repoPath: repo }),
        node('tx', 'etlTransform', 'ETL', { minChars: 1 }),
        node('sp', 'markdownTextSplitter', 'Text Splitters', { chunkSize: 1200, chunkOverlap: 100 }),
        node('emb', 'localHashEmbeddings', 'Embeddings', { dimensions: 16 }),
        node('vs', 'etlLocalVectorStore', 'Vector Stores', { collection })
    ],
    edges: [
        { source: 'src', target: 'tx' },
        { source: 'tx', target: 'vs' },
        { source: 'sp', target: 'src' },
        { source: 'emb', target: 'vs' }
    ]
})
let entered, release, timer
let taken = false
const blocked = new Promise((r) => (entered = r))
const hold = new Promise((r) => (release = r))
api.configureRunner({
    contextFor: () => ({
        embedGate: async (n) => {
            if (n === 2 && !taken) {
                taken = true
                entered()
                await hold
            }
        }
    })
})
try {
    const saved = await api.recordVersion({
        id: 'resume-markdown',
        name: 'Resume Markdown',
        workspaceId: WS,
        flowData: flow('resume-markdown')
    })
    check('multi-batch Markdown fixture compiles', saved.problems.length === 0, saved.problems.join(';'))
    const started = await api.startRun('resume-markdown', { settings: { batchSize: 64, concurrency: 1 } })
    await Promise.race([
        blocked,
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('Second embedding batch did not reach its gate')), 5000)))
    ])
    clearTimeout(timer)
    await api.pauseRun(started.id)
    release()
    await api.waitForIdle()
    const paused = await api.runDetail(started.id)
    check(
        'Markdown fixture pauses within its first record',
        paused.status === 'paused' && paused.checkpoint.ordinal === 0 && !paused.checkpoint.done && paused.counters.embedded > 0
    )
    await api.resumeRun(started.id)
    await api.waitForIdle()
    const resumed = await api.runDetail(started.id)
    check(
        'replayed Markdown record is not a duplicate',
        resumed.status === 'succeeded' && resumed.counters.errors === 0 && resumed.summary.read === 1
    )
    await api.recordVersion({ id: 'clean-markdown', name: 'Clean Markdown', workspaceId: WS, flowData: flow('clean-markdown') })
    await api.startRun('clean-markdown', { settings: { batchSize: 64, concurrency: 1 } })
    await api.waitForIdle()
    const content = (c) =>
        LocalVectorStore.open(c)
            .db.prepare('SELECT content FROM vectors')
            .all()
            .map((r) => r.content)
            .sort()
    const expected = content('clean-markdown')
    check(
        'resumed Markdown stores every chunk of a clean run',
        expected.length > paused.counters.embedded && JSON.stringify(content('resume-markdown')) === JSON.stringify(expected)
    )
} finally {
    clearTimeout(timer)
    release()
    await api.waitForIdle()
    api.configureRunner({ contextFor: () => ({}) })
}
