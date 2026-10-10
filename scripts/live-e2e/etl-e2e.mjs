// Live ETL end-to-end steps against a running Cuttlely and the Pinecone test index.
// Usage: node scripts/live-e2e/etl-e2e.mjs <step> [--state file]
//   build | run | schedule | incremental | bad-input | resume-build | resume-kill | resume-verify | verify
import fs from 'node:fs'
import path from 'node:path'
import { api, buildNode, connect, credentialId, listIds, log, namespaceCount, settleCount, sleep, upsertFlow, waitRun } from './lib.mjs'
import { e2e } from './paths.mjs'

const STATE = process.env.E2E_STATE || e2e('state.json')
const CORPUS_ROOT = process.env.E2E_CORPUS_ROOT || e2e('corpus')
const SEED = path.join(CORPUS_ROOT, 'docs')
const INDEX = 'cuttlely-test'

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {}
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2))
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-').toLowerCase()

function record(key, value) {
    state.evidence = state.evidence || {}
    state.evidence[key] = value
    save()
    log(`${key}:`, JSON.stringify(value, null, 2))
}

async function pipelineFlow({ name, namespace, folder, batchSize }) {
    const [openai, pinecone] = await Promise.all([credentialId('e2e-openai'), credentialId('e2e-pinecone')])
    const splitter = await buildNode('recursiveCharacterTextSplitter', 'recursiveCharacterTextSplitter_0', {
        inputs: { chunkSize: '200', chunkOverlap: '0' },
        position: { x: 0, y: 0 }
    })
    const source = await buildNode('etlFileSource', 'etlFileSource_0', {
        inputs: { paths: folder, format: 'auto', include: '**/*.md, **/*.jsonl' },
        position: { x: 350, y: 0 }
    })
    const embeddings = await buildNode('openAIEmbeddings', 'openAIEmbeddings_0', {
        inputs: { modelName: 'text-embedding-3-small', ...(batchSize ? { batchSize: String(batchSize) } : {}) },
        credential: openai,
        position: { x: 350, y: 500 }
    })
    const store = await buildNode('pinecone', 'pinecone_0', {
        inputs: { pineconeIndex: INDEX, pineconeNamespace: namespace, topK: '4' },
        credential: pinecone,
        output: 'vectorStore',
        position: { x: 750, y: 200 }
    })
    const edges = [connect(splitter, source, 'textSplitter'), connect(source, store, 'document'), connect(embeddings, store, 'embeddings')]
    return { name, type: 'ETL', nodes: [splitter, source, embeddings, store], edges }
}

async function startAndWait(pipelineId, body = {}) {
    const run = await api('POST', `/etl/pipelines/${pipelineId}/runs`, body)
    log(`started run ${run.id}`)
    return waitRun(run.id)
}

function runSummary(run) {
    const c = run.counters || {}
    return {
        runId: run.id,
        status: run.status,
        mode: run.mode,
        version: run.version,
        attempt: run.attempt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        counters: {
            chunks: c.chunks,
            embedded: c.embedded,
            skipped: c.skipped,
            deleted: c.deleted,
            docsLoaded: c.docsLoaded,
            unitsTotal: c.unitsTotal,
            unitsDone: c.unitsDone,
            unitsSkipped: c.unitsSkipped,
            errors: c.errors,
            batches: c.batches,
            retries: c.retries
        },
        events: (run.events || []).map((e) => `${e.level} ${e.step || '-'} ${e.message}`)
    }
}

async function pineconeCheck(ns, pipelineId, label) {
    const detail = await api('GET', `/etl/pipelines/${pipelineId}`)
    const expected = detail.stats.chunks
    const ids = await settleCount(ns, expected)
    const count = await namespaceCount(ns)
    const unique = new Set(ids).size
    const result = {
        namespace: ns,
        etlRecords: expected,
        etlSources: detail.stats.sources,
        pineconeListedIds: ids.length,
        pineconeUniqueIds: unique,
        describeStatsCount: count,
        ids
    }
    record(label, result)
    if (ids.length !== expected || unique !== ids.length)
        throw new Error(`${label}: Pinecone has ${ids.length} ids, ETL tracks ${expected}`)
    return result
}

