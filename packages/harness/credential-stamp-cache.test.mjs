import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, test } from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-stamp-cache-'))
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
delete process.env.HERMES_API_URL

const { setCredentialSource, credentialStampAsync } = await import('./credential-store.mjs')
const { compileProfileCached, credentialIdsFor, forgetCompiledProfile, needsAgentLoop } = await import('./profile.mjs')
const { saveHarness, getHarness } = await import('./store.mjs')

after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
})

afterEach(() => {
    setCredentialSource(null)
})

function sampleRecord(name) {
    return {
        name,
        chatflowId: `${name}-flow`,
        chief: { instructions: 'Route.', model: { nodeName: 'chatXAI', label: 'xAI Grok', inputs: { modelName: 'grok-4.7' } } },
        specialists: [
            {
                name: 'alpha',
                instructions: 'Alpha work.',
                model: {
                    nodeName: 'chatXAI',
                    label: 'xAI Grok',
                    inputs: { modelName: 'grok-4.7' },
                    credentialId: 'cred-rotate'
                },
                fileAccess: true,
                modules: [{ nodeName: 'calculator', label: 'Calculator', category: 'Tools', inputs: {} }]
            }
        ]
    }
}

test('compileProfileCached reuses the object for the same passed stamp and recompiles when it changes', () => {
    const record = saveHarness(sampleRecord('stamp-cache-sync'), { overwrite: true })
    forgetCompiledProfile(record.name)
    const first = compileProfileCached(record, { credentialStamp: 'cred-rotate@c1' })
    const again = compileProfileCached(getHarness(record.name), { credentialStamp: 'cred-rotate@c1' })
    assert.equal(again, first)
    const rotated = compileProfileCached(getHarness(record.name), { credentialStamp: 'cred-rotate@c2' })
    assert.notEqual(rotated, first)
    forgetCompiledProfile(record.name)
    const fallback = compileProfileCached(getHarness(record.name))
    assert.ok(fallback)
})

test('credential rotation on a Postgres host changes the cache key and the next compile is a new object', async () => {
    let updated = new Date('2026-11-17T10:00:00.000Z')
    setCredentialSource({
        dialect: 'postgres',
        readRow: async (id) => ({ id, credentialName: 'openAIApi', encryptedData: 'pg' }),
        rows: async (ids) => ids.map((id) => ({ id, updatedDate: updated }))
    })
    const record = saveHarness(sampleRecord('stamp-cache-postgres'), { overwrite: true })
    assert.ok(needsAgentLoop(record.specialists[0]))
    const ids = credentialIdsFor(record)
    assert.deepEqual([...new Set(ids)], ['cred-rotate'])
    const firstStamp = await credentialStampAsync(ids)
    assert.equal(firstStamp, 'cred-rotate@2026-11-17T10:00:00.000Z')
    forgetCompiledProfile(record.name)
    const first = compileProfileCached(record, { credentialStamp: firstStamp })
    const again = compileProfileCached(getHarness(record.name), { credentialStamp: await credentialStampAsync(ids) })
    assert.equal(again, first)
    updated = new Date('2026-11-17T11:30:00.000Z')
    const rotatedStamp = await credentialStampAsync(ids)
    assert.equal(rotatedStamp, 'cred-rotate@2026-11-17T11:30:00.000Z')
    const third = compileProfileCached(getHarness(record.name), { credentialStamp: rotatedStamp })
    assert.notEqual(third, first)
})
