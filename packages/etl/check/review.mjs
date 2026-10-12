// etl:check, pipeline review findings: `partial` and the reject-ratio gate (O9, spec 5.3.3), legacy records
// under a partial run (O6), store error classes with the status-code fallback (5.4), O3 read roots with
// CUTTLELY_ETL_ROOTS unset (case 43), duplicate keys across a resume boundary, the runaway-quote cut (v1.3.4), and a
// record-class embedding error failing the run.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { api, check, root, WS } from './lib.mjs'

const { stmt } = await import('../db.mjs')
const { createFake, shapeFor } = await import('../store-adapter.mjs')
const { LocalVectorStore } = await import('../stores.mjs')
const { classifyStoreError, PINECONE_ERROR_CLASSES } = await import('../store-errors.mjs')
const { checkUploadAccess, pathAccess, repoDataExcludes, samplesRoot, workspaceUploadsRoot } = await import('../paths.mjs')
// What Streaming Files does with one path: the read-root check, then the per-workspace upload check.
const checkPathForFiles = (target) => {
    const resolved = pathAccess(target, { workspaceId: WS }).path
    checkUploadAccess(resolved, WS)
    return resolved
}
const { repoFiles } = await import('../sources.mjs')
const { repoRoot, dataRoot } = await import('@cuttlely/harness/paths.mjs')
const { nodeInstance, initNode } = await import('../nodes.mjs')

const R = path.join(root, 'review')
fs.mkdirSync(R, { recursive: true })
const json = (value) => JSON.stringify(value)
const write = (name, lines) => {
    const file = path.join(R, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Array.isArray(lines) ? lines.join('\n') + '\n' : lines)
    const t = new Date(Date.now() + 5000 + Math.floor(Math.random() * 100000))
    fs.utimesSync(file, t, t)
    return file
}
const outcome = (fn) => {
    try {
        return { ok: true, value: fn() }
    } catch (error) {
        return { ok: false, code: error.code, message: error.message }
    }
}
const served = (id) => stmt('SELECT served_version FROM pipelines WHERE id = ?').get(id)?.served_version ?? null
const brief = (d) => json({ status: d.status, error: d.error, summary: d.summary && { ...d.summary, nodes: undefined } })

// A local-store flow; `transform` adds a Clean & Transform node (its inputs change the version).
const localFlow = (file, collection, inputs = {}, transform = null) => {
    const nodes = [
        {
            id: 'src',
            data: {
                name: 'etlFileSource',
                label: 'Streaming Files',
                category: 'ETL',
                inputs: { paths: file, textColumns: 'name, notes', idColumn: 'sku', ...inputs }
            }
        },
        {
            id: 'emb',
            data: { name: 'localHashEmbeddings', label: 'Local Hash Embeddings', category: 'Embeddings', inputs: { dimensions: 32 } }
        },
        { id: 'vs', data: { name: 'etlLocalVectorStore', label: 'Local Vector Store', category: 'Vector Stores', inputs: { collection } } }
    ]
    const edges = [{ source: 'emb', target: 'vs' }]
    if (transform) {
        nodes.push({ id: 'tx', data: { name: 'etlTransform', label: 'Clean & Transform', category: 'ETL', inputs: transform } })
        edges.push({ source: 'src', target: 'tx' }, { source: 'tx', target: 'vs' })
    } else edges.push({ source: 'src', target: 'vs' })
    return { nodes, edges }
}
// The same flow writing to a fake Pinecone with a test embeddings model.
const pineFlow = (file, namespace) => ({
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
        { id: 'emb', data: { name: 'openAIEmbeddings', label: 'OpenAI Embedding', category: 'Embeddings', inputs: { modelName: 'fake' } } },
        {
            id: 'vs',
            data: {
                name: 'pinecone',
                label: 'Pinecone',
                category: 'Vector Stores',
                inputs: { pineconeIndex: 'cuttlely-test', pineconeNamespace: namespace },
                credential: 'pine-cred'
            }
        }
    ],
    edges: [
        { source: 'src', target: 'vs' },
        { source: 'emb', target: 'vs' }
    ]
})
const testEmbedder = (onTexts = null) => ({
    calls: 0,
    async embedDocuments(texts) {
        this.calls += 1
        if (onTexts) onTexts(texts)
        return texts.map((text) => [(text.length % 7) + 1, 1, 0.5])
    },
    async embedQuery() {
        return [1, 1, 0.5]
    }
})
let clock = 0
const fast = { now: () => clock, sleep: async (ms) => (clock += ms) }

