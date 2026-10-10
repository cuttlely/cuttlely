// Pressure-test ETL steps. Runs against a live Cuttlely and the Pinecone test index.
// Usage: node scripts/live-e2e/pt-etl.mjs <step>
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import {
    api,
    buildNode,
    connect,
    credentialId,
    fetchVectors,
    listIds,
    log,
    namespaceCount,
    queryByFilter,
    settleCount,
    sleep,
    upsertFlow,
    waitRun
} from './lib.mjs'
import { e2e, PT_DATA } from './paths.mjs'

const ROOT = process.env.E2E_ROOT || PT_DATA
const STATE = path.join(ROOT, 'state.json')
const NETLOG = path.join(ROOT, 'logs', 'net.jsonl')
const CORPUS = path.join(ROOT, 'corpus')
const SEED = process.env.E2E_SEED || e2e('corpus', 'docs')
const INDEX = 'cuttlely-test'
const CHUNK = { chunkSize: 200, chunkOverlap: 0 }

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {}
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2))
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-').toLowerCase()
function record(key, value) {
    state.evidence = state.evidence || {}
    state.evidence[key] = value
    save()
    log(`${key}:`, JSON.stringify(value, null, 2))
}

const requireComponents = createRequire(path.resolve('packages/components/package.json'))
const { RecursiveCharacterTextSplitter } = requireComponents('@langchain/textsplitters')
async function expectedChunks(text) {
    const pieces = await new RecursiveCharacterTextSplitter(CHUNK).splitText(text)
    return pieces.filter((p) => p.trim()).length
}

