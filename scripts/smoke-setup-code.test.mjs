import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setupCodeFromLogs, waitForSetupCode } from './smoke-server.mjs'

test('reads a fragment code and a legacy query code', () => {
    assert.equal(setupCodeFromLogs('Open http://localhost:3000/organization-setup#code=abc_DEF-12\n'), 'abc_DEF-12')
    assert.equal(setupCodeFromLogs('Open http://localhost:3000/organization-setup?code=legacyCode1\n'), 'legacyCode1')
    assert.equal(setupCodeFromLogs('Open http://localhost:3000/server-setup?next=1&code=legacyCode2\n'), 'legacyCode2')
})

test('polls until the code line shows up', async () => {
    const logs = []
    const source = { logs, setupCode: '' }
    setTimeout(() => {
        logs.push('👋 [server]: No account yet. Open http://localhost:3000/organization-setup#code=lateCode99\n')
    }, 120)
    const code = await waitForSetupCode(source, 1000)
    assert.equal(code, 'lateCode99')
})