async function runFlow(id, flowData, { mode = 'incremental', settings = {}, ctx = {} } = {}) {
    api.configureRunner({ contextFor: () => ({ storeCountSettle: fast, flowOptions: {}, ...ctx }) })
    const saved = api.recordVersion({ workspaceId: WS, id, name: id, flowData })
    if (saved.problems.length) return { problems: saved.problems }
    const started = api.startRun(id, { mode, settings: { batchSize: 16, concurrency: 1, maxRetries: 2, maxErrors: 100000, ...settings } })
    let detail = api.runDetail(started.id)
    while (['queued', 'running', 'pausing', 'cancelling'].includes(detail.status)) {
        await api.waitForIdle()
        await new Promise((resolve) => setImmediate(resolve))
        detail = api.runDetail(started.id)
    }
    return { ...detail, version: started.version }
}
const vectors = (collection) =>
    LocalVectorStore.open(collection)
        .db.prepare('SELECT id, content, metadata FROM vectors')
        .all()
        .map((row) => ({ id: row.id, content: row.content, metadata: JSON.parse(row.metadata || '{}') }))
// N rows; `bad` holds the row numbers whose key is blank (missing_key).
const rows = (n, bad = new Set(), note = 'kit') => [
    'sku,name,notes',
    ...Array.from({ length: n }, (_, i) => `${bad.has(i) ? '' : `R${i}`},Item ${i},${note} ${i}`)
]
const firstN = (n) => new Set(Array.from({ length: n }, (_, i) => i))

// ---------------------------------------------------------------------------------------------------------------
// MUST-FIX 1: `partial` (spec 5.3.3) and the maxRejectRatio gate (O9).
{
    // Under 100 reads the ratio is not applied: 99 reads with 50 rejected is partial, and it is served.
    const small = await runFlow('rv-ratio-99', localFlow(write('ratio-99.csv', rows(99, firstN(50))), 'rv-ratio-99'))
    check(
        'O9 boundary: 99 reads with 50 rejected (over the ratio, under 100 reads) ends partial and is served',
        small.status === 'partial' &&
            small.summary.read === 99 &&
            small.summary.rejected.total === 50 &&
            served('rv-ratio-99') === small.version,
        brief(small)
    )

    // A clean v1, then v2 with 6 of 100 rejected: failed, nothing swept, v1 still served; the next run re-reads.
    const file = write('ratio.csv', rows(100))
    const v1 = await runFlow('rv-ratio', localFlow(file, 'rv-ratio'))
    const before = vectors('rv-ratio').length
    write('ratio.csv', rows(100, firstN(6), 'tent'))
    const over = await runFlow('rv-ratio', localFlow(file, 'rv-ratio', {}, { minChars: 2 }))
    const kept = vectors('rv-ratio')
    check(
        'O9 gate: 100 reads with 6 rejected (6% > 5%) ends failed / reject_ratio_exceeded, deletes nothing (all 100 v1 vectors stay) and leaves v1 served',
        v1.status === 'succeeded' &&
            before === 100 &&
            over.status === 'failed' &&
            /^reject_ratio_exceeded/.test(over.error || '') &&
            /6 of 100 records were rejected/.test(over.error || '') &&
            kept.filter((v) => /\bkit \d+$/.test(v.content)).length === 100 &&
            served('rv-ratio') === v1.version &&
            over.version === v1.version + 1,
        json({ v1: brief(v1), over: brief(over), kept: kept.length, served: served('rv-ratio') })
    )

    // The failed run restored the source fingerprints, so the same file is read again in full. maxRejectRatio is a run
    // setting: 0.5 lets the same 6 of 100 through as partial.
    const loose = await runFlow('rv-ratio', localFlow(file, 'rv-ratio', {}, { minChars: 2 }), { settings: { maxRejectRatio: 0.5 } })
    check(
        'O9 setting: after the failed run the unchanged file is re-read in full, and maxRejectRatio 0.5 makes 6 of 100 rejected partial (served); the default is 0.05',
        loose.status === 'partial' &&
            loose.summary.read === 100 &&
            served('rv-ratio') === loose.version &&
            loose.settings?.maxRejectRatio === 0.5 &&
            over.settings?.maxRejectRatio === 0.05,
        json({ loose: brief(loose), settings: loose.settings, overSettings: over.settings })
    )

    // 5 of 100 is at the limit, not over it: partial and served, and the sweep runs.
    write('ratio.csv', rows(100, firstN(5), 'tarp'))
    const at = await runFlow('rv-ratio', localFlow(file, 'rv-ratio', {}, { minChars: 2 }))
    check(
        'O9 boundary: 100 reads with 5 rejected (exactly 5%) ends partial and is served, and the sweep runs',
        at.status === 'partial' &&
            at.summary.read === 100 &&
            at.summary.rejected.byReason.missing_key === 5 &&
            served('rv-ratio') === at.version &&
            vectors('rv-ratio').length === 95,
        json({ at: brief(at), served: served('rv-ratio'), stored: vectors('rv-ratio').length })
    )

    // No rejects and no failed units: succeeded, and the summary carries possibleDuplicates: false.
    const clean = await runFlow('rv-clean', localFlow(write('clean.csv', rows(3)), 'rv-clean'))
    check(
        '5.3.3: a run with nothing rejected ends succeeded and its summary says possibleDuplicates false',
        clean.status === 'succeeded' && clean.summary.possibleDuplicates === false,
        brief(clean)
    )
}