const steps = {
    // 1a: corpus copy, pipeline saved through the chatflow API (as the ETL canvas does), first run.
    async build() {
        const ts = stamp()
        state.ts = ts
        state.namespace = `e2e-main-${ts}`
        state.pipelineName = `e2e-rag-${ts}`
        state.folder = path.join(CORPUS_ROOT, `main-${ts}`)
        fs.mkdirSync(state.folder, { recursive: true })
        for (const file of fs.readdirSync(SEED)) fs.copyFileSync(path.join(SEED, file), path.join(state.folder, file))
        const flow = await pipelineFlow({ name: state.pipelineName, namespace: state.namespace, folder: state.folder })
        const saved = await upsertFlow(flow)
        state.pipelineId = saved.id
        save()
        const detail = await api('GET', `/etl/pipelines/${saved.id}`)
        record('build', {
            pipelineId: saved.id,
            name: state.pipelineName,
            namespace: state.namespace,
            folder: state.folder,
            version: detail.latestVersion,
            problems: detail.problems,
            warnings: detail.warnings,
            spec: {
                store: detail.spec.store.nodeName,
                embeddings: detail.spec.embeddings.nodeName,
                sources: detail.spec.sources.map((s) => s.nodeName),
                splitter: detail.spec.sources[0].splitter?.nodeName
            }
        })
    },
    async run() {
        const run = await startAndWait(state.pipelineId)
        record('run1', runSummary(run))
        if (run.status !== 'completed') throw new Error(`run1 ${run.status}: ${run.error}`)
        await pineconeCheck(state.namespace, state.pipelineId, 'run1Pinecone')
    },
    // 1b: an interval schedule fires a run with no manual trigger.
    async schedule() {
        const before = await api('GET', `/etl/pipelines/${state.pipelineId}/runs`)
        const created = await api('POST', `/etl/pipelines/${state.pipelineId}/schedules`, {
            kind: 'interval',
            every: 1,
            unit: 'minutes',
            mode: 'incremental'
        })
        log(`schedule ${created.id} next run at ${created.nextRunAt}`)
        const known = new Set(before.map((r) => r.id))
        const deadline = Date.now() + 180000
        let fired
        while (!fired && Date.now() < deadline) {
            await sleep(5000)
            const runs = await api('GET', `/etl/pipelines/${state.pipelineId}/runs`)
            fired = runs.find((r) => !known.has(r.id))
        }
        if (!fired) throw new Error('no scheduled run fired within 3 minutes')
        const run = await waitRun(fired.id)
        const schedules = await api('GET', `/etl/pipelines/${state.pipelineId}/schedules`)
        const sched = schedules.find((s) => s.id === created.id)
        await api('DELETE', `/etl/schedules/${created.id}`)
        record('schedule', {
            scheduleId: created.id,
            createdAt: created.createdAt,
            firstNextRunAt: created.nextRunAt,
            scheduleLastRunId: sched.lastRunId,
            scheduleLastRunAt: sched.lastRunAt,
            scheduleLastResult: sched.lastResult,
            nextRunAtAfter: sched.nextRunAt,
            deletedAfterProof: true,
            run: runSummary(run)
        })
        if (sched.lastRunId !== run.id || run.status !== 'completed') throw new Error('scheduled run did not complete')
    },
    // 1c: change one doc, add one, delete one, rerun incrementally.
    async incremental() {
        const before = await listIds(state.namespace)
        const f = state.folder
        fs.writeFileSync(
            path.join(f, 'quill-ferry.md'),
            `# Quill Ferry Line

The Quill Ferry Line connects the islands of Tessaly and Morrow Bay. As of the 2026 timetable the ferry departs Tessaly every 70 minutes.
Its flagship vessel is now the MV Copper Lantern, captained by Captain Rosalind Achterberg.
A one-way adult ticket costs 16.80 zorin. The ferry line was founded in 1987.
`
        )
        fs.writeFileSync(
            path.join(f, 'brightwater-observatory.md'),
            `# Brightwater Observatory

Brightwater Observatory sits on Mount Halloran. Its main telescope, the "Iris Array", has a 7.4 meter mirror.
The observatory director is Professor Kwame Lindqvist-Oduya. Visitor nights are held every third Thursday.
The observatory's catalog prefix is BWO-2219.
`
        )
        fs.rmSync(path.join(f, 'marrow-bakery.md'))
        const run = await startAndWait(state.pipelineId)
        const summary = runSummary(run)
        const pc = await pineconeCheck(state.namespace, state.pipelineId, 'incrementalPinecone')
        const after = new Set(pc.ids)
        const removed = before.filter((id) => !after.has(id))
        const added = pc.ids.filter((id) => !before.includes(id))
        record('incremental', {
            run: summary,
            idsBefore: before.length,
            idsAfter: pc.ids.length,
            idsRemoved: removed,
            idsAdded: added,
            unchangedIdsKept: before.filter((id) => after.has(id)).length
        })
        if (run.status !== 'completed') throw new Error(`incremental run ${run.status}`)
    },
    // 1e: a malformed JSONL line is rejected and logged; the rest of the file and the other docs still index.
    async 'bad-input'() {
        fs.writeFileSync(
            path.join(state.folder, 'harbor-feed.jsonl'),
            [
                JSON.stringify({
                    id: 'harbor-001',
                    title: 'Harbor Lantern',
                    text: 'The Harbor Lantern lighthouse keeper is Wendeline Osgood. The lighthouse beam code is HL-3307.'
                }),
                '{"id": "harbor-002", "title": "Broken record", "text": "this line is cut off',
                JSON.stringify({
                    id: 'harbor-003',
                    title: 'Harbor Pier',
                    text: 'Harbor Pier 9 has exactly 58 mooring cleats and was rebuilt in 2019.'
                })
            ].join('\n') + '\n'
        )
        const run = await startAndWait(state.pipelineId)
        const summary = runSummary(run)
        const pc = await pineconeCheck(state.namespace, state.pipelineId, 'badInputPinecone')
        record('badInput', { run: summary, pineconeIds: pc.ids.length })
        if (run.status !== 'completed') throw new Error(`bad-input run ${run.status}`)
    },
    async verify() {
        await pineconeCheck(state.namespace, state.pipelineId, 'verifyPinecone')
    },
    // 1d: a bigger single-doc pipeline in its own namespace, small batches so a kill lands mid-run.
    async 'resume-build'() {
        const ts = stamp()
        state.resume = { ts, namespace: `e2e-resume-${ts}`, name: `e2e-resume-${ts}`, folder: path.join(CORPUS_ROOT, `resume-${ts}`) }
        fs.mkdirSync(state.resume.folder, { recursive: true })
        const lines = []
        for (let i = 1; i <= 60; i += 1) {
            lines.push(
                `Ledger entry ${i}: crate ${String(i).padStart(3, '0')} of the Vantor depot holds ${i * 7} brass gears and is tagged VD-${
                    1000 + i
                }.`
            )
        }
        fs.writeFileSync(path.join(state.resume.folder, 'vantor-ledger.md'), `# Vantor depot ledger\n\n${lines.join('\n\n')}\n`)
        const flow = await pipelineFlow({ name: state.resume.name, namespace: state.resume.namespace, folder: state.resume.folder })
        const saved = await upsertFlow(flow)
        state.resume.pipelineId = saved.id
        save()
        record('resumeBuild', { pipelineId: saved.id, namespace: state.resume.namespace, folder: state.resume.folder })
    },
    // Starts the run with batch size 2, waits until a few batches commit, then prints the snapshot; the caller kills the server.
    async 'resume-start'() {
        const run = await api('POST', `/etl/pipelines/${state.resume.pipelineId}/runs`, { settings: { batchSize: 2, concurrency: 1 } })
        state.resume.runId = run.id
        save()
        log(`started resume run ${run.id}`)
        for (;;) {
            await sleep(300)
            const detail = await api('GET', `/etl/pipelines/${state.resume.pipelineId}`)
            if (detail.stats.chunks >= 12) {
                log(`READY_TO_KILL records=${detail.stats.chunks}`)
                return
            }
        }
    },
    // After the kill, before restart, the control DB is read through the API once the server is back.
    async 'resume-verify'() {
        const r = state.resume
        const run = await waitRun(r.runId, { until: ['completed', 'failed', 'cancelled'] })
        const pc = await pineconeCheck(r.namespace, r.pipelineId, 'resumePinecone')
        record('resume', { run: runSummary(run), snapshotAtKill: r.snapshot, pineconeIds: pc.ids.length })
    }
}

const step = process.argv[2]
if (!steps[step]) {
    console.error(`unknown step ${step}; one of ${Object.keys(steps).join(', ')}`)
    process.exit(2)
}
await steps[step]()
