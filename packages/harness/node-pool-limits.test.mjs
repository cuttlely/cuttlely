import test from 'node:test'
import { workerLimits } from '../../scripts/fixtures/harness-worker-limits.mjs'

for (const host of [true, false]) {
    test(`external worker refreshes all live limits after save and clear (host=${host})`, (t) => workerLimits(t, host))
}