// ---------------------------------------------------------------------------------------------------------------
// MUST-FIX 11: legacy records (doc_key NULL, written before record keys) are swept only by a run that ends succeeded.
{
    const header = 'sku,name,notes,qty'
    const line = (i, qty = i) => `L${i},Lamp ${i},brass ${i},${qty}`
    const file = write('legacy.csv', [header, ...Array.from({ length: 10 }, (_, i) => line(i))])
    const schema = json({ fields: { qty: 'integer' } })
    const flow = localFlow(file, 'rv-legacy', { schema })
    const first = await runFlow('rv-legacy', flow)
    // The upgrade: rows from before E8 have no doc_key.
    stmt('UPDATE records SET doc_key = NULL WHERE pipeline_id = ?').run('rv-legacy')
    const oldL3 = vectors('rv-legacy').find((v) => v.content.includes('Lamp 3'))
    // A partial run: L3 is rejected (qty is not an integer), the other rows change.
    write('legacy.csv', [header, ...Array.from({ length: 10 }, (_, i) => (i === 3 ? line(3, 'lots') : `L${i},Lamp ${i},copper ${i},${i}`))])
    const partial = await runFlow('rv-legacy', flow)
    const after = vectors('rv-legacy')
    check(
        'O6 legacy: after the upgrade, a partial run with one rejected key keeps the NULL-doc_key rows (staleKept, legacyKept) and the old L3 vector is still served',
        first.status === 'succeeded' &&
            partial.status === 'partial' &&
            partial.summary.rejected.total === 1 &&
            Boolean(oldL3) &&
            after.some((v) => v.id === oldL3.id && v.content === oldL3.content) &&
            partial.summary.staleKept >= 1 &&
            partial.counters.legacyKept >= 1 &&
            served('rv-legacy') === partial.version,
        json({ partial: brief(partial), legacyKept: partial.counters.legacyKept, oldL3: oldL3?.id, after: after.length })
    )
    // A run that ends succeeded sweeps legacy rows nobody saw: L9 is gone from the file.
    stmt('UPDATE records SET doc_key = NULL WHERE pipeline_id = ?').run('rv-legacy')
    write('legacy.csv', [header, ...Array.from({ length: 9 }, (_, i) => `L${i},Lamp ${i},copper ${i},${i}`)])
    const ok = await runFlow('rv-legacy', flow)
    const final = vectors('rv-legacy')
    check(
        'O6 legacy: a run that ends succeeded sweeps the legacy rows it did not see',
        ok.status === 'succeeded' && !final.some((v) => v.content.includes('Lamp 9')) && !final.some((v) => v.content.includes('brass')),
        json({ ok: brief(ok), final: final.map((v) => v.content) })
    )
}

