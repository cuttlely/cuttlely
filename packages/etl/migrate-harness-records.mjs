import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { harnessStoreDir } from '../harness/paths.mjs'
import { recordEntry } from '../harness/record-files.mjs'
import { postgresHarnessDdl } from '../harness/side-store-schema.mjs'
import { registerSideSchema } from '../harness/side-store-identity.mjs'

function entries() {
    const dir = harnessStoreDir()
    try {
        if (!lstatSync(dir).isDirectory()) throw new Error('Resolve the linked harness store before upgrading.')
        return readdirSync(dir).sort()
    } catch (error) {
        if (error.code === 'ENOENT') return []
        throw error
    }
}

function content(entry) {
    if (!recordEntry.test(entry)) throw new Error('Resolve the unrecognized file in the saved agent team directory before upgrading.')
    const fd = openSync(path.join(harnessStoreDir(), entry), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
        if (!fstatSync(fd).isFile()) throw new Error('Resolve the non-regular saved agent team record before upgrading.')
        const bytes = readFileSync(fd)
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
        if (JSON.parse(text)?.name !== entry.split('.')[0])
            throw new Error('Resolve the mismatched name in the saved agent team record before upgrading.')
        return text
    } finally {
        closeSync(fd)
    }
}

export function harnessRecordInventory() {
    return entries().map((entry) => {
        const text = content(entry)
        return { entry, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }
    })
}

export async function copyHarnessRecords(source, inventory) {
    await source.transaction(async (tx) => {
        const schema = 'cuttlely_harness_queue'
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema])
        await tx.query('CREATE SCHEMA IF NOT EXISTS ' + schema)
        await tx.query('SET LOCAL search_path TO ' + schema + ',pg_catalog')
        await tx.query(postgresHarnessDdl('queue'))
        await registerSideSchema(async (sql, params) => ({ rows: await tx.query(sql, params) }), schema)
        for (const { entry, sha256 } of inventory) {
            const text = content(entry)
            if (createHash('sha256').update(text).digest('hex') !== sha256) throw new Error('The saved agent team changed after inventory.')
            await tx.query('INSERT INTO harness_records(entry,content) VALUES($1,$2) ON CONFLICT DO NOTHING', [entry, text])
            const [row] = await tx.query('SELECT content FROM harness_records WHERE entry=$1', [entry])
            if (row.content !== text) throw new Error('The PostgreSQL saved agent team differs from its source.')
        }
        const [row] = await tx.query('SELECT count(*) AS count FROM harness_records')
        if (Number(row.count) !== inventory.length) throw new Error('The destination contains additional saved agent teams.')
    })
}
