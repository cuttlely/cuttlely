import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import availability from '../availability.cjs'
import { rosterFromFlow } from '../sync-from-flow.mjs'
import { saveHarness } from '../store.mjs'

test('native outage admission proves the current roster, workspace and actual draft; old pinned turns still need the supervisor', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-outage-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    for (const [key, value] of Object.entries({ CUTTLELY_DATA_DIR: dir, CUTTLELY_NATIVE_PRIME_TEAMS: ' other , saved ' })) {
        const prior = process.env[key]
        process.env[key] = value
        t.after(() => (prior === undefined ? delete process.env[key] : (process.env[key] = prior)))
    }
    const canvas = JSON.parse(fs.readFileSync(new URL('../../../samples/harnesses/ops.canvas.json', import.meta.url)))
    const target = { ...canvas, name: 'saved', id: 'original-id', workspaceId: 'owner' }
    const parsed = rosterFromFlow({ ...target, chatflowId: target.id })
    saveHarness(parsed)
    const graph = JSON.parse(canvas.flowData)
    graph.nodes.find((n) => n.data.name === 'harnessSpecialist').data.inputs.enableShell = true
    const unsupported = JSON.stringify(graph)
    const refused = { code: 'RUNTIME_UNAVAILABLE', statusCode: 503, retryAfterSeconds: 5 }
    fs.writeFileSync(path.join(dir, 'hermes-supervisor.json'), JSON.stringify({ state: 'cooldown' }))
    assert.equal(availability.selectAgentEngine('saved'), 'native')
    assert.equal(availability.selectAgentEngine('sa'), 'hermes')
    assert.throws(() => availability.assertRuntimeAvailable(dir), refused)
    assert.throws(() => availability.assertRuntimeAvailable(dir, 'hermes'), refused)
    assert.doesNotThrow(() => availability.assertRuntimeAvailable(dir, 'native'))
    await availability.assertSelectedHarnessAvailable('saved', { workspaceId: 'owner' })
    await assert.rejects(availability.assertSelectedHarnessAvailable('saved', { workspaceId: 'other' }), refused)
    await assert.rejects(availability.assertSelectedHarnessAvailable('other', { record: parsed }), refused)
    // A native draft can run over an unsupported Live canvas and vice versa. The selected
    // canvas still has to supply its own complete, supported roster.
    await availability.assertSelectedHarnessAvailable('saved', {
        canvas: { ...target, flowData: unsupported },
        readFlowData: async () => canvas.flowData
    })
    await assert.rejects(
        availability.assertSelectedHarnessAvailable('saved', { canvas: target, readFlowData: async () => unsupported }),
        refused
    )
    assert.throws(() => availability.assertSelectedHarnessAvailable('unselected', { canvas: target, readFlowData: assert.fail }), refused)
    fs.writeFileSync(path.join(dir, 'hermes-supervisor.json'), JSON.stringify({ state: 'up' }))
    await availability.assertSelectedHarnessAvailable('saved', { canvas: target, readFlowData: assert.fail })
})