// ---------------------------------------------------------------------------------------------------------------
// MUST-FIX 3: store error classes. One fixture per class of the pinned Pinecone client, built from the real SDK classes,
// and one unknown name per status bucket.
{
    const require = createRequire(path.join(repoRoot(), 'packages', 'components', 'package.json'))
    const pkg = require('@pinecone-database/pinecone/package.json')
    const { Errors } = require('@pinecone-database/pinecone')
    const request = { url: 'https://idx.svc.pinecone.io/vectors/upsert', status: 400, message: 'injected', body: '{}' }
    const make = (name) => {
        const Class = Errors[name]
        if (!Class) return null
        if (name === 'PineconeConnectionError') return new Class(new Error('ECONNRESET'), request.url)
        if (/Http|BadRequest|Authorization|NotFound|Conflict|InternalServer|NotImplemented/.test(name)) return new Class(request)
        return new Class('injected')
    }
    const expected = {
        PineconeBadRequestError: 'record',
        PineconeArgumentError: 'record',
        PineconeAuthorizationError: 'config',
        PineconeNotFoundError: 'config',
        PineconeConfigurationError: 'config',
        PineconeEnvironmentVarsNotSupportedError: 'config',
        PineconeUnableToResolveHostError: 'config',
        PineconeNotImplementedError: 'config',
        PineconeConflictError: 'fatal',
        PineconeUnexpectedResponseError: 'fatal',
        PineconeInternalServerError: 'transient',
        PineconeConnectionError: 'transient'
    }
    check('5.4 classes: the pinned Pinecone client is exactly 4.0.0', pkg.version === '4.0.0', pkg.version)
    for (const [name, kind] of Object.entries(expected)) {
        const error = make(name)
        check(
            `5.4 classes: ${name} (no status field) is ${kind}`,
            error &&
                error.name === name &&
                error.status === undefined &&
                classifyStoreError(error) === kind &&
                PINECONE_ERROR_CLASSES[name] === kind,
            json({ name: error?.name, status: error?.status, got: error && classifyStoreError(error) })
        )
    }
    const unknown = (status) => Object.assign(new Error('injected'), { name: 'SomeStoreError', status })
    const buckets = { record: [400, 413, 422], config: [401, 403, 404], transient: [408, 500, 502, 503, 504], rate_limit: [429] }
    for (const [kind, statuses] of Object.entries(buckets)) {
        for (const status of statuses) {
            check(
                `5.4 fallback: an unknown error name with status ${status} is ${kind}`,
                classifyStoreError(unknown(status)) === kind,
                classifyStoreError(unknown(status))
            )
        }
    }
    const unmapped = new Errors.PineconeUnmappedHttpError({ ...request, status: 413 })
    const unmapped429 = new Errors.PineconeUnmappedHttpError({ ...request, status: 429 })
    const unmapped503 = new Errors.PineconeUnmappedHttpError({ ...request, status: 503 })
    check(
        '5.4 fallback: PineconeUnmappedHttpError reads its status from the message (413 record, 429 rate_limit, 503 transient)',
        classifyStoreError(unmapped) === 'record' &&
            classifyStoreError(unmapped429) === 'rate_limit' &&
            classifyStoreError(unmapped503) === 'transient',
        json([unmapped.message, classifyStoreError(unmapped), classifyStoreError(unmapped429), classifyStoreError(unmapped503)])
    )
    check(
        '5.4 fallback: an unknown name with no status and no network text is fatal; status 409 is fatal',
        classifyStoreError(new Error('weird')) === 'fatal' && classifyStoreError(unknown(409)) === 'fatal',
        classifyStoreError(new Error('weird'))
    )

    // The classes drive the run: config fails at once with no retry, record is bisected and rejected, transient and
    // rate_limit are retried.
    const fakeStore = (fail) => {
        const fake = createFake(shapeFor('pinecone'))
        const real = fake.upsert.bind(fake)
        const t = { fake, upserts: 0 }
        fake.upsert = async (records) => {
            t.upserts += 1
            const error = fail(records, t.upserts)
            if (error) throw error
            return real(records)
        }
        return t
    }
    const file = write('classes.csv', rows(6))
    const ctxFor = (t) => ({ embeddingsDouble: testEmbedder(), storeClients: { pinecone: t.fake } })
    const config = fakeStore(() => unknown(401))
    const configRun = await runFlow('rv-class-config', pineFlow(file, 'rv-class-config'), { ctx: ctxFor(config) })
    check(
        '5.4 run: an unknown-name 401 from the store fails the run at once as store_config (no retry, no bisection)',
        configRun.status === 'failed' &&
            /^store_config/.test(configRun.error || '') &&
            /HTTP 401/.test(configRun.error || '') &&
            config.upserts === 1,
        json({ run: brief(configRun), upserts: config.upserts })
    )
    const record = fakeStore((records) =>
        records.some((r) => /Item 2\b/.test(r.metadata?.text || r.metadata?.pageContent || JSON.stringify(r))) ? unknown(413) : null
    )
    const recordRun = await runFlow('rv-class-record', pineFlow(file, 'rv-class-record'), { ctx: ctxFor(record) })
    check(
        '5.4 run: an unknown-name 413 is bisected down to its record, which is rejected store_rejected; the rest is written',
        recordRun.status === 'partial' &&
            recordRun.summary.rejected.byReason.store_rejected === 1 &&
            recordRun.summary.written.inserted === 5,
        json({ run: brief(recordRun), upserts: record.upserts })
    )
    const transient = fakeStore((records, n) =>
        n === 1 ? new Errors.PineconeInternalServerError(request) : n === 2 ? unknown(503) : n === 3 ? unknown(429) : null
    )
    const transientRun = await runFlow('rv-class-transient', pineFlow(file, 'rv-class-transient'), {
        ctx: ctxFor(transient),
        settings: { maxRetries: 3 }
    })
    check(
        '5.4 run: a PineconeInternalServerError (no status), an unknown-name 503 and a 429 are each retried and the run succeeds',
        transientRun.status === 'succeeded' && transient.upserts === 4 && transientRun.summary.written.inserted === 6,
        json({ run: brief(transientRun), upserts: transient.upserts })
    )

    // The store preflight (describeIndexStats before the first read). It sends no records, so a bad-request-class error
    // there is configuration: Pinecone 4.0.0 throws PineconeBadRequestError for a 403. Transient errors keep the retry.
    const preflightStore = (fail) => {
        const t = fakeStore(() => null)
        const real = t.fake.describeIndexStats.bind(t.fake)
        t.stats = 0
        t.fake.describeIndexStats = async () => {
            t.stats += 1
            const error = fail(t.stats)
            if (error) throw error
            return real()
        }
        return t
    }
    const forbidden = preflightStore(() => new Errors.PineconeBadRequestError({ ...request, status: 403, message: 'Forbidden' }))
    const forbiddenRun = await runFlow('rv-preflight-403', pineFlow(file, 'rv-preflight-403'), { ctx: ctxFor(forbidden) })
    check(
        'preflight: a 403 at the preflight (the SDK throws PineconeBadRequestError) fails the run as store_config with 0 reads, no retry and no upsert',
        forbiddenRun.status === 'failed' &&
            /^store_config: the vector store refused the preflight check \(describeIndexStats\) \(PineconeBadRequestError\)/.test(
                forbiddenRun.error || ''
            ) &&
            (forbiddenRun.summary?.read ?? 0) === 0 &&
            forbiddenRun.counters.docsLoaded === 0 &&
            forbidden.stats === 1 &&
            forbidden.upserts === 0,
        json({ run: brief(forbiddenRun), stats: forbidden.stats, upserts: forbidden.upserts, docs: forbiddenRun.counters.docsLoaded })
    )
    const flaky = preflightStore((n) => (n === 1 ? unknown(503) : null))
    const flakyRun = await runFlow('rv-preflight-503', pineFlow(file, 'rv-preflight-503'), { ctx: ctxFor(flaky) })
    check(
        'preflight: a 503 at the preflight is retried, then the run proceeds and succeeds',
        flakyRun.status === 'succeeded' && flaky.stats >= 2 && flakyRun.summary.read === 6 && flakyRun.summary.written.inserted === 6,
        json({ run: brief(flakyRun), stats: flaky.stats })
    )
    const down = preflightStore(() => unknown(503))
    const downRun = await runFlow('rv-preflight-down', pineFlow(file, 'rv-preflight-down'), {
        ctx: ctxFor(down),
        settings: { maxRetries: 1 }
    })
    check(
        'preflight: a 503 that outlasts the retries fails the run with the store error (not store_config) and 0 reads',
        downRun.status === 'failed' &&
            !/^store_config/.test(downRun.error || '') &&
            down.stats === 2 &&
            (downRun.summary?.read ?? 0) === 0 &&
            down.upserts === 0,
        json({ run: brief(downRun), stats: down.stats })
    )
}

