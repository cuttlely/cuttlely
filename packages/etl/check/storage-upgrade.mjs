import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { api, flowFor, LocalVectorStore, root, runPipeline, WS } from './lib.mjs'
import { closeDb, db, etlDir } from '../db.mjs'
import { copyEtlSnapshot, copyVectorSnapshot, snapshotSqlite } from '../migrate-postgres.mjs'
import { openPostgresEtlStore } from '../store-postgres.mjs'
import { useBackend } from '../store.mjs'

export async function checkStorageUpgrade(source) {
    const file = path.join(root, 'input.csv')
    fs.writeFileSync(file, 'sku,name,notes\nT1,Tent,two person\nS1,Stove,gas\n')
    const flow = flowFor(file, 'gear')
    try {
        const first = await runPipeline('00042', 'Gear', flow)
        assert.equal(first.counters.embedded, 2)
        const resultBefore = await api.searchPipeline('Gear', 'gas stove', { k: 2, ctx: { workspaceId: WS } })
        // An AUTOINCREMENT high-water mark survives deletion of its largest row.
        db().exec(
            "INSERT INTO run_events(id,run_id,ts,level,message) VALUES (90000,'test','0','info','synthetic'); DELETE FROM run_events WHERE id=90000"
        )
        const etl = await snapshotSqlite(path.join(etlDir(), 'etl.sqlite'), root)
        const vector = await snapshotSqlite(path.join(etlDir(), 'vectors', 'gear.sqlite'), root)
        const report = await copyEtlSnapshot(source, etl)
        assert.equal(report.pipelines.count, 1)
        assert.equal(report.records.count, 2)
        assert.deepEqual(await copyEtlSnapshot(source, etl), report)
        const vectorReport = await copyVectorSnapshot(source, vector, 'gear')
        assert.equal(vectorReport.vectors.count, 2)
        assert.deepEqual(await copyVectorSnapshot(source, vector, 'gear'), vectorReport)

        LocalVectorStore.closeAll()
        closeDb()
        // A fresh data mount represents another server or a worker after verified cutover.
        process.env.CUTTLELY_ETL_DIR = path.join(root, 'fresh')
        const backend = await openPostgresEtlStore(source)
        useBackend(backend)
        assert.deepEqual(await backend.get('SELECT id FROM pipelines'), { id: '00042' })
        assert.deepEqual(await api.searchPipeline('Gear', 'gas stove', { k: 2, ctx: { workspaceId: WS } }), resultBefore)
        const second = await runPipeline('00042', 'Gear', flow)
        assert.equal(second.status, 'succeeded', second.error)
        assert.equal(second.counters.embedded, 0)
        assert.equal(second.counters.unitsSkipped, 1)
        assert.ok((await backend.get('SELECT max(id) AS latest FROM run_events')).latest > 90000)
        const store = LocalVectorStore.open('gear')
        assert.equal(await store.count(), 2)
        fs.appendFileSync(file, 'L1,Lamp,headlamp\n')
        const third = await runPipeline('00042', 'Gear', flow)
        assert.equal(third.counters.embedded, 1)
        assert.equal(await store.count(), 3)
        assert.deepEqual(await store.missing(['absent']), ['absent'])
        assert.ok(!fs.existsSync(path.join(etlDir(), 'etl.sqlite')))
        assert.ok(!fs.existsSync(path.join(etlDir(), 'vectors')))
        return {
            pipelineRows: report.pipelines.count,
            vectorsCopied: vectorReport.vectors.count,
            unchangedEmbedded: second.counters.embedded,
            changedEmbedded: third.counters.embedded
        }
    } finally {
        useBackend(null)
        closeDb()
        LocalVectorStore.closeAll()
        fs.rmSync(root, { recursive: true, force: true })
    }
}
