// Runs the etl:check purge cases inside pnpm verify: deleting an ETL pipeline deletes its vectors from its store.
// node --test runs each file in its own process, so the check environment (a temp data dir) stays here.
import { describe, it } from 'node:test'

describe('ETL pipeline delete', () => {
    it('removes the vectors it wrote (including an earlier store), keeps other pipelines in a shared collection, blocks runs meanwhile, and survives a store that is down', async () => {
        await import('../etl/check/purge.mjs')
        if (process.exitCode) throw new Error('an etl:check purge case failed; see the FAIL line above')
    })
})
