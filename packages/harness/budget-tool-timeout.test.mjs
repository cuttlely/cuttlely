import assert from 'node:assert/strict'
import { test } from 'node:test'
import { harnessToolTimeoutMs } from './budget.mjs'

test('tool timeout parser leaves invalid settings unset and accepts the inclusive ceiling', () => {
    for (const raw of [undefined, '', ' ', 'invalid', '0', '-1', '1.5', '3660001', 'Infinity']) {
        const env = raw === undefined ? {} : { CUTTLELY_HARNESS_TOOL_TIMEOUT_MS: raw }
        assert.equal(harnessToolTimeoutMs(env), undefined)
    }
    for (const ms of [1, 999, 1001, 3600000, 3660000]) {
        assert.equal(harnessToolTimeoutMs({ CUTTLELY_HARNESS_TOOL_TIMEOUT_MS: String(ms) }), ms)
    }
})