// ---------------------------------------------------------------------------------------------------------------
// FOLLOW-UP 2: until E10 bisects embeddings, a record-class embedding error fails the run loudly, never silently.
{
    const fake = createFake(shapeFor('pinecone'))
    const embedder = testEmbedder((texts) => {
        if (texts.some((text) => text.includes('Item 4')))
            throw Object.assign(new Error('Invalid input: token limit (injected)'), { status: 400 })
    })
    const file = write('embed400.csv', rows(8))
    const first = await runFlow('rv-embed-400', pineFlow(file, 'rv-embed-400'), {
        ctx: { embeddingsDouble: embedder, storeClients: { pinecone: fake } },
        settings: { batchSize: 4 }
    })
    check(
        'E10 gate: a record-class (400) embedding error fails the run with the error text, unretried and unserved; nothing is marked rejected',
        first.status === 'failed' &&
            /token limit \(injected\)/.test(first.error || '') &&
            first.counters.retries === 0 &&
            served('rv-embed-400') === null &&
            !(first.summary?.rejected?.total > 0),
        brief(first)
    )
}

// ---------------------------------------------------------------------------------------------------------------
// ACCEPTED 7 (spec v1.3.4): a runaway quote past maxRecordBytes is cut at its first physical line, rejected
// row_too_large, and every later line is read as its own record.
{
    const later = Array.from({ length: 30 }, (_, i) => `C${i},Gear ${i},line ${i} of the rest of the file`)
    const file = write('runaway.csv', ['sku,name,notes', 'A1,Alpha,fine', 'B2,"Runaway name,never closed', ...later])
    const detail = await runFlow('rv-runaway', localFlow(file, 'rv-runaway', { schema: json({ maxRecordBytes: 256 }) }))
    const stored = vectors('rv-runaway')
    check(
        'v1.3.4 runaway quote: the open quote is cut at its first line (row_too_large), and all 30 later lines are records; the ledger balances',
        detail.status === 'partial' &&
            detail.summary.read === 32 &&
            detail.summary.rejected.total === 1 &&
            detail.summary.rejected.byReason.row_too_large === 1 &&
            detail.summary.written.inserted === 31 &&
            later.every((_, i) => stored.some((v) => v.content.includes(`Gear ${i}\n`) || v.content.startsWith(`Gear ${i}`))),
        json({ detail: brief(detail), stored: stored.length })
    )
}

