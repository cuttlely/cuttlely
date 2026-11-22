import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-limits-'))
const original = { ...process.env }
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
delete process.env.CUTTLELY_HERMES_STREAM_STALE_SECONDS
delete process.env.CUTTLELY_HERMES_TERMINAL_TIMEOUT
delete process.env.CUTTLELY_HERMES_CODE_TIMEOUT
const { saveHarness, getHarness } = await import('./store.mjs')
const { compileProfileCached, profileOutdated, streamStaleSeconds, configuredExecutionSeconds } = await import('./profile.mjs')
after(() => {
    for (const key of [
        'CUTTLELY_DATA_DIR',
        'CUTTLELY_HERMES_HOME',
        'CUTTLELY_HERMES_STREAM_STALE_SECONDS',
        'CUTTLELY_HERMES_TERMINAL_TIMEOUT',
        'CUTTLELY_HERMES_CODE_TIMEOUT'
    ]) {
        if (original[key] === undefined) delete process.env[key]
        else process.env[key] = original[key]
    }
    fs.rmSync(dir, { recursive: true, force: true })
})

test('silent stream reader bounds whole seconds and preserves the default', () => {
    assert.equal(streamStaleSeconds(), 45)
    for (const raw of ['', ' ', 'bad', '0', '4', '3601', '5.5']) {
        assert.equal(streamStaleSeconds({ CUTTLELY_HERMES_STREAM_STALE_SECONDS: raw }), 45)
    }
    assert.equal(streamStaleSeconds({ CUTTLELY_HERMES_STREAM_STALE_SECONDS: '3600' }), 3600)
})

test('stream limit refreshes compiled YAML and cache; older profiles stay current at the default', (t) => {
    // Profile compilation only needs a gateway address; it does not send requests.
    t.mock.method(http.Server.prototype, 'listen', function () {
        return this
    })
    saveHarness({
        name: 'profile-limits',
        chief: { model: { nodeName: 'chatOpenAI', inputs: { modelName: 'gpt-5.6-luna' } } },
        specialists: [{ name: 'worker', instructions: 'Answer the task.', shell: true, codeExecution: true, modules: [] }]
    })
    const record = getHarness('profile-limits')
    const compiled = compileProfileCached(record)
    const parent = compiled.dir
    const file = path.join(parent, 'harness-roster.json')
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'))
    const yamlFile = path.join(path.dirname(compiled.dir), read().specialists[0].profileName, 'config.yaml')
    const yaml = fs.readFileSync(yamlFile, 'utf8')
    assert.match(yaml, /stale_timeout_seconds: 45\n/)
    assert.equal(profileOutdated(record), false)
    const legacy = read()
    delete legacy.streamStaleSeconds
    fs.writeFileSync(file, JSON.stringify(legacy))
    assert.equal(profileOutdated(record), false)
    process.env.CUTTLELY_HERMES_STREAM_STALE_SECONDS = '120'
    assert.equal(profileOutdated(record), true)
    compileProfileCached(record)
    assert.equal(read().streamStaleSeconds, 120)
    assert.equal(fs.readFileSync(yamlFile, 'utf8'), yaml.replace('stale_timeout_seconds: 45', 'stale_timeout_seconds: 120'))
    assert.equal(profileOutdated(record), false)
    delete process.env.CUTTLELY_HERMES_STREAM_STALE_SECONDS
    assert.equal(profileOutdated(record), true)
    compileProfileCached(record)
    assert.equal(fs.readFileSync(yamlFile, 'utf8'), yaml)
    assert.doesNotMatch(yaml, /^ {2}timeout:/m)
    for (const raw of ['', 'bad', '0', '3601', '1.5']) assert.equal(configuredExecutionSeconds('cap', { cap: raw }), undefined)
    process.env.CUTTLELY_HERMES_TERMINAL_TIMEOUT = '900'
    process.env.CUTTLELY_HERMES_CODE_TIMEOUT = '1800'
    assert.equal(profileOutdated(record), true)
    compileProfileCached(record)
    assert.equal(read().terminalTimeoutSeconds, 900)
    assert.equal(read().codeTimeoutSeconds, 1800)
    const configured = fs.readFileSync(yamlFile, 'utf8')
    assert.match(configured, /terminal:\n {2}cwd: .*\n {2}timeout: 900\n/)
    assert.match(configured, /code_execution:\n {2}mode: project\n {2}timeout: 1800\n/)
    assert.equal(profileOutdated(record), false)
    delete process.env.CUTTLELY_HERMES_TERMINAL_TIMEOUT
    delete process.env.CUTTLELY_HERMES_CODE_TIMEOUT
    assert.equal(profileOutdated(record), true)
    compileProfileCached(record)
    assert.equal(fs.readFileSync(yamlFile, 'utf8'), yaml)
})
