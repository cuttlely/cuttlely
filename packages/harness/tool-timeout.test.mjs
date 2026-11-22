import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const top = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-tool-timeout-'))
const saved = { ...process.env }
process.env.HOME = top
process.env.DATABASE_PATH = top
process.env.CUTTLELY_DATA_DIR = top
process.env.CUTTLELY_HERMES_HOME = path.join(top, 'runtime')
// This compile-only fixture uses a harmless stdio server without loading a components build.
process.env.CUSTOM_MCP_SECURITY_CHECK = 'false'
delete process.env.CUTTLELY_HARNESS_TOOL_TIMEOUT_MS
const { saveHarness } = await import('./store.mjs')
const { compileProfileCached, profileOutdated, PROFILE_COMPILER_VERSION } = await import('./profile.mjs')
after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    fs.rmSync(top, { recursive: true, force: true })
})

test('profiles keep defaults when unset, apply the tool setting, and recompile in both directions', () => {
    const record = saveHarness({
        name: 'timeout-fixture',
        chief: { model: { nodeName: 'fixtureChat', inputs: { modelName: 'chief-model' } } },
        specialists: [
            {
                name: 'worker',
                shell: true,
                model: { nodeName: 'fixtureChat', inputs: { modelName: 'worker-model' } },
                modules: [{ nodeName: 'echoNode', label: 'Echo' }],
                mcpServers: [{ serverName: 'raw-fixture', config: { command: 'node', args: ['fixture.mjs'] } }]
            }
        ]
    })
    const read = (compiled, name) => fs.readFileSync(path.join(compiled.dir, '..', name, 'config.yaml'), 'utf8')
    const inspect = (compiled, timeout) => {
        const chiefYaml = fs.readFileSync(path.join(compiled.dir, 'config.yaml'), 'utf8')
        const specialistYaml = read(compiled, compiled.roster.specialists[0].profileName)
        assert.equal(/^    timeout: \.inf$/m.test(chiefYaml), true, 'roster keeps its infinite wait')
        assert.equal(/^    timeout: \.inf$/m.test(specialistYaml), false)
        for (const yaml of [chiefYaml, specialistYaml]) {
            assert.equal(/^timeouts:$/m.test(yaml), timeout !== undefined)
            assert.equal(yaml.includes('HERMES_CONCURRENT_TOOL_TIMEOUT_S'), false)
            const finite = [...yaml.matchAll(/^    timeout: (\d+)$/gm)].map((match) => Number(match[1]))
            assert.deepEqual(finite, timeout === undefined ? [] : Array(yaml === chiefYaml ? 1 : 2).fill(Math.ceil(timeout / 1000)))
            if (timeout !== undefined) {
                assert.equal(yaml.includes(`    sequential_call: ${Math.ceil(timeout / 1000) + 60}\n`), true)
                assert.equal(yaml.includes(`    concurrent_batch: ${Math.ceil(timeout / 1000) + 60}\n`), true)
            }
        }
        assert.equal(specialistYaml.includes(`CUTTLELY_HARNESS_TOOL_TIMEOUT_MS: "${timeout}"`), timeout !== undefined)
        if (timeout === undefined) assert.equal(specialistYaml.includes('CUTTLELY_HARNESS_TOOL_TIMEOUT_MS'), false)
        assert.equal(profileOutdated(record), false)
    }
    try {
        assert.equal(PROFILE_COMPILER_VERSION, '11')
        const initial = compileProfileCached(record)
        inspect(initial)
        assert.strictEqual(compileProfileCached(record), initial)
        process.env.CUTTLELY_HARNESS_TOOL_TIMEOUT_MS = '3660000'
        assert.equal(profileOutdated(record), true)
        const extended = compileProfileCached(record)
        assert.notStrictEqual(extended, initial)
        inspect(extended, 3660000)
        assert.strictEqual(compileProfileCached(record), extended)
        delete process.env.CUTTLELY_HARNESS_TOOL_TIMEOUT_MS
        assert.equal(profileOutdated(record), true)
        const reset = compileProfileCached(record)
        assert.notStrictEqual(reset, extended)
        inspect(reset)
        process.env.CUTTLELY_HARNESS_TOOL_TIMEOUT_MS = '1001'
        assert.equal(profileOutdated(record), true)
        inspect(compileProfileCached(record), 1001)
    } finally {
        delete process.env.CUTTLELY_HARNESS_TOOL_TIMEOUT_MS
    }
})