// ---------------------------------------------------------------------------------------------------------------
// ACCEPTED 6: duplicate keys across a resume boundary. The resumed run's store equals a clean run's store, and the
// duplicate counter is the same (first wins, O5).
{
    // 200 keys, then the first 10 again at the end: the run pauses after about 20 chunks, so each first copy is
    // committed before the boundary and each duplicate is read after the resume.
    const lines = [
        'sku,name,notes',
        ...Array.from({ length: 200 }, (_, i) => `D${i},Duo ${i},first copy ${i}`),
        ...Array.from({ length: 10 }, (_, i) => `D${i},Duo ${i},second copy ${i}`)
    ]
    const cleanFile = write('dup-clean/dup.csv', lines)
    const resumeFile = write('dup-resume/dup.csv', lines)
    const clean = await runFlow('rv-dup-clean', localFlow(cleanFile, 'rv-dup-clean'), { settings: { batchSize: 10 } })
    api.configureRunner({ contextFor: () => ({ flowOptions: {} }) })
    api.recordVersion({ workspaceId: WS, id: 'rv-dup-resume', name: 'rv-dup-resume', flowData: localFlow(resumeFile, 'rv-dup-resume') })
    const { executeRun } = await import('../execute.mjs')
    const { insertRun, updateRun } = await import('../runs.mjs')
    const run = insertRun({
        pipelineId: 'rv-dup-resume',
        version: 1,
        mode: 'incremental',
        settings: { batchSize: 10, concurrency: 1, maxRetries: 1, maxErrors: 100000 }
    })
    // The ledger fault point runs at each batch commit; it asks for a pause after the second batch.
    const control = { stopRequested: null, abort: new AbortController() }
    const faults = { ledger: (batch) => (batch.seq === 1 ? (control.stopRequested = 'pause') : null) && null }
    const running = executeRun(run.id, { control, ctx: { flowOptions: {}, faults } })
    await running
    const interrupted = api.runDetail(run.id)
    updateRun(run.id, { status: 'running' })
    const { resumeInterruptedRuns, waitForIdle } = await import('../runner.mjs')
    resumeInterruptedRuns()
    await waitForIdle()
    const resumed = api.runDetail(run.id)
    const shape = (collection) =>
        vectors(collection)
            // Everything but the chunk id (it hashes the pipeline id) and the folder name, which differ by design.
            .map(
                (v) =>
                    `${v.content}|${json(Object.fromEntries(Object.entries(v.metadata).filter(([, value]) => value !== v.id))).replaceAll(
                        collection.slice(3),
                        'X'
                    )}`
            )
            .sort()
            .join('\n')
    check(
        '#6 resume: duplicate keys across a resume boundary leave the same store as a clean run, with the same duplicate_key count',
        interrupted.status === 'paused' &&
            interrupted.counters.embedded > 0 &&
            interrupted.counters.embedded < 190 &&
            resumed.status === 'partial' &&
            clean.status === 'partial' &&
            shape('rv-dup-resume') === shape('rv-dup-clean') &&
            vectors('rv-dup-resume').length === 200 &&
            resumed.summary.rejected.byReason.duplicate_key === 10 &&
            clean.summary.rejected.byReason.duplicate_key === 10 &&
            resumed.summary.read === 210 &&
            resumed.counters.embedded === 200,
        json({
            interrupted: interrupted.counters.embedded,
            embedded: resumed.counters.embedded,
            a: shape('rv-dup-resume').slice(0, 300),
            b: shape('rv-dup-clean').slice(0, 300),
            resumed: brief(resumed)
        })
    )
}

