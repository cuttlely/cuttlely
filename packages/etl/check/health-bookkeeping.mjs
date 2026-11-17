import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { Worker } from 'node:worker_threads'
import { api, check, root, WS } from './lib.mjs'
import { db } from '../db.mjs'
const repo = path.join(root, 'health-bookkeeping-repo')
fs.mkdirSync(repo)
for (let i = 0; i < 600; i++)
    fs.writeFileSync(path.join(repo, `note-${String(i).padStart(4, '0')}.md`), `# Note ${i}\nUnique safe content ${i}.`)
const node = (id, name, category, inputs) => ({ id, data: { name, label: name, category, inputs } })
const flow = {
    nodes: [
        node('s', 'etlRepoSource', 'ETL', { repoPath: repo }),
        node('e', 'localHashEmbeddings', 'Embeddings', { dimensions: 8 }),
        node('v', 'etlLocalVectorStore', 'Vector Stores', { collection: 'health-bookkeeping' })
    ],
    edges: [
        { source: 's', target: 'v' },
        { source: 'e', target: 'v' }
    ]
}
let server, worker, original
try {
    const p = api.recordVersion({ id: 'health-bookkeeping', name: 'Health fixture', workspaceId: WS, flowData: flow })
    if (p.problems.length) throw Error(p.problems.join(';'))
    api.startRun('health-bookkeeping')
    await api.waitForIdle()
    server = http.createServer((_q, r) => r.end('pong'))
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    worker = new Worker(
        `const {parentPort}=require('node:worker_threads');const http=require('node:http');parentPort.postMessage('ready');parentPort.once('message',port=>{const start=performance.now();const q=http.get({host:'127.0.0.1',port,path:'/api/v1/ping'},r=>{r.resume();r.on('end',()=>{parentPort.postMessage({http:r.statusCode,ms:Math.round(performance.now()-start)});parentPort.close()})});q.setTimeout(5000,()=>q.destroy(new Error('5-second health timeout')));q.on('error',e=>{parentPort.postMessage({error:e.message,ms:Math.round(performance.now()-start)});parentPort.close()})})`,
        { eval: true }
    )
    await new Promise((r) => worker.once('message', r))
    const probe = new Promise((r) => worker.once('message', r))
    const handle = db()
    original = handle.exec
    const wait = new Int32Array(new SharedArrayBuffer(4))
    let started = false
    handle.exec = function (sql) {
        if (sql === 'COMMIT') {
            if (!started) {
                started = true
                worker.postMessage(server.address().port)
            }
            Atomics.wait(wait, 0, 0, 12)
        }
        return original.call(this, sql)
    }
    const run = api.startRun('health-bookkeeping', { settings: { batchSize: 64, concurrency: 4 } })
    await api.waitForIdle()
    const result = api.runDetail(run.id)
    check('health test exercised unchanged-source transactions', started)
    const health = await probe
    check('HTTP health responds during slow unchanged-source bookkeeping', health.http === 200, JSON.stringify(health))
    check(
        'health-safe run preserves all unchanged sources',
        result.status === 'succeeded' && result.counters.unitsSkipped === 600 && result.counters.unitsTotal === 600
    )
} finally {
    if (original) db().exec = original
    await worker?.terminate()
    if (server) await new Promise((r) => server.close(r))
}
