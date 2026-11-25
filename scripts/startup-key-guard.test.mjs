import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dataEnv, freePort, startServer, waitForPing } from './upgrade-check.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const fixtureKey = 'test-only-startup-key-before'
const wrongKey = 'test-only-startup-key-after'

test('server and worker refuse an absent host key, and a replacement server verifies the enrolled key', { timeout: 60000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cuttlely-key-guard-'))
    const port = await freePort()
    const env = dataEnv(dir, port, { CUTTLELY_REQUIRE_KEY_OVERRIDE: 'true' })
    let server
    try {
        for (const command of ['start', 'worker']) {
            const result = spawnSync(process.execPath, [path.join(root, 'packages/server/bin/run'), command], {
                cwd: path.join(root, 'packages/server'),
                env,
                encoding: 'utf8',
                timeout: 10000
            })
            assert.ifError(result.error)
            assert.notEqual(result.status, 0)
            assert.match(result.stderr, /requires a nonblank installation encryption-key override/)
        }

        const enrolled = { ...env, CUTTLELY_SECRETKEY_OVERWRITE: fixtureKey }
        const base = `http://127.0.0.1:${port}`
        server = await startServer(root, enrolled)
        await waitForPing(base, server)
        await server.stop()

        server = await startServer(root, { ...enrolled, CUTTLELY_SECRETKEY_OVERWRITE: wrongKey })
        const code = server.child.exitCode ?? (await once(server.child, 'close', { signal: AbortSignal.timeout(15000) }))[0]
        assert.equal(code, 1)
        const output = server.logs.join('')
        assert.ok(output.includes('The installation encryption key could not be verified.'))
        assert.ok(!output.includes(fixtureKey) && !output.includes(wrongKey))

        server = await startServer(root, enrolled)
        await waitForPing(base, server)
    } finally {
        await server?.stop()
        rmSync(dir, { recursive: true, force: true })
    }
})
