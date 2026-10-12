// etl:check, failure semantics: E9a remote writes and the store-count check (spec 7.11).
import fs from 'node:fs'
import path from 'node:path'
import { api, check, root, WS } from './lib.mjs'

// E9a (spec 7.11, cases 57-66): remote writes never lose vectors, failed writes are not marked synced,
// and every run compares ETL's records with the store's own count. Fake Pinecone with count and fetch-by-id.
{
    const { createFake, shapeFor } = await import('../store-adapter.mjs')
    const { stmt } = await import('../db.mjs')
    const ROWS = 31
    const csv = (file, rows) => fs.writeFileSync(file, `sku,name,notes\n${rows.join('\n')}\n`)
    const ledger = (edit = {}) =>
        Array.from({ length: ROWS }, (_, i) => `V${i + 1},Crate ${i + 1},${edit[i + 1] || `holds ${(i + 1) * 7} brass gears`}`)
    // Counting fake embedder: records how many texts each run embeds.
    const embedder = {
        texts: 0,
        async embedDocuments(texts) {
            this.texts += texts.length
            return texts.map((text) => [text.length % 7, 1, 0.5])
        },
        async embedQuery() {
            return [1, 1, 0.5]
        }
    }
    // Fake Pinecone namespace with describe_index_stats and fetch, plus fault injection and a count sampled after every write.
    const countable = (namespace) => {
        const fake = createFake(shapeFor('pinecone'))
        const rows = fake.rows
        const t = {
            fake,
            fault: null,
            upserts: 0,
            samples: [],
            lag: null,
            statsCalls: 0
        }
        const upsert = fake.upsert.bind(fake)
        const deleteMany = fake.deleteMany.bind(fake)
        fake.namespace = namespace
        fake.upsert = async (records) => {
            t.upserts += 1
            if (t.fault && t.upserts >= t.fault.at) {
                t.samples.push(rows.size)
                throw t.fault.error()
            }
            await upsert(records)
            t.samples.push(rows.size)
        }
        fake.deleteMany = async (ids) => {
            await deleteMany(ids)
            t.samples.push(rows.size)
        }
        fake.describeIndexStats = async () => {
            t.statsCalls += 1
            const lag = t.lag ? t.lag() : 0
            return { namespaces: { [namespace]: { recordCount: Math.max(0, rows.size - lag) } } }
        }
        fake.fetch = async (ids) => {
            const records = {}
            for (const id of ids) if (rows.has(id)) records[id] = { id }
            return { records, namespace }
        }
        return t
    }
    const faults = {
        400: () => Object.assign(new Error('injected test failure'), { status: 400 }),
        timeout: () => Object.assign(new Error('Request timed out (injected)'), { code: 'ETIMEDOUT', name: 'TimeoutError' }),
        '5xx': () => Object.assign(new Error('Service unavailable (injected)'), { status: 503 })
    }
    const pineFlow = (file, namespace, embedNode = 'openAIEmbeddings') => ({
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
            { id: 'emb', data: { name: embedNode, label: 'OpenAI Embedding', category: 'Embeddings', inputs: { modelName: 'fake' } } },
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
    const settings = { batchSize: 2, concurrency: 1, maxRetries: 0, maxErrors: 5 }
    const run = async (id, mode, extra = {}) => {
        const started = api.startRun(id, { mode, settings: { ...settings, ...extra } })
        let detail = api.runDetail(started.id)
        while (['queued', 'running', 'pausing', 'cancelling'].includes(detail.status)) {
            await api.waitForIdle()
            await new Promise((resolve) => setImmediate(resolve))
            detail = api.runDetail(started.id)
        }
        return detail
    }
    const records = (id) =>
        stmt('SELECT chunk_id FROM records WHERE pipeline_id = ?')
            .all(id)
            .map((row) => row.chunk_id)
    const fingerprintOf = (id) => stmt('SELECT source_id, fingerprint FROM sources WHERE pipeline_id = ?').all(id)
    const served = (id) => stmt('SELECT served_version, index_fingerprint, updated_at FROM pipelines WHERE id = ?').get(id)
    const warned = (detail, pattern) => (detail.events || []).some((event) => event.level === 'warn' && pattern.test(event.message))
    const fetchAll = async (t, id) => {
        const ids = records(id)
        const got = await t.fake.fetch(ids)
        return { records: ids.length, fetched: Object.keys(got.records).length }
    }
    const setup = async (key, ctxExtra = {}) => {
        const file = path.join(root, `e9a-${key}.csv`)
        csv(file, ledger())
        const t = countable(`e9a-${key}`)
        // A virtual clock, so a lasting mismatch fails at once instead of waiting the real ~30 s window.
        let clock = 0
        const fast = { now: () => clock, sleep: async (ms) => (clock += ms) }
        const ctx = { workspaceId: WS, embeddingsDouble: embedder, storeClients: { pinecone: t.fake }, storeCountSettle: fast, ...ctxExtra }
        api.configureRunner({ contextFor: () => ctx })
        const saved = api.recordVersion({ workspaceId: WS, id: `e9a-${key}`, name: `E9a ${key}`, flowData: pineFlow(file, `e9a-${key}`) })
        if (saved.problems.length) throw new Error(saved.problems.join('; '))
        const first = await run(`e9a-${key}`, 'incremental')
        if (first.status !== 'succeeded' || t.fake.rows.size !== ROWS)
            throw new Error(`setup ${key}: ${first.status} ${first.error} ${t.fake.rows.size}`)
        return { file, t, ctx, id: `e9a-${key}` }
    }

    // 57-59: an upsert 400 / timeout / 5xx in a batch that, on main, deleted its ids first. Full and incremental.
    for (const [num, kind] of [
        [57, '400'],
        [58, 'timeout'],
        [59, '5xx']
    ]) {
        for (const mode of ['full', 'incremental']) {
            const { file, t, id } = await setup(`${kind}-${mode}`)
            if (mode === 'incremental')
                csv(file, ledger({ 3: 'retagged', 9: 'retagged', 14: 'retagged', 20: 'retagged', 26: 'retagged', 30: 'retagged' }))
            t.samples = []
            t.upserts = 0
            t.fault = { at: mode === 'full' ? 8 : 2, error: faults[kind] }
            const failed = await run(id, mode, kind === '400' ? {} : { maxRetries: 1 })
            t.fault = null
            const lowest = Math.min(...t.samples)
            const next = await run(id, 'incremental')
            const after = await fetchAll(t, id)
            const stats = await t.fake.describeIndexStats()
            check(
                `E9a ${num}: upsert ${kind} in a ${mode} run never drops the store below its pre-run count, and the next run is full`,
                failed.status === 'failed' &&
                    lowest >= ROWS &&
                    next.status === 'succeeded' &&
                    stats.namespaces[`e9a-${kind}-${mode}`].recordCount === ROWS &&
                    after.records === ROWS &&
                    after.fetched === ROWS &&
                    next.counters.storeCount?.status === 'verified',
                JSON.stringify({
                    failed: failed.status,
                    error: failed.error,
                    lowest,
                    next: next.status,
                    nextError: next.error,
                    after,
                    rows: t.fake.rows.size
                })
            )
        }
    }

    // 60: persist only full successes. A changed unit keeps its previous fingerprint and gets no records for the
    // failed batch; a full run's unit (whose fingerprint already matched) is flagged. Both are re-read next run.
    {
        const { file, t, id } = await setup('persist')
        const before = fingerprintOf(id)
        const recordedBefore = records(id).sort()
        csv(file, ledger({ 5: 'moved to dock 4' }))
        t.upserts = 0
        t.fault = { at: 1, error: faults['400'] }
        const failed = await run(id, 'incremental')
        t.fault = null
        const kept = fingerprintOf(id)
        const recorded = records(id)
        const reread = await run(id, 'incremental')
        const { t: t2, id: id2 } = await setup('persist-full')
        t2.upserts = 0
        t2.fault = { at: 4, error: faults['400'] }
        const failedFull = await run(id2, 'full')
        t2.fault = null
        const flagged = fingerprintOf(id2)
        const rereadFull = await run(id2, 'incremental')
        check(
            'E9a 60: a unit with a failed store write keeps its previous fingerprint, records nothing for that batch, and is re-read',
            failed.status === 'failed' &&
                kept.length === 1 &&
                kept[0].fingerprint === before[0].fingerprint &&
                recorded.length === ROWS &&
                JSON.stringify([...recorded].sort()) === JSON.stringify(recordedBefore) &&
                reread.status === 'succeeded' &&
                reread.counters.unitsSkipped === 0 &&
                reread.counters.embedded === 1 &&
                failedFull.status === 'failed' &&
                flagged[0].fingerprint === null &&
                rereadFull.counters.unitsSkipped === 0 &&
                rereadFull.status === 'succeeded',
            JSON.stringify({
                failed: failed.status,
                kept,
                before,
                recorded: recorded.length,
                reread: reread.counters,
                flagged,
                rereadFull: rereadFull.status
            })
        )
    }

    // 61: runs 8395ffac and 9bb8f6b6. 31 chunks, batchSize 2, concurrency 1, a 400 on the 8th upsert of a full
    // run (on main that upsert follows the delete of the same 2 ids), then a normal rerun.
    {
        const { t, id } = await setup('regression')
        t.samples = []
        t.upserts = 0
        t.fault = { at: 8, error: faults['400'] }
        const failed = await run(id, 'full')
        t.fault = null
        const afterFailed = t.fake.rows.size
        const rerun = await run(id, 'incremental')
        const after = await fetchAll(t, id)
        check(
            'E9a 61: regression 8395ffac/9bb8f6b6, the failed full run keeps 31 of 31 and the rerun ends at 31 of 31',
            failed.status === 'failed' &&
                Math.min(...t.samples) >= ROWS &&
                afterFailed === ROWS &&
                rerun.status === 'succeeded' &&
                rerun.counters.storeCount?.status === 'verified' &&
                t.fake.rows.size === ROWS &&
                after.fetched === ROWS,
            JSON.stringify({
                failed: failed.status,
                afterFailed,
                rerun: rerun.status,
                rerunEvents: rerun.counters.unitsSkipped,
                store: t.fake.rows.size,
                after
            })
        )
    }

    // 62: detection alone. The write fix is off (pre-E9a delete-then-upsert, failed writes not flagged); the
    // rerun that main reports "completed, 1 sources unchanged" ends failed / store_count_mismatch instead.
    // 63: the run after it heals, re-embedding only the 2 missing chunks.
    {
        const { t, id, ctx } = await setup('detect')
        ctx.faults = { legacyDeleteFirst: true }
        t.upserts = 0
        t.fault = { at: 8, error: faults['400'] }
        const failed = await run(id, 'full')
        t.fault = null
        const lost = t.fake.rows.size
        const rerun = await run(id, 'incremental')
        const sourceId = stmt('SELECT source_id FROM sources WHERE pipeline_id = ?').get(id)?.source_id
        const events = rerun.events || api.runDetail(rerun.id).events || []
        const flagged = fingerprintOf(id)
        check(
            'E9a 62: with the write fix off, detection alone ends the rerun failed / store_count_mismatch with 31/29 and the source id',
            failed.status === 'failed' &&
                lost === ROWS - 2 &&
                rerun.status === 'failed' &&
                rerun.counters.unitsSkipped === 1 &&
                /^store_count_mismatch: the store holds 29 vectors .* ETL records list 31/.test(rerun.error || '') &&
                rerun.error.includes(sourceId) &&
                events.some((event) => /store_count_mismatch/.test(event.message) && event.message.includes(sourceId)) &&
                flagged[0].fingerprint === null,
            JSON.stringify({ failed: failed.status, lost, rerun: rerun.status, error: rerun.error, flagged, sourceId })
        )
        delete ctx.faults
        const textsBefore = embedder.texts
        const heal = await run(id, 'incremental')
        const after = await fetchAll(t, id)
        check(
            'E9a 63: the heal run restores 31 of 31 and re-embeds only the 2 missing chunks',
            heal.status === 'succeeded' &&
                t.fake.rows.size === ROWS &&
                after.records === ROWS &&
                after.fetched === ROWS &&
                embedder.texts - textsBefore === 2 &&
                heal.counters.embedded === 2,
            JSON.stringify({ heal: heal.status, error: heal.error, store: t.fake.rows.size, after, embedded: embedder.texts - textsBefore })
        )
    }

    // 64: the settle window, with an injected clock. A count that lags and catches up passes. (a) A count that
    // lags past the window while fetch-by-id finds every recorded id completes with store_count_lagging and is
    // served. (b) A gap that lasts past the window with ids really missing fails, and the version is not served.
    {
        let clock = 0
        const settle = { windowMs: 30000, pollMs: 5000, now: () => clock, sleep: async (ms) => (clock += ms) }
        const { t, id, ctx } = await setup('settle', { storeCountSettle: settle })
        clock = 0
        t.lag = () => (clock < 15000 ? 2 : 0)
        const caught = await run(id, 'incremental')
        const caughtAt = clock
        check(
            'E9a 64: a count lag that clears inside the ~30 s window passes',
            caught.status === 'succeeded' &&
                caught.counters.storeCount?.status === 'verified' &&
                caught.counters.storeCount.polls > 1 &&
                caughtAt >= 15000 &&
                caughtAt < 30000,
            JSON.stringify({ caught: caught.status, caughtAt, storeCount: caught.counters.storeCount })
        )
        clock = 0
        t.lag = () => 2
        const before = served(id)
        const lagging = await run(id, 'incremental')
        const laggingAt = clock
        t.lag = null
        const found = await api.searchPipeline('E9a settle', 'crate brass gears', { k: 2, ctx })
        check(
            'E9a 64a: a count lag past the window with 0 ids missing by fetch ends succeeded with store_count_lagging and is served',
            lagging.status === 'succeeded' &&
                lagging.counters.storeCount?.status === 'lagging' &&
                warned(lagging, /^store_count_lagging:/) &&
                laggingAt >= 30000 &&
                served(id).updated_at !== before.updated_at &&
                found.results.length === 2,
            JSON.stringify({ lagging: lagging.status, laggingAt, error: lagging.error, storeCount: lagging.counters.storeCount })
        )
    }
    {
        let clock = 0
        const settle = { windowMs: 30000, pollMs: 5000, now: () => clock, sleep: async (ms) => (clock += ms) }
        const file = path.join(root, 'e9a-settle-gap.csv')
        csv(file, ledger())
        const t = countable('e9a-settle-gap')
        // The first batch is acknowledged but never lands, so 2 recorded ids are really missing.
        const write = t.fake.upsert
        let batches = 0
        t.fake.upsert = async (rows) => (batches++ === 0 ? undefined : write(rows))
        const ctx = { workspaceId: WS, embeddingsDouble: embedder, storeClients: { pinecone: t.fake }, storeCountSettle: settle }
        api.configureRunner({ contextFor: () => ctx })
        api.recordVersion({ workspaceId: WS, id: 'e9a-settle-gap', name: 'E9a settle gap', flowData: pineFlow(file, 'e9a-settle-gap') })
        clock = 0
        const gap = await run('e9a-settle-gap', 'incremental')
        const gapAt = clock
        let refused = null
        await api.searchPipeline('E9a settle gap', 'crate brass gears', { k: 2, ctx }).catch((error) => (refused = error.code))
        check(
            'E9a 64b: a gap that lasts past the window with ids missing by fetch ends failed / store_count_mismatch and is not served',
            gap.status === 'failed' &&
                /^store_count_mismatch: the store holds 29 vectors .* ETL records list 31; 2 recorded chunk ids are missing/.test(
                    gap.error || ''
                ) &&
                gapAt >= 30000 &&
                served('e9a-settle-gap').served_version === null &&
                refused === 'not_ready',
            JSON.stringify({ gap: gap.status, gapAt, error: gap.error, refused })
        )
    }

    // 65: not verified. No count API, the default namespace, or a namespace shared by two pipelines; none fails.
    {
        const file = path.join(root, 'e9a-unverified.csv')
        csv(file, ledger().slice(0, 4))
        const chroma = createFake(shapeFor('chroma'))
        const t = countable('')
        const shared = countable('e9a-shared')
        api.configureRunner({ contextFor: () => ({ embeddingsDouble: embedder, storeClients: { chroma, pinecone: t.fake } }) })
        const chromaFlow = pineFlow(file, 'x')
        chromaFlow.nodes[2] = {
            id: 'vs',
            data: { name: 'chroma', label: 'Chroma', category: 'Vector Stores', inputs: { collectionName: 'e9a' } }
        }
        api.recordVersion({ workspaceId: WS, id: 'e9a-nocount', name: 'E9a nocount', flowData: chromaFlow })
        const noCount = await run('e9a-nocount', 'incremental')
        api.recordVersion({ workspaceId: WS, id: 'e9a-default', name: 'E9a default', flowData: pineFlow(file, '') })
        const defaultNs = await run('e9a-default', 'incremental')
        api.configureRunner({ contextFor: () => ({ embeddingsDouble: embedder, storeClients: { pinecone: shared.fake } }) })
        api.recordVersion({ workspaceId: WS, id: 'e9a-shared-a', name: 'E9a shared a', flowData: pineFlow(file, 'e9a-shared') })
        api.recordVersion({ workspaceId: WS, id: 'e9a-shared-b', name: 'E9a shared b', flowData: pineFlow(file, 'e9a-shared') })
        const sharedRun = await run('e9a-shared-a', 'incremental')
        const notVerified = (detail) => detail.status === 'succeeded' && detail.counters.storeCount?.status === 'not verified'
        check(
            'E9a 65: no count API, a default namespace and a shared namespace record not verified and do not fail',
            notVerified(noCount) && notVerified(defaultNs) && notVerified(sharedRun) && /shared/.test(sharedRun.counters.storeCount.reason),
            JSON.stringify([
                noCount.counters.storeCount,
                defaultNs.counters.storeCount,
                sharedRun.counters.storeCount,
                noCount.error,
                defaultNs.error
            ])
        )
    }

    // 66: an all-unchanged run still checks. 2 ids deleted behind ETL's back fail that run.
    {
        const { t, id } = await setup('unchanged')
        const quiet = await run(id, 'incremental')
        const ids = [...t.fake.rows.keys()].slice(0, 2)
        await t.fake.deleteMany(ids)
        const statsBefore = t.statsCalls
        const edited = await run(id, 'incremental')
        check(
            'E9a 66: an unchanged run checks the store count, and a store edited behind ETL fails it',
            quiet.status === 'succeeded' &&
                quiet.counters.unitsSkipped === 1 &&
                quiet.counters.storeCount?.status === 'verified' &&
                edited.status === 'failed' &&
                edited.counters.unitsSkipped === 1 &&
                t.statsCalls > statsBefore &&
                /^store_count_mismatch: the store holds 29 vectors .* ETL records list 31/.test(edited.error || ''),
            JSON.stringify({ quiet: quiet.status, edited: edited.status, error: edited.error, counters: edited.counters.storeCount })
        )
    }

    // 79-81: the fail-closed count check (spec 7.11 v1.3.1; numbered 79-81 because 67-78 are E16/E17).
    // 79: store_count_lagging. The count lags past the settle window while fetch-by-id confirms 0 missing.
    {
        const { t, id, ctx } = await setup('lagging')
        const before = served(id)
        t.lag = () => 2
        const lagging = await run(id, 'incremental')
        t.lag = null
        const after = served(id)
        const found = await api.searchPipeline('E9a lagging', 'crate brass gears', { k: 2, ctx })
        check(
            'E9a 79: store_count_lagging, the count lags past the window while fetch confirms 0 missing; the run completes, the event carries both counts, and retrieval succeeds',
            lagging.status === 'succeeded' &&
                lagging.counters.storeCount?.status === 'lagging' &&
                lagging.counters.storeCount.missing === 0 &&
                warned(lagging, /^store_count_lagging: the store holds 29 vectors .* ETL records list 31/) &&
                after.updated_at !== before.updated_at &&
                JSON.parse(after.index_fingerprint).storeCount === 'e9a' &&
                fingerprintOf(id).every((row) => row.fingerprint) &&
                found.results.length === 2 &&
                records(id).length === ROWS,
            JSON.stringify({
                status: lagging.status,
                error: lagging.error,
                storeCount: lagging.counters.storeCount,
                hits: found.results.length
            })
        )
    }

    // 80-80c share these: a fake method that fails `times` times in a row, then works again.
    const injected = {
        // Like the Pinecone client, the 429 quotes the request URL; check messages must drop its query string (chunk ids).
        429: () =>
            Object.assign(new Error('Too many requests (injected) calling https://fake.test/vectors/fetch?ids=a&ids=b&namespace=n'), {
                status: 429
            }),
        '5xx': faults['5xx']
    }
    // `describeIndexStats` passes its first call through: that is the run's store preflight, and these cases
    // are about the count check that follows.
    const failing = (fake, method, kind, times) => {
        const real = fake[method]
        let failures = 0
        let skip = method === 'describeIndexStats' ? 1 : 0
        fake[method] = async (...args) => {
            if (skip > 0) {
                skip -= 1
                return real(...args)
            }
            if (failures < times) {
                failures += 1
                throw injected[kind]()
            }
            return real(...args)
        }
        return () => (fake[method] = real)
    }
    const retried = (detail, what) =>
        (detail.events || []).some((event) => new RegExp(`store ${what} call failed .* retrying once`).test(event.message))

    // 80: the count call and the id fetch are each retried once. A single 429, then a single 5xx, on each: the run
    // completes. A count that matches never needs the fetch, so a broken fetch does not matter there. A count that
    // fails twice leaves fetch-by-id to decide. A retried fetch still finds a real gap.
    {
        const { t, id } = await setup('retry-once')
        const attempt = async (method, kind, times, lag = null) => {
            const restore = failing(t.fake, method, kind, times)
            t.lag = lag
            try {
                return await run(id, 'incremental')
            } finally {
                restore()
                t.lag = null
            }
        }
        const once = []
        for (const kind of ['429', '5xx']) {
            once.push({ what: 'count', kind, detail: await attempt('describeIndexStats', kind, 1) })
            once.push({ what: 'fetch', kind, detail: await attempt('fetch', kind, 1, () => 2) })
        }
        const fetchDownCountOk = await attempt('fetch', '5xx', 2)
        const countDown = await attempt('describeIndexStats', '5xx', 2)
        await t.fake.deleteMany([...t.fake.rows.keys()].slice(0, 2))
        const realGap = await attempt('fetch', '429', 1)
        check(
            'E9a 80: count/fetch retried once, a single 429 or 5xx on the count call and on the id fetch is retried and the run completes; a matching count needs no fetch, and a count failing twice leaves fetch-by-id to decide',
            once.every(
                ({ what, detail }) =>
                    detail.status === 'succeeded' &&
                    retried(detail, what) &&
                    detail.counters.storeCount?.status === (what === 'count' ? 'verified' : 'lagging')
            ) &&
                fetchDownCountOk.status === 'succeeded' &&
                fetchDownCountOk.counters.storeCount?.status === 'verified' &&
                countDown.status === 'succeeded' &&
                countDown.counters.storeCount?.status === 'verified' &&
                countDown.counters.storeCount.by === 'fetch' &&
                realGap.status === 'failed' &&
                retried(realGap, 'fetch') &&
                /^store_count_mismatch: the store holds 29 vectors .* ETL records list 31; 2 recorded chunk ids are missing/.test(
                    realGap.error || ''
                ),
            JSON.stringify({
                once: once.map(({ what, kind, detail }) => [what, kind, detail.status, detail.counters.storeCount?.status, detail.error]),
                fetchDownCountOk: [fetchDownCountOk.status, fetchDownCountOk.counters.storeCount],
                countDown: [countDown.status, countDown.counters.storeCount],
                realGap: [realGap.status, realGap.error]
            })
        )
    }

    // 80b: count short, fetch unavailable (fail closed). A changed row's new chunk is acknowledged but never lands,
    // and the id fetch fails twice. The run fails store_count_unverified: previous fingerprints are kept, the old
    // chunk is not swept, and the served version does not move. A new pipeline in the same state is never served.
    {
        const { file, t, id, ctx } = await setup('unverified')
        const before = { fingerprints: fingerprintOf(id), served: served(id), ids: [...t.fake.rows.keys()].sort() }
        const write = t.fake.upsert
        t.fake.upsert = async () => {}
        let deletes = 0
        const remove = t.fake.deleteMany
        t.fake.deleteMany = async (ids) => {
            deletes += ids.length
            return remove(ids)
        }
        const restoreFetch = failing(t.fake, 'fetch', '5xx', 2)
        csv(file, ledger({ 5: 'moved to dock 4' }))
        const existing = await run(id, 'incremental')
        restoreFetch()
        t.fake.upsert = write
        t.fake.deleteMany = remove
        const afterServed = served(id)
        const stillServing = await api.searchPipeline('E9a unverified', 'crate brass gears', { k: 2, ctx })

        const freshFile = path.join(root, 'e9a-unverified-new.csv')
        csv(freshFile, ledger())
        const n = countable('e9a-unverified-new')
        const land = n.fake.upsert
        let batches = 0
        n.fake.upsert = async (rows) => (batches++ === 0 ? undefined : land(rows))
        failing(n.fake, 'fetch', '429', 2)
        const freshCtx = { ...ctx, storeClients: { pinecone: n.fake } }
        api.configureRunner({ contextFor: () => freshCtx })
        api.recordVersion({
            workspaceId: WS,
            id: 'e9a-unverified-new',
            name: 'E9a unverified new',
            flowData: pineFlow(freshFile, 'e9a-unverified-new')
        })
        const brandNew = await run('e9a-unverified-new', 'incremental')
        let refused = null
        await api
            .searchPipeline('E9a unverified new', 'crate brass gears', { k: 2, ctx: freshCtx })
            .catch((error) => (refused = error.code))
        api.configureRunner({ contextFor: () => ctx })
        const unverified = (detail) =>
            detail.status === 'failed' &&
            /^store_count_unverified: the store holds \d+ vectors .* ETL records list \d+, and fetch-by-id failed twice/.test(
                detail.error || ''
            ) &&
            detail.counters.storeCount?.status === 'unverified'
        check(
            'E9a 80b: count short, fetch unavailable (fail closed): the id fetch failing twice ends failed / store_count_unverified; previous fingerprints are kept, no stale ids are deleted, and the served version is not moved (a new pipeline gets none)',
            unverified(existing) &&
                existing.counters.storeCount.store === ROWS &&
                existing.counters.storeCount.records === ROWS + 1 &&
                JSON.stringify(fingerprintOf(id)) === JSON.stringify(before.fingerprints) &&
                deletes === 0 &&
                before.ids.every((chunk) => t.fake.rows.has(chunk)) &&
                existing.counters.deleted === 0 &&
                JSON.stringify(afterServed) === JSON.stringify(before.served) &&
                stillServing.version === before.served.served_version &&
                stillServing.results.length === 2 &&
                unverified(brandNew) &&
                !/ids=/.test(brandNew.error) &&
                served('e9a-unverified-new').served_version === null &&
                fingerprintOf('e9a-unverified-new').every((row) => row.fingerprint === null) &&
                refused === 'not_ready',
            JSON.stringify({
                existing: [existing.status, existing.error, existing.counters.storeCount, existing.counters.deleted],
                deletes,
                fingerprints: [before.fingerprints, fingerprintOf(id)],
                brandNew: [brandNew.status, brandNew.error],
                refused
            })
        )
    }

    // 80c: count and fetch both unavailable. No evidence either way: the run completes with store_unverified and
    // flags the pipeline, so the next run verifies the store at its start (the pre-E9a heal path), which clears it.
    {
        const { t, id } = await setup('both-down')
        const restoreCount = failing(t.fake, 'describeIndexStats', '5xx', 2)
        const restoreFetch = failing(t.fake, 'fetch', '429', 2)
        const down = await run(id, 'incremental')
        restoreCount()
        restoreFetch()
        const flagged = JSON.parse(served(id).index_fingerprint)
        const statsBefore = t.statsCalls
        const next = await run(id, 'incremental')
        const statsNext = t.statsCalls - statsBefore
        const cleared = JSON.parse(served(id).index_fingerprint)
        const statsAfter = t.statsCalls
        const third = await run(id, 'incremental')
        check(
            'E9a 80c: count and fetch both unavailable ends succeeded with store_unverified, and the pipeline is flagged so the next run runs the one-time verify/heal step at its start',
            down.status === 'succeeded' &&
                warned(down, /^store_unverified: the count call failed twice .* and the fetch call failed twice/) &&
                down.counters.storeCount?.status === 'not verified' &&
                down.counters.storeCount.verifyNext === true &&
                flagged.storeCount === 'verify' &&
                next.status === 'succeeded' &&
                (next.events || []).some((event) =>
                    /last run could not verify the store; verifying it before this run starts/.test(event.message)
                ) &&
                // One preflight call per run, plus the count calls.
                statsNext === 3 &&
                next.counters.storeCount?.status === 'verified' &&
                cleared.storeCount === 'e9a' &&
                third.status === 'succeeded' &&
                t.statsCalls - statsAfter === 2,
            JSON.stringify({ down: [down.status, down.error, down.counters.storeCount], flagged, statsNext, cleared, third: third.status })
        )
    }

    // 81: store_count_excess. The fake holds 2 extra vectors in the pipeline's namespace.
    {
        const { t, id, ctx } = await setup('excess')
        t.fake.rows.set('not-etl-1', { text: 'foreign', vector: [1, 0, 0], metadata: { text: 'foreign' } })
        t.fake.rows.set('not-etl-2', { text: 'foreign', vector: [0, 1, 0], metadata: { text: 'foreign' } })
        const before = served(id)
        const excess = await run(id, 'incremental')
        const after = served(id)
        const found = await api.searchPipeline('E9a excess', 'crate brass gears', { k: 2, ctx })
        check(
            'E9a 81: store_count_excess, 2 extra vectors in the namespace; the run completes with the warning and both counts, and it is served',
            excess.status === 'succeeded' &&
                excess.counters.storeCount?.status === 'excess' &&
                excess.counters.storeCount.store === ROWS + 2 &&
                warned(excess, /^store_count_excess: the store holds 33 vectors .* ETL records list 31/) &&
                after.updated_at !== before.updated_at &&
                fingerprintOf(id).every((row) => row.fingerprint) &&
                found.results.length === 2,
            JSON.stringify({ status: excess.status, error: excess.error, storeCount: excess.counters.storeCount })
        )
    }
    api.configureRunner({ contextFor: () => ({}) })
}
