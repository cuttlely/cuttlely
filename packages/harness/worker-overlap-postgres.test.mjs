import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { createTestSource, skipReason } from '../etl/check/pg-source.mjs'
import { configureHarnessPostgres, harnessRecordDatabase } from './side-store-postgres.mjs'
import { inspectHead, claimInspectedHead } from './worker-overlap.mjs'
import { pairedWorkerRecord } from './run.mjs'
if (!isMainThread) {
    configureHarnessPostgres(workerData)
    const db = harnessRecordDatabase()
    let preview
    parentPort.on('message', (op) => {
        try {
            if (op === 'inspect') {
                preview = inspectHead(db, pairedWorkerRecord)
                parentPort.postMessage({ eligible: !!preview })
                return
            }
            if (op === 'claim') {
                const answer = claimInspectedHead(db, preview)
                preview = undefined
                parentPort.postMessage({
                    won: !!answer,
                    returned: answer?.job,
                    catalogGranted: answer?.record.specialists[0].modules.length === 1
                })
                return
            }
            throw Error('unknown message')
        } catch (e) {
            parentPort.postMessage({ error: e.code || e.name })
        }
    })
    parentPort.postMessage({ ready: true })
} else {
    test('two PostgreSQL workers claim only the unchanged admitted retrieval job and saved generation', { skip: skipReason }, async (t) => {
        const db = await createTestSource()
        const all = []

        const schema = 'cuttlely_harness_queue',
            name = 'Books'
        const q = 'queued'
        const payload = {
            name,
            engine: 'native',
            mode: 'agent',
            source: 'api',
            workspaceId: 'site',
            expectedHarnessChatflowId: 'canvas',
            chatId: 'example',
            apiKeyId: 'local',
            caller: { via: 'api_key', apiKeyId: 'local', harnesses: ['Books'], harnessIds: { Books: 'canvas' } }
        }
        const stored = {
            name,
            workspaceId: 'site',
            chatflowId: 'canvas',
            createdAt: '2026-01-01',
            updatedAt: '2026-01-02',
            chief: { model: { nodeName: 'chatOpenAI', credential: 'model', inputs: { modelName: 'fixture' } } },
            specialists: [
                {
                    name: 'catalog',
                    modules: [
                        {
                            nodeName: 'retrieverTool',
                            inputs: { name: 'catalog' },
                            upstream: {
                                retriever: {
                                    nodeName: 'pinecone',
                                    credential: 'vector',
                                    inputs: { pineconeIndex: 'catalog' },
                                    outputs: { output: 'retriever' },
                                    upstream: {
                                        embeddings: {
                                            nodeName: 'openAIEmbeddings',
                                            credential: 'embed',
                                            inputs: { modelName: 'text-embedding-3-small' }
                                        }
                                    }
                                }
                            }
                        }
                    ]
                }
            ]
        }
        const sql = (s, ...p) => db.query(s.replaceAll('SCHEMA', schema), p)
        const seed = async () => {
            await sql('DELETE FROM SCHEMA.jobs')
            await sql('DELETE FROM SCHEMA.harness_records')
            await sql('INSERT INTO SCHEMA.harness_records VALUES ($1,$2)', 'Books.json', JSON.stringify(stored))
            await sql(
                'INSERT INTO SCHEMA.jobs(id,session_key,status,payload,created_at,updated_at) VALUES ($1,$2,$3,$4,10,10)',
                'job',
                'Books:example',
                q,
                JSON.stringify(payload)
            )
        }
        const command = async (w, op) => {
            const done = once(w, 'message')
            w.postMessage(op)
            const [reply] = await done
            assert.equal(reply.error, undefined)
            return reply
        }
        const check = (label, body) =>
            t.test(label, async () => {
                await seed()
                await body()
            })
        const state = async () => (await sql('SELECT status FROM SCHEMA.jobs WHERE id=$1', 'job'))[0].status
        const win = async (w) => {
            const r = await command(w, 'claim')
            assert.equal(r.won, true)
            assert.deepEqual(r.returned, { id: 'job', payload, cancelRequested: false })
            assert.equal(r.catalogGranted, true)
        }
        const preview = async (w) => assert.deepEqual(await command(w, 'inspect'), { eligible: true })
        let writer
        try {
            for (const workerName of ['A', 'B']) {
                const w = new Worker(new URL(import.meta.url), {
                    workerData: {
                        ...db.connection,
                        application_name: 'qa-pair-' + workerName,
                        options: '-c search_path=pg_catalog -c default_transaction_isolation=repeatable\\ read'
                    }
                })
                all.push(w)
                assert.deepEqual((await once(w, 'message'))[0], { ready: true })
            }
            const [a, b] = all
            await check('competing qualified heads return once, reading current cancel bit', async () => {
                await Promise.all([preview(a), preview(b)])
                await sql('UPDATE SCHEMA.jobs SET cancel_requested=1')
                const results = await Promise.all([command(a, 'claim'), command(b, 'claim')])
                const winners = results.filter((x) => x.won)
                assert.equal(winners.length, 1)
                assert.deepEqual(winners[0].returned, { id: 'job', payload, cancelRequested: true })
                assert.equal(await state(), 'running')
            })
            const mutations = [
                [
                    'payload loses caller grant',
                    'UPDATE SCHEMA.jobs SET payload=$1',
                    JSON.stringify({ ...payload, caller: { ...payload.caller, harnesses: [] } })
                ],
                ['byte-only job replacement', "UPDATE SCHEMA.jobs SET payload=payload||' '"],
                ['job replaced by bundled engine', 'UPDATE SCHEMA.jobs SET payload=$1', JSON.stringify({ ...payload, engine: 'hermes' })],
                [
                    'saved role removes grant',
                    'UPDATE SCHEMA.harness_records SET content=$1',
                    JSON.stringify({ ...stored, specialists: [{ name: 'catalog', modules: [] }] })
                ],
                [
                    'another owner replaces published team',
                    'UPDATE SCHEMA.harness_records SET content=$1',
                    JSON.stringify({ ...stored, workspaceId: 'elsewhere' })
                ],
                [
                    'newer generation adds exclusive authority',
                    'UPDATE SCHEMA.harness_records SET content=$1',
                    JSON.stringify({ ...stored, updatedAt: '2026-01-03', specialists: [{ name: 'catalog', shell: true }] })
                ],
                ['removed publication', 'DELETE FROM SCHEMA.harness_records'],
                ['maintenance stops job', "UPDATE SCHEMA.jobs SET status='cancelled'"],
                [
                    'different earlier exclusive head',
                    'INSERT INTO SCHEMA.jobs(id,session_key,status,payload,created_at,updated_at) VALUES ($1,$2,$3,$4,1,1)',
                    'older',
                    'Books:prior',
                    q,
                    JSON.stringify({ ...payload, engine: 'hermes' })
                ]
            ]
            for (const [label, mutation, ...args] of mutations)
                await check(label, async () => {
                    await preview(a)
                    await sql(mutation, ...args)
                    assert.equal((await command(a, 'claim')).won, false)
                    assert.notEqual(await state(), 'running')
                    if (label === 'different earlier exclusive head') assert.equal((await command(a, 'inspect')).eligible, false)
                })
            writer = await db.client.connect()
            for (const [label, takeFence, commit] of [
                ['admission fence + committed revoked grant', true, true],
                ['raw in-progress roster edit', false, true],
                ['rolled back roster edit leaves exact original', false, false]
            ]) {
                await check(label, async () => {
                    await preview(a)
                    await writer.query('BEGIN')
                    if (takeFence) await writer.query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema])
                    await writer.query('UPDATE ' + schema + '.harness_records SET content=$1', [
                        JSON.stringify({ ...stored, specialists: [{ name: 'catalog', modules: [] }] })
                    ])
                    const result = command(a, 'claim')
                    try {
                        let waited = false
                        for (let n = 0; n < 100; n++) {
                            if (
                                (
                                    await db.query(
                                        "SELECT 1 FROM pg_stat_activity WHERE application_name='qa-pair-A' AND wait_event_type='Lock'"
                                    )
                                ).length
                            ) {
                                waited = true
                                break
                            }
                            await delay(10)
                        }
                        assert.equal(waited, true)
                    } finally {
                        await writer.query(commit ? 'COMMIT' : 'ROLLBACK')
                    }
                    assert.equal((await result).won, !commit)
                    assert.equal(await state(), commit ? 'queued' : 'running')
                })
            }
            await check('new valid eligible turn still executes', async () => {
                await preview(b)
                await win(b)
            })
        } finally {
            writer?.release(true)
            for (const w of all) await w.terminate()
            await db.cleanup()
        }
    })
}