// ---------------------------------------------------------------------------------------------------------------
// MUST-FIX 5 / O3 (case 43): with CUTTLELY_ETL_ROOTS unset, reads are allowed only under this workspace's uploads,
// samples/etl, and (Code Repository only) the Cuttlely checkout outside its data folder, all realpath-resolved.
{
    const saved = process.env.CUTTLELY_ETL_ROOTS
    const other = 'ws-review-other'
    const own = workspaceUploadsRoot(WS)
    const upload = path.join(own, 'rv-o3', 'u1', 'mine.csv')
    const theirs = path.join(workspaceUploadsRoot(other), 'p', 'u2', 'theirs.csv')
    const outside = path.join(R, 'outside')
    for (const file of [upload, theirs, path.join(outside, 'secret.csv')]) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, 'sku,name,notes\nS1,Secret,do not read\n')
    }
    const link = path.join(own, 'rv-o3', 'escape')
    const etcLink = path.join(own, 'rv-o3', 'etc')
    fs.rmSync(link, { force: true })
    fs.rmSync(etcLink, { force: true })
    fs.symlinkSync(outside, link)
    fs.symlinkSync('/etc', etcLink)
    let results
    let run
    try {
        delete process.env.CUTTLELY_ETL_ROOTS
        const access = (target, options = { workspaceId: WS }) => outcome(() => pathAccess(target, options))
        results = {
            etc: access('/etc/hosts'),
            theirs: access(theirs),
            symlinkDir: access(path.join(link, 'secret.csv')),
            symlinkEtc: access(path.join(etcLink, 'hosts')),
            dotdot: access(`${own}/rv-o3/../../${other}/p/u2/theirs.csv`),
            relative: access('etl/db.mjs'),
            mine: access(upload),
            sample: access(path.join(samplesRoot(), 'data', 'outdoor-catalog.csv')),
            repoAsFiles: access(path.join(repoRoot(), 'etl', 'db.mjs')),
            repoAsRepo: access(path.join(repoRoot(), 'etl'), { workspaceId: WS, repo: true }),
            dataAsRepo: access(dataRoot(), { workspaceId: WS, repo: true }),
            noWorkspace: access(upload, {})
        }
        run = await runFlow('rv-o3-etc', localFlow('/etc/hosts', 'rv-o3-etc'))
        results.mineRun = await runFlow('rv-o3', localFlow(upload, 'rv-o3'))
    } finally {
        if (saved === undefined) delete process.env.CUTTLELY_ETL_ROOTS
        else process.env.CUTTLELY_ETL_ROOTS = saved
    }
    const refusedSource = (r) => !r.ok && r.code === 'bad_source' && /CUTTLELY_ETL_ROOTS/.test(r.message)
    check(
        'O3 case 43: roots unset, /etc/hosts is refused bad_source and the message says to set CUTTLELY_ETL_ROOTS',
        refusedSource(results.etc),
        json(results.etc)
    )
    check(
        'O3 case 43: roots unset, a run reading /etc/hosts fails bad_source before reading anything',
        run.status === 'failed' && /outside the folders pipelines may read/.test(run.error || '') && !(run.summary?.read > 0),
        brief(run)
    )
    check("O3 case 43: roots unset, workspace A's upload is refused to workspace B", refusedSource(results.theirs), json(results.theirs))
    check(
        'O3 case 43: roots unset, a symlink inside the uploads folder that escapes it (to a folder, to /etc) is refused after realpath',
        refusedSource(results.symlinkDir) && refusedSource(results.symlinkEtc),
        json([results.symlinkDir, results.symlinkEtc])
    )
    check(
        'O3: a path with ".." is refused, and so is a relative path',
        !results.dotdot.ok && results.dotdot.code === 'bad_path' && !results.relative.ok && results.relative.code === 'bad_source',
        json([results.dotdot, results.relative])
    )
    check(
        "O3: roots unset, this workspace's upload and samples/etl are readable; the checkout only as a Code Repository, never its data folder",
        results.mine.ok &&
            results.mine.value.via === 'uploads' &&
            results.sample.ok &&
            results.sample.value.via === 'samples' &&
            refusedSource(results.repoAsFiles) &&
            results.repoAsRepo.ok &&
            results.repoAsRepo.value.via === 'repo' &&
            refusedSource(results.dataAsRepo) &&
            refusedSource(results.noWorkspace),
        json(results)
    )
    const meta = vectors('rv-o3').map((v) => v.metadata)
    const absolute = (value) => typeof value === 'string' && (path.isAbsolute(value) || value.includes(root) || value.includes(own))
    check(
        'O3/E16: roots unset, a run over this workspace’s upload succeeds and no metadata value holds an absolute path',
        results.mineRun.status === 'succeeded' &&
            meta.length === 1 &&
            meta[0].source === 'rv-o3/u1/mine.csv' &&
            !meta.some((m) => Object.values(m).some(absolute)),
        json({ run: brief(results.mineRun), meta })
    )
    // A checkout walk leaves the data and ETL folders out and forces the ignores on.
    const excludes = repoDataExcludes(path.dirname(dataRoot()))
    check(
        'O3: a Code Repository walk allowed through the checkout excludes the data folder',
        excludes.includes(path.basename(dataRoot())) && excludes.includes(`${path.basename(dataRoot())}/**`),
        json(excludes)
    )
    // With the data folder inside the checkout (the default, <repo>/.cuttlely), it is refused as a Code Repository and a
    // walk through the checkout leaves it out, along with gitignored files and the default ignores, whatever the node says.
    const savedData = process.env.CUTTLELY_DATA_DIR
    const fakeRepo = path.join(R, 'checkout')
    for (const [name, text] of [
        ['.gitignore', 'secret.txt\n'],
        ['keep.md', 'kept'],
        ['secret.txt', 'ignored by gitignore'],
        ['node_modules/pkg/index.js', 'default ignore'],
        ['.data/etl/uploads/notes.md', 'data folder']
    ]) {
        fs.mkdirSync(path.dirname(path.join(fakeRepo, name)), { recursive: true })
        fs.writeFileSync(path.join(fakeRepo, name), text)
    }
    let inside
    try {
        delete process.env.CUTTLELY_ETL_ROOTS
        process.env.CUTTLELY_DATA_DIR = path.join(repoRoot(), '.cuttlely-review-check')
        const access = outcome(() => pathAccess(path.join(repoRoot(), '.cuttlely-review-check', 'etl'), { workspaceId: WS, repo: true }))
        process.env.CUTTLELY_DATA_DIR = path.join(fakeRepo, '.data')
        const walked = [...repoFiles(fakeRepo, { respectGitignore: 'false', defaultIgnores: 'false' }, { checkout: true })].map(
            (f) => f.rel
        )
        const free = [...repoFiles(fakeRepo, { respectGitignore: 'false', defaultIgnores: 'false' })].map((f) => f.rel)
        inside = { access, walked, free }
    } finally {
        if (savedData === undefined) delete process.env.CUTTLELY_DATA_DIR
        else process.env.CUTTLELY_DATA_DIR = savedData
        if (saved === undefined) delete process.env.CUTTLELY_ETL_ROOTS
        else process.env.CUTTLELY_ETL_ROOTS = saved
    }
    check(
        'O3: roots unset, a data folder inside the checkout is refused as a Code Repository',
        refusedSource(inside.access),
        json(inside.access)
    )
    check(
        'O3: a walk allowed through the checkout forces gitignore and the default ignores on and leaves the data folder out',
        json(inside.walked.sort()) === json(['.gitignore', 'keep.md']) &&
            inside.free.includes('secret.txt') &&
            inside.free.includes('.data/etl/uploads/notes.md'),
        json(inside)
    )
    // An old flat upload (uploads/<uuid>/…, from before uploads were kept per workspace) is refused with the same message whether or not
    // CUTTLELY_ETL_ROOTS is set (even to a folder that holds the uploads): re-upload it, or copy it to a listed folder.
    const flat = path.join(path.dirname(own), 'rv-flat-0000', 'old.csv')
    fs.mkdirSync(path.dirname(flat), { recursive: true })
    fs.writeFileSync(flat, 'sku,name,notes\nF1,Flat,old upload\n')
    const flatResults = {}
    let flatRun
    try {
        delete process.env.CUTTLELY_ETL_ROOTS
        flatResults.unset = outcome(() => pathAccess(flat, { workspaceId: WS }))
        flatRun = await runFlow('rv-flat', localFlow(flat, 'rv-flat'))
        process.env.CUTTLELY_ETL_ROOTS = R
        flatResults.otherRoot = outcome(() => pathAccess(flat, { workspaceId: WS }))
        process.env.CUTTLELY_ETL_ROOTS = root
        flatResults.rootHoldingUploads = outcome(() => checkPathForFiles(flat))
    } finally {
        if (saved === undefined) delete process.env.CUTTLELY_ETL_ROOTS
        else process.env.CUTTLELY_ETL_ROOTS = saved
    }
    const flatMessage = (r) =>
        !r.ok &&
        r.code === 'bad_source' &&
        /Upload the file again from this pipeline, or copy it to a folder listed in CUTTLELY_ETL_ROOTS/.test(r.message)
    check(
        'old flat upload: refused bad_source with the re-upload / CUTTLELY_ETL_ROOTS message, roots unset, set elsewhere, or set to a folder holding the uploads; a run fails with it',
        flatMessage(flatResults.unset) &&
            flatMessage(flatResults.otherRoot) &&
            flatMessage(flatResults.rootHoldingUploads) &&
            flatRun.status === 'failed' &&
            /Upload the file again from this pipeline, or copy it to a folder listed in CUTTLELY_ETL_ROOTS/.test(flatRun.error || '') &&
            (flatRun.summary?.read ?? 0) === 0,
        json({ flatResults, run: brief(flatRun) })
    )
    // With CUTTLELY_ETL_ROOTS set, its roots are readable (realpath), uploads of this workspace stay readable, and
    // anything else is refused.
    process.env.CUTTLELY_ETL_ROOTS = `${R}`
    let set
    try {
        set = {
            inRoot: outcome(() => pathAccess(path.join(outside, 'secret.csv'), { workspaceId: WS })),
            etc: outcome(() => pathAccess('/etc/hosts', { workspaceId: WS })),
            upload: outcome(() => pathAccess(upload, { workspaceId: WS })),
            repo: outcome(() => pathAccess(path.join(repoRoot(), 'etl'), { workspaceId: WS, repo: true }))
        }
    } finally {
        if (saved === undefined) delete process.env.CUTTLELY_ETL_ROOTS
        else process.env.CUTTLELY_ETL_ROOTS = saved
    }
    check(
        'O3: roots set, a configured root and this workspace’s uploads are readable; /etc and the checkout default are refused',
        set.inRoot.ok && set.inRoot.value.via === 'configured' && set.upload.ok && refusedSource(set.etc) && refusedSource(set.repo),
        json(set)
    )
}

