import { test } from 'node:test'
import { createTestSource, skipReason } from './pg-source.mjs'
import { checkStorageUpgrade } from './storage-upgrade.mjs'

test('SQLite ETL and vector snapshots retain incremental state across a verified PostgreSQL copy', { skip: skipReason }, async () => {
    const source = await createTestSource()
    try {
        await checkStorageUpgrade(source)
    } finally {
        await source.cleanup()
    }
})

test('published and draft sessions, schedules and cross-process leases survive migration', { skip: skipReason }, async () => {
    const { checkHarnessUpgrade } = await import('./harness-upgrade.mjs')
    const source = await createTestSource()
    try {
        await checkHarnessUpgrade(source, source.connection)
    } finally {
        await source.cleanup()
    }
})
