import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
test('real file-backed saved roster and actual caller validation, restricted role changes and separate published owners', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-pair-owner-'))
    process.env.CUTTLELY_DATA_DIR = dir
    process.env.CUTTLELY_HERMES_HOME = dir + '/profiles'
    t.after(() => {
        fs.rmSync(dir, { recursive: true, force: true })
    })
    const { saveHarness } = await import('./store.mjs'),
        { pairedWorkerRecord } = await import('./run.mjs')
    const name = 'Books'
    const record = {
        name,
        workspaceId: 'site',
        chatflowId: 'canvas',
        chief: { model: { nodeName: 'chatOpenAI', credential: 'synthetic', inputs: { modelName: 'fixture' } } },
        specialists: [
            {
                name: 'catalog',
                modules: [
                    {
                        nodeName: 'retrieverTool',
                        inputs: { name: 'catalog' },
                        upstream: {
                            retriever: {
                                nodeName: 'pinecone',
                                credential: 'vector',
                                inputs: { pineconeIndex: 'catalog' },
                                outputs: { output: 'retriever' },
                                upstream: {
                                    embeddings: {
                                        nodeName: 'openAIEmbeddings',
                                        credential: 'embed',
                                        inputs: { modelName: 'text-embedding-3-small' }
                                    }
                                }
                            }
                        }
                    }
                ]
            }
        ]
    }
    const p = {
        name,
        workspaceId: 'site',
        expectedHarnessChatflowId: 'canvas',
        apiKeyId: 'local',
        mode: 'agent',
        source: 'api',
        engine: 'native',
        caller: { via: 'api_key', apiKeyId: 'local', harnesses: [name], harnessIds: { Books: 'canvas' } }
    }
    saveHarness(record)
    const inspect = (props = {}) => pairedWorkerRecord({ id: 'example', payload: { ...p, ...props } })
    const grant = inspect()
    assert.equal(grant.record.name, name)
    assert.deepEqual(JSON.parse(grant.content), grant.record)
    assert.throws(() => inspect({ caller: { ...p.caller, harnesses: [] } }), { code: 'key_not_allowed' })
    for (const edit of [
        { workspaceId: 'foreign' },
        { expectedHarnessChatflowId: 'replacement' },
        { apiKeyId: 'replacement' },
        { mode: 'router' },
        { source: 'schedule' },
        { offlineModel: true },
        { trustedOutputPreview: true },
        { engine: 'hermes' },
        { images: ['fixture'] },
        { nativeRolePin: {} }
    ])
        assert.equal(inspect(edit), undefined)
    for (const change of [
        { ...record, chief: { ...record.chief, model: { ...record.chief.model, nodeName: 'chatXAI' } } },
        { ...record, specialists: [...record.specialists, ...record.specialists.map((role) => ({ ...role, name: 'second' }))] },
        { ...record, specialists: [{ ...record.specialists[0], modules: [{ nodeName: 'calculator' }] }] },
        { ...record, specialists: [{ ...record.specialists[0], model: record.chief.model }] }
    ]) {
        saveHarness(change, { overwrite: true })
        assert.equal(inspect(), undefined)
    }
    saveHarness({ ...record, specialists: [{ name: 'catalog', shell: true, modules: [] }] }, { overwrite: true })
    assert.equal(inspect(), undefined)
    assert.equal(grant.record.specialists[0].shell, false)
    assert.equal(grant.record.specialists[0].modules[0].nodeName, 'retrieverTool')
    // Only the synthetic saved JSON roster exists. The classifier never opened an app or database.
    const files = fs.readdirSync(dir, { recursive: true })
    assert.ok(files.some((x) => x.endsWith('Books.json')))
    assert.ok(files.every((x) => !/(?:\.sqlite|\.db)$/.test(x)))
})
