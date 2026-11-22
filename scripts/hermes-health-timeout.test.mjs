import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('./start-cuttlely.sh', import.meta.url), 'utf8')
const functionSource = (name) => source.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))[0]

test('health timeout validates seconds and reaches the HTTP probe in milliseconds without booting', () => {
    const top = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-health-timeout-'))
    const mock = path.join(top, 'mock-http.cjs')
    fs.writeFileSync(
        mock,
        `
        const { EventEmitter } = require('node:events')
        require('node:http').get = (options, callback) => {
            console.log(JSON.stringify({ timeout: options.timeout }))
            const req = new EventEmitter()
            queueMicrotask(() => callback({ resume() {}, statusCode: 200 }))
            return req
        }
    `
    )
    const script = `set -euo pipefail
${functionSource('hermes_number')}
${functionSource('configure_hermes_supervisor')}
${functionSource('hermes_answers_health')}
configure_hermes_supervisor
hermes_answers_health
`
    try {
        for (const [raw, seconds] of [
            [undefined, 2],
            ['1', 1],
            ['30', 30],
            ['5', 5],
            ['0', 2],
            ['31', 2],
            ['invalid', 2]
        ]) {
            const env = { ...process.env, HOME: top, DATABASE_PATH: top, NODE_BIN: process.execPath, NODE_OPTIONS: `--require=${mock}` }
            for (const key of Object.keys(env)) if (key.startsWith('CUTTLELY_HERMES_')) delete env[key]
            delete env.NODE_TEST_CONTEXT
            if (raw !== undefined) env.CUTTLELY_HERMES_HEALTH_TIMEOUT = raw
            const child = spawnSync('bash', ['-c', script], { env, encoding: 'utf8', timeout: 10000 })
            assert.ifError(child.error)
            assert.equal(child.status, 0, child.stderr)
            assert.equal(JSON.parse(child.stdout).timeout, seconds * 1000)
            if (['0', '31', 'invalid'].includes(raw)) assert.match(child.stderr, /CUTTLELY_HERMES_HEALTH_TIMEOUT.*Using 2/)
            else assert.equal(child.stderr, '')
        }
    } finally {
        fs.rmSync(top, { recursive: true, force: true })
    }
})

// The embedded probe can also be checked without creating a child process.
test('embedded health probe applies the configured seconds as milliseconds', () => {
    const probe = functionSource('hermes_answers_health').match(/"\$NODE_BIN" -e '([\s\S]*)' "/)[1]
    for (const seconds of [1, 2, 5, 30]) {
        let timeout
        const http = {
            get(options) {
                timeout = options.timeout
                return { on() {} }
            }
        }
        vm.runInNewContext(probe, {
            require: () => http,
            process: { env: {}, argv: ['node', String(seconds)] }
        })
        assert.equal(timeout, seconds * 1000)
    }
})