// A NodesPool entry is one shared object. init must run on a new class, or two pipelines share its fields.
{
    const modFile = path.join(root, 'fresh-node.mjs')
    fs.writeFileSync(
        modFile,
        [
            'let built = 0',
            'export const nodeClass = class {',
            '    constructor() { built += 1; this.built = built }',
            '    async init(nodeData) { return { built: this.built, id: nodeData.id } }',
            '}',
            ''
        ].join('\n')
    )
    const pooled = {
        filePath: modFile,
        tag: 'pool',
        async init() {
            throw new Error('pool init')
        }
    }
    const ctx = { componentNodes: { fakeEmb: pooled } }
    const spec = { nodeName: 'fakeEmb', label: 'Fake', category: 'Embeddings', inputs: {} }
    const first = await initNode({ ...spec, nodeId: 'n1' }, { ctx })
    const second = await initNode({ ...spec, nodeId: 'n2' }, { ctx })
    const again = await nodeInstance('fakeEmb', ctx)
    again.extra = true
    const other = await nodeInstance('fakeEmb', ctx)
    check(
        'a NodesPool entry is constructed per init and the shared object is not initialized',
        first.id === 'n1' &&
            second.id === 'n2' &&
            first.built !== second.built &&
            pooled.tag === 'pool' &&
            again !== pooled &&
            again !== other &&
            other.extra !== true,
        json({ first, second, againExtra: again.extra, otherExtra: other.extra })
    )
    const stub = {
        async init() {
            return 'stub'
        }
    }
    check(
        'an offline node stub with no filePath is used as given',
        (await nodeInstance('plainText', { componentNodes: { plainText: stub } })) === stub
    )
}