// Counts outbound calls the server made in a time window, from the preloaded network counter.
export function netCalls(fromIso, toIso) {
    if (!fs.existsSync(NETLOG)) return null
    const rows = fs
        .readFileSync(NETLOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((r) => r.t >= fromIso && r.t <= toIso)
    const sum = (list, key) => list.reduce((n, r) => n + (r[key] || 0), 0)
    const emb = rows.filter((r) => r.path.endsWith('/embeddings'))
    const ups = rows.filter((r) => r.path.endsWith('/vectors/upsert'))
    const dels = rows.filter((r) => r.path.endsWith('/vectors/delete'))
    return {
        embeddingCalls: emb.length,
        embeddingInputs: sum(emb, 'inputs'),
        embeddingTokens: emb.reduce((n, r) => n + (r.usage?.total_tokens || 0), 0),
        upsertCalls: ups.length,
        upsertVectors: sum(ups, 'vectors'),
        deleteCalls: dels.length,
        deleteIds: sum(dels, 'ids'),
        sequence: rows
            .filter((r) => /vectors\/(upsert|delete)|embeddings$/.test(r.path))
            .map(
                (r) =>
                    `${r.t.slice(11, 23)} ${r.path.split('/').pop()}${r.vectors ? `(${r.vectors})` : ''}${r.ids ? `(${r.ids})` : ''} ${
                        r.status
                    }`
            )
    }
}

async function pipelineFlow({ name, namespace, folder, sourceInputs = {} }) {
    const [openai, pinecone] = await Promise.all([credentialId('e2e-openai'), credentialId('e2e-pinecone')])
    const splitter = await buildNode('recursiveCharacterTextSplitter', 'recursiveCharacterTextSplitter_0', {
        inputs: { chunkSize: String(CHUNK.chunkSize), chunkOverlap: '0' }
    })
    const source = await buildNode('etlFileSource', 'etlFileSource_0', {
        inputs: { paths: folder, format: 'auto', include: '**/*.md, **/*.jsonl', ...sourceInputs }
    })
    const embeddings = await buildNode('openAIEmbeddings', 'openAIEmbeddings_0', {
        inputs: { modelName: 'text-embedding-3-small' },
        credential: openai
    })
    const store = await buildNode('pinecone', 'pinecone_0', {
        inputs: { pineconeIndex: INDEX, pineconeNamespace: namespace, topK: '4' },
        credential: pinecone,
        output: 'vectorStore'
    })
    const edges = [connect(splitter, source, 'textSplitter'), connect(source, store, 'document'), connect(embeddings, store, 'embeddings')]
    return { name, type: 'ETL', nodes: [splitter, source, embeddings, store], edges }
}

async function makePipeline(key, writeFiles, sourceInputs = {}) {
    const ts = stamp()
    const p = { ts, namespace: `pt-${key}-${ts}`, name: `pt-${key}-${ts}`, folder: path.join(CORPUS, `${key}-${ts}`) }
    fs.mkdirSync(p.folder, { recursive: true })
    writeFiles(p.folder)
    const saved = await upsertFlow(await pipelineFlow({ ...p, sourceInputs }))
    p.pipelineId = saved.id
    state[key] = p
    save()
    return p
}

async function runOnce(pipelineId, body = {}) {
    const started = new Date().toISOString()
    const run = await api('POST', `/etl/pipelines/${pipelineId}/runs`, body)
    const done = await waitRun(run.id)
    await sleep(1500)
    return { run: done, net: netCalls(started, new Date().toISOString()) }
}

function summary(run) {
    const c = run.counters || {}
    return {
        runId: run.id,
        status: run.status,
        mode: run.mode,
        attempt: run.attempt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        error: run.error || undefined,
        counters: {
            docsLoaded: c.docsLoaded,
            chunks: c.chunks,
            embedded: c.embedded,
            skipped: c.skipped,
            deleted: c.deleted,
            unitsTotal: c.unitsTotal,
            unitsSkipped: c.unitsSkipped,
            unitsFailed: c.unitsFailed,
            errors: c.errors,
            batches: c.batches
        },
        events: (run.events || []).map((e) => `${e.level} ${e.step || '-'} ${e.message}`)
    }
}

async function sourcesInNamespace(namespace) {
    const ids = await listIds(namespace)
    const vectors = await fetchVectors(namespace, ids)
    const bySource = {}
    for (const id of ids) {
        const src = path.basename(String(vectors[id]?.metadata?.source || '?'))
        ;(bySource[src] = bySource[src] || []).push(id)
    }
    return { ids, vectors, bySource }
}

const DOC_CHANGES = {
    'aurora-station.md': `# Aurora Station

Aurora Station is a fictional research outpost on the Kelvar Plateau. Its station chief is Dr. Mirela Okonkwo-Vance.
After the 2026 security review the station access code is AUR-9902. Aurora Station houses exactly 51 researchers during the winter season.
The station's backup generator is nicknamed "Old Brindle" and runs on hydrogen fuel cells.
`,
    'quill-ferry.md': `# Quill Ferry Line

The Quill Ferry Line connects the islands of Tessaly and Morrow Bay. As of the 2026 timetable the ferry departs Tessaly every 70 minutes.
Its flagship vessel is now the MV Copper Lantern, captained by Captain Rosalind Achterberg.
A one-way adult ticket costs 16.80 zorin. The ferry line was founded in 1987.
`,
    'zephyr-protocol.md': `# Zephyr Protocol

The Zephyr Protocol is a fictional network handshake designed by engineer Tobias Quarrington.
Since version 5.0 it uses port 50417 by default. The handshake completes in three phases called Kindle, Weave, and Seal.
The current protocol version is Zephyr 5.0, released under the codename "Silver Fern".
`
}

const HARBOR = [
    JSON.stringify({
        id: 'harbor-001',
        title: 'Harbor Lantern',
        text: 'The Harbor Lantern lighthouse keeper is Wendeline Osgood. The lighthouse beam code is HL-3307.'
    }),
    '{"id": "harbor-002", "title": "Broken record", "text": "this line is cut off',
    JSON.stringify({ id: 'harbor-003', title: 'Harbor Pier', text: 'Harbor Pier 9 has exactly 58 mooring cleats and was rebuilt in 2019.' })
]

function ledger(lines) {
    return `# Vantor depot ledger\n\n${lines.join('\n\n')}\n`
}

function controlDb() {
    const { DatabaseSync } = requireComponents('node:sqlite')
    return new DatabaseSync(path.join(ROOT, 'cuttlely', 'etl', 'etl.sqlite'), { readOnly: true })
}

const steps = {
    // A single 60-entry ledger, split into ~30 chunks, run in batches of 2 so a SIGKILL lands mid-run.
    async 'slow-build'() {
        const lines = []
        for (let i = 1; i <= 60; i += 1)
            lines.push(
                `Ledger entry ${i}: crate ${String(i).padStart(3, '0')} of the Vantor depot holds ${i * 7} brass gears and is tagged VD-${
                    1000 + i
                }.`
            )
        const p = await makePipeline('slow', (folder) => fs.writeFileSync(path.join(folder, 'vantor-ledger.md'), ledger(lines)))
        p.expected = await expectedChunks(ledger(lines))
        save()
        record('slowBuild', { namespace: p.namespace, pipelineId: p.pipelineId, expectedChunks: p.expected })
    },
    async 'kill-start'() {
        const p = state.slow
        const mode = process.argv[3] || 'incremental'
        const threshold = Number(process.argv[4] || 10)
        const run = await api('POST', `/etl/pipelines/${p.pipelineId}/runs`, { mode, settings: { batchSize: 2, concurrency: 1 } })
        p.killRun = { id: run.id, mode, startedAt: new Date().toISOString() }
        save()
        const db = controlDb()
        for (;;) {
            const n = db.prepare('SELECT COUNT(*) AS n FROM records WHERE pipeline_id = ? AND seen_run = ?').get(p.pipelineId, run.id).n
            if (Number(n) >= threshold) {
                console.log(`READY_TO_KILL run=${run.id} committedThisRun=${n}`)
                return
            }
            await new Promise((r) => setTimeout(r, 50))
        }
    },
    // Server is dead: read the control DB directly and Pinecone, exactly as the kill left them.
    async snapshot() {
        const p = state.slow
        const db = controlDb()
        const run = db.prepare('SELECT status, checkpoint, counters, attempt FROM runs WHERE id = ?').get(p.killRun.id)
        const records = Number(db.prepare('SELECT COUNT(*) AS n FROM records WHERE pipeline_id = ?').get(p.pipelineId).n)
        const thisRun = Number(
            db.prepare('SELECT COUNT(*) AS n FROM records WHERE pipeline_id = ? AND seen_run = ?').get(p.pipelineId, p.killRun.id).n
        )
        const counters = JSON.parse(run.counters)
        const allIds = db
            .prepare('SELECT chunk_id FROM records WHERE pipeline_id = ?')
            .all(p.pipelineId)
            .map((r) => r.chunk_id)
        const pcSeries = []
        const rounds = Number(process.env.E2E_SNAPSHOT_ROUNDS || 6)
        for (let i = 0; i < rounds; i += 1) {
            const fetched = await fetchVectors(p.namespace, allIds)
            const missing = allIds.filter((id) => !fetched[id])
            pcSeries.push({
                t: new Date().toISOString(),
                listed: (await listIds(p.namespace)).length,
                stats: await namespaceCount(p.namespace),
                fetchedOfRecords: Object.keys(fetched).length,
                missing
            })
            await sleep(5000)
        }
        const snap = {
            killedAt: p.killedAt,
            status: run.status,
            attempt: run.attempt,
            checkpoint: JSON.parse(run.checkpoint || 'null'),
            recordsTotal: records,
            recordsSeenThisRun: thisRun,
            persistedEmbedded: counters.embedded,
            persistedSkipped: counters.skipped,
            pineconeAfterKill: pcSeries,
            net: netCalls(p.killRun.startedAt, new Date().toISOString())
        }
        p.killRun.snapshot = snap
        save()
        record(`killSnapshot-${p.killRun.mode}`, snap)
    },
    // Upsert fails right after the adapter deleted the same ids; then a normal new incremental run (what Run or the next schedule tick does).
    async 'fail-after-delete'() {
        const p = state.slow
        const db = controlDb()
        const allIds = db
            .prepare('SELECT chunk_id FROM records WHERE pipeline_id = ?')
            .all(p.pipelineId)
            .map((r) => r.chunk_id)
        const check = async (label) => {
            const fetched = await fetchVectors(p.namespace, allIds)
            return {
                label,
                t: new Date().toISOString(),
                etlRecords: Number(db.prepare('SELECT COUNT(*) AS n FROM records WHERE pipeline_id = ?').get(p.pipelineId).n),
                pineconeFetchable: Object.keys(fetched).length,
                stats: await namespaceCount(p.namespace),
                missing: allIds.filter((id) => !fetched[id])
            }
        }
        const out = { before: await check('before') }
        const started = new Date().toISOString()
        const run = await api('POST', `/etl/pipelines/${p.pipelineId}/runs`, { mode: 'full', settings: { batchSize: 2, concurrency: 1 } })
        for (;;) {
            const n = Number(
                db.prepare('SELECT COUNT(*) AS n FROM records WHERE pipeline_id = ? AND seen_run = ?').get(p.pipelineId, run.id).n
            )
            if (n >= 6) break
            await sleep(50)
        }
        fs.writeFileSync(path.join(ROOT, 'fail-upsert-after-delete'), '')
        const failed = await waitRun(run.id, { until: ['completed', 'failed', 'cancelled'] })
        await sleep(8000)
        out.failedRun = summary(failed)
        out.afterFailedRun = await check('after failed full run')
        const next = await runOnce(p.pipelineId)
        await sleep(15000)
        out.nextIncrementalRun = summary(next.run)
        out.nextIncrementalNet = next.net
        out.afterNextIncremental = await check('after next incremental run')
        out.net = netCalls(started, new Date().toISOString())
        out.silentLoss = out.afterNextIncremental.missing.length > 0 && next.run.status === 'completed'
        record('failAfterDelete', out)
    },
    // Odd input: astral Unicode, RTL, a 10k value, nulls, duplicate JSON key, duplicate record id, more than 20 fields.
    async odd() {
        const big = 'B'.repeat(9990) + 'END-MARKER'
        const astralLong = 'a' + '\u{1F984}'.repeat(300)
        const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`f${String(i + 1).padStart(2, '0')}`, `v${i + 1}`]))
        const lines = [
            JSON.stringify({
                id: 'odd-astral',
                title: '\u{1D518}\u{1D52B}\u{1D526}\u{1D520}\u{1D52C}\u{1D521}\u{1D522} \u{1F9EA}\u{1F680} \u{1F469}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}',
                text: 'Astral plane test \u{1D49C}\u{1D4C8}\u{1D4C9}\u{1D4C7}\u{1D4B6}\u{1D4C1} unicorn \u{1F984} and ZWJ scientist \u{1F469}\u200D\u{1F52C}.'
            }),
            JSON.stringify({
                id: 'odd-rtl',
                title: '\u0645\u0631\u062D\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645',
                text: '\u05E9\u05DC\u05D5\u05DD \u05E2\u05D5\u05DC\u05DD and \u0645\u0631\u062D\u0628\u0627 mixed with LTR 123.',
                note: '\u202Eright-to-left override\u202C'
            }),
            JSON.stringify({ id: 'odd-long', title: 'Ten thousand', text: 'Record with a 10k character metadata value.', big }),
            JSON.stringify({
                id: 'odd-astral-long',
                title: 'Astral over 500',
                text: 'Record whose metadata value is 601 UTF-16 units of astral characters.',
                astral: astralLong
            }),
            JSON.stringify({ id: 'odd-null', title: null, text: 'Record with null metadata values.', tags: null, count: null }),
            '{"id": "odd-dupkey", "title": "first title", "title": "second title", "text": "Record with a duplicate JSON key."}',
            JSON.stringify({ id: 'odd-many', text: 'Record with 25 extra fields.', ...many }),
            JSON.stringify({ id: 'odd-astral', title: 'Duplicate record id', text: 'Second record that reuses the id odd-astral.' })
        ]
        // Optional comma list of record ids to leave out, so later records can be seen after an earlier one fails the batch.
        const skip = (process.argv[3] || '').split(',').filter(Boolean)
        const used = lines.filter((l) => !skip.some((id) => l.includes(`"id":"${id}"`) || l.includes(`"id": "${id}"`)))
        const key = skip.length ? `odd${skip.length + 1}` : 'odd'
        const p = await makePipeline(key, (folder) => fs.writeFileSync(path.join(folder, 'odd.jsonl'), used.join('\n') + '\n'), {
            idField: 'id'
        })
        const res = await runOnce(p.pipelineId)
        await settleCount(p.namespace, 1, 30000).catch(() => {})
        const { ids, vectors } = await sourcesInNamespace(p.namespace)
        const landed = ids.map((id) => {
            const m = vectors[id].metadata || {}
            const out = {}
            for (const [k, v] of Object.entries(m)) {
                if (typeof v === 'string' && v.length > 80) {
                    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v)
                    out[k] = {
                        length: v.length,
                        endsWithMarker: v.endsWith('END-MARKER'),
                        hasReplacementChar: v.includes('\uFFFD'),
                        loneSurrogate: lone,
                        head: v.slice(0, 24),
                        tail: v.slice(-12)
                    }
                } else out[k] = v
            }
            return { id, metadata: out }
        })
        landed.sort((a, b) => String(a.metadata.id || a.metadata.line).localeCompare(String(b.metadata.id || b.metadata.line)))
        record(key, {
            namespace: p.namespace,
            pipelineId: p.pipelineId,
            sourceLines: used.length,
            run: summary(res.run),
            net: res.net,
            vectors: ids.length,
            landed
        })
    },
    // Interval schedule every minute, full mode, each run made slower than the interval by delaying Pinecone upserts.
    async schedule() {
        const delayMs = Number(process.env.E2E_UPSERT_DELAY_MS || 75000)
        const watchMs = Number(process.env.E2E_WATCH_MS || 330000)
        const lines = []
        for (let i = 1; i <= 150; i += 1)
            lines.push(
                `Schedule ledger ${i}: bay ${String(i).padStart(3, '0')} of the Orvane yard stores ${i * 3} copper drums tagged OY-${
                    2000 + i
                }.`
            )
        const p = await makePipeline('sched', (folder) => fs.writeFileSync(path.join(folder, 'orvane-ledger.md'), ledger(lines)))
        const delayFile = path.join(ROOT, 'delay-upsert-ms')
        fs.writeFileSync(delayFile, String(delayMs))
        const created = await api('POST', `/etl/pipelines/${p.pipelineId}/schedules`, {
            kind: 'interval',
            every: 1,
            unit: 'minutes',
            mode: 'full'
        })
        const ticks = []
        let lastSeen = { nextRunAt: created.nextRunAt, lastResult: null, lastRunAt: null, lastReason: null }
        const t0 = Date.now()
        try {
            while (Date.now() - t0 < watchMs) {
                const sched = (await api('GET', `/etl/pipelines/${p.pipelineId}/schedules`)).find((s) => s.id === created.id)
                if (sched.nextRunAt !== lastSeen.nextRunAt) {
                    // The tick for lastSeen.nextRunAt happened between the previous poll and this one.
                    ticks.push({
                        dueAt: lastSeen.nextRunAt,
                        observedAt: new Date().toISOString(),
                        result: sched.lastResult,
                        reason: sched.lastReason,
                        lastRunId: sched.lastRunId,
                        lastRunAt: sched.lastRunAt
                    })
                }
                lastSeen = sched
                await sleep(1000)
            }
        } finally {
            await api('DELETE', `/etl/schedules/${created.id}`).catch(() => {})
            fs.rmSync(delayFile, { force: true })
        }
        const runs = (await api('GET', `/etl/pipelines/${p.pipelineId}/runs`)) || []
        const list = (Array.isArray(runs) ? runs : runs.data || []).map((r) => ({
            id: r.id,
            status: r.status,
            mode: r.mode,
            createdAt: r.createdAt,
            startedAt: r.startedAt,
            finishedAt: r.finishedAt
        }))
        list.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
        let overlaps = 0
        for (let i = 1; i < list.length; i += 1) if (list[i - 1].finishedAt && list[i].startedAt < list[i - 1].finishedAt) overlaps += 1
        for (const tick of ticks) {
            const run = list.find((r) => r.id === tick.lastRunId && tick.result !== 'skipped')
            if (run && tick.result !== 'skipped') tick.fireDelayMs = new Date(run.startedAt || run.createdAt) - new Date(tick.dueAt)
            tick.observeDelayMs = new Date(tick.observedAt) - new Date(tick.dueAt)
        }
        record('schedule', {
            namespace: p.namespace,
            pipelineId: p.pipelineId,
            scheduleId: created.id,
            upsertDelayMs: delayMs,
            firstDue: created.nextRunAt,
            ticks,
            runs: list,
            overlaps
        })
    },
    async 'resume-verify'() {
        const p = state.slow
        const run = await waitRun(p.killRun.id, { until: ['completed', 'failed', 'cancelled'] })
        await sleep(1500)
        const net = netCalls(p.killedAt, new Date().toISOString())
        const ids = await settleCount(p.namespace, p.expected)
        const db = controlDb()
        const recordIds = db
            .prepare('SELECT chunk_id FROM records WHERE pipeline_id = ? ORDER BY chunk_id')
            .all(p.pipelineId)
            .map((r) => r.chunk_id)
        const missing = recordIds.filter((id) => !ids.includes(id))
        const extra = ids.filter((id) => !recordIds.includes(id))
        const snap = p.killRun.snapshot
        record(`resume-${p.killRun.mode}`, {
            run: summary(run),
            netAfterRestart: net,
            expectedChunks: p.expected,
            pineconeIds: ids.length,
            pineconeUnique: new Set(ids).size,
            stats: await namespaceCount(p.namespace),
            etlRecords: recordIds.length,
            missingFromPinecone: missing.length,
            extraInPinecone: extra.length,
            embeddedAfterRestart: net?.embeddingInputs,
            uncommittedAtKill: p.expected - (p.killRun.mode === 'full' ? snap.recordsSeenThisRun : snap.recordsTotal),
            formula: 'embeddedAfterRestart should equal uncommittedAtKill (+ at most one in-flight batch of 2)'
        })
    },
    // Main pipeline: 5 markdown docs + a JSONL feed with one malformed line. Reconciliation: expected chunks vs Pinecone + rejected rows.
    async main() {
        const p = await makePipeline('main', (folder) => {
            for (const f of fs.readdirSync(SEED)) fs.copyFileSync(path.join(SEED, f), path.join(folder, f))
            fs.writeFileSync(path.join(folder, 'harbor-feed.jsonl'), HARBOR.join('\n') + '\n')
        })
        let expected = 0
        const perDoc = {}
        for (const f of fs.readdirSync(p.folder).filter((f) => f.endsWith('.md'))) {
            perDoc[f] = await expectedChunks(fs.readFileSync(path.join(p.folder, f), 'utf8'))
            expected += perDoc[f]
        }
        for (const line of HARBOR) {
            try {
                const obj = JSON.parse(line)
                perDoc[`harbor-feed.jsonl#${obj.id}`] = await expectedChunks(obj.text)
                expected += perDoc[`harbor-feed.jsonl#${obj.id}`]
            } catch {
                /* the malformed line */
            }
        }
        const { run, net } = await runOnce(p.pipelineId)
        const ids = await settleCount(p.namespace, expected)
        const stats = await namespaceCount(p.namespace)
        const rejected = (run.events || []).filter((e) => e.level === 'warn' && /not valid JSON/.test(e.message)).length
        const sourceRows = 5 + HARBOR.length
        record('reconciliation', {
            namespace: p.namespace,
            pipelineId: p.pipelineId,
            run: summary(run),
            net,
            sourceRows,
            rowsWritten: run.counters.docsLoaded,
            rejectedRows: rejected,
            expectedChunksFromSplitter: expected,
            perDoc,
            pineconeDescribeStats: stats,
            pineconeListedIds: ids.length,
            reconciles: stats === expected && run.counters.docsLoaded + rejected === sourceRows
        })
    },
    async nochange() {
        const p = state.main
        const before = await listIds(p.namespace)
        const { run, net } = await runOnce(p.pipelineId)
        const after = await listIds(p.namespace)
        record('noChange', {
            run: summary(run),
            net,
            idsBefore: before.length,
            idsAfter: after.length,
            idsIdentical: JSON.stringify(before) === JSON.stringify(after)
        })
    },
    async change3() {
        const p = state.main
        const before = await sourcesInNamespace(p.namespace)
        for (const [f, text] of Object.entries(DOC_CHANGES)) fs.writeFileSync(path.join(p.folder, f), text)
        const { run, net } = await runOnce(p.pipelineId)
        const after = await sourcesInNamespace(p.namespace)
        const beforeSet = new Set(before.ids)
        const afterSet = new Set(after.ids)
        const perDoc = {}
        for (const src of new Set([...Object.keys(before.bySource), ...Object.keys(after.bySource)])) {
            const b = before.bySource[src] || []
            const a = after.bySource[src] || []
            perDoc[src] = {
                before: b.length,
                after: a.length,
                kept: a.filter((id) => beforeSet.has(id)).length,
                new: a.filter((id) => !beforeSet.has(id)).length,
                removed: b.filter((id) => !afterSet.has(id)).length
            }
        }
        const reembeddedDocs = Object.entries(perDoc)
            .filter(([, v]) => v.new > 0)
            .map(([k]) => k)
        record('change3', { run: summary(run), net, perDoc, reembeddedDocs, total: after.ids.length })
    },
    async delete() {
        const p = state.main
        const target = path.join(p.folder, 'marrow-bakery.md')
        const before = await queryByFilter(p.namespace, { source: { $eq: target } })
        fs.rmSync(target)
        const { run, net } = await runOnce(p.pipelineId)
        await sleep(5000)
        const afterQuery = await queryByFilter(p.namespace, { source: { $eq: target } })
        const all = await sourcesInNamespace(p.namespace)
        const detail = await api('GET', `/etl/pipelines/${p.pipelineId}`)
        record('delete', {
            run: summary(run),
            net,
            deletedDoc: 'marrow-bakery.md',
            vectorsForDocBefore: before.length,
            vectorsForDocAfter_filterQuery: afterQuery.length,
            vectorsForDocAfter_fullScan: (all.bySource['marrow-bakery.md'] || []).length,
            namespaceTotal: all.ids.length,
            etlRecords: detail.stats.chunks,
            orphans: all.ids.length - detail.stats.chunks
        })
    }
}

const step = process.argv[2]
if (!steps[step]) {
    console.error(`unknown step ${step}; one of ${Object.keys(steps).join(', ')}`)
    process.exit(2)
}
await steps[step]()
