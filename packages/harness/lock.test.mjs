import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-lock-'))
process.env.CUTTLELY_DATA_DIR = dir
const { acquireTurn, releaseTurn, renewTurn, database, closeQueueDb } = await import('./lock.mjs')
after(() => {
    closeQueueDb()
    fs.rmSync(dir, { recursive: true, force: true })
})
const lease = (held) => database().prepare('SELECT expires_at FROM turns WHERE session_key = ?').get(held.key)?.expires_at

test('renewal extends only its owner, reads the live TTL, and ignores released rows', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 })
    t.after(() => delete process.env.CUTTLELY_HARNESS_LOCK_MS)
    process.env.CUTTLELY_HARNESS_LOCK_MS = '300'
    const held = acquireTurn('lease', 'owner')
    const original = lease(held)
    t.mock.timers.tick(100)
    renewTurn({ ...held, owner: 'other' })
    assert.equal(lease(held), original)
    process.env.CUTTLELY_HARNESS_LOCK_MS = '600'
    renewTurn(held)
    assert.equal(lease(held), Date.now() + 600)
    releaseTurn(held)
    renewTurn(held)
    assert.equal(lease(held), undefined)
})

test('a zero TTL never expires and renewal makes no write', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 })
    t.after(() => delete process.env.CUTTLELY_HARNESS_LOCK_MS)
    process.env.CUTTLELY_HARNESS_LOCK_MS = '0'
    const held = acquireTurn('lease', 'unlimited')
    const original = lease(held)
    t.mock.timers.tick(86400000)
    renewTurn(held)
    assert.equal(lease(held), original)
    assert.throws(() => acquireTurn('lease', 'unlimited'), { code: 'busy' })
    releaseTurn(held)
})
