import assert from 'node:assert/strict'
import { configureHarnessPostgres } from '../../harness/side-store-postgres.mjs'
import { acquireTurn, acquireTryProfileTurn } from '../../harness/lock.mjs'
import { appendTurn, readMessages } from '../../harness/session.mjs'

process.once('message', async ({ config }) => {
    try {
        configureHarnessPostgres(config)
        assert.throws(() => acquireTurn('team', 'chat'), { code: 'busy' })
        await assert.rejects(acquireTryProfileTurn('canvas'), { code: 'busy' })
        assert.equal(readMessages('team', 'chat').length, 2)
        appendTurn('team', 'chat', 'worker question', 'worker answer')
    } finally {
        configureHarnessPostgres(null)
        process.disconnect()
    }
})
