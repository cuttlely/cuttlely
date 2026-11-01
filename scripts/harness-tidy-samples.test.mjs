// Tidy layout on the harness canvas changes card positions only. This runs the canvas Tidy on every shipped
// sample harness and compiles the tidied canvas with the harness runtime: the record the runtime runs is the
// same as for the untidied canvas. packages/ui/src/utils/tidyHarnessSamples.test.js covers load, save and reload.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tidy-'))
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const { rosterFromFlow } = await import('../packages/harness/sync-from-flow.mjs')
const { positionSnapshot, tidyStep } = await import('../packages/ui/src/utils/tidyHarnessLayout.js')

const samples = fs
    .readdirSync(path.join(ROOT, 'samples', 'harnesses'))
    .filter((file) => file.endsWith('.canvas.json'))
    .sort()

test('there are sample harness canvases', () => {
    assert.ok(samples.length > 0)
})

for (const file of samples) {
    test(`${file}: the tidied canvas compiles to the same harness`, () => {
        const record = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'harnesses', file), 'utf8'))
        const flow = JSON.parse(record.flowData)
        const step = tidyStep(flow.nodes, flow.edges)
        const tidied = { ...flow, nodes: step.nodes }
        assert.notDeepEqual(positionSnapshot(tidied.nodes), positionSnapshot(flow.nodes))
        const name = file.replace(/\.canvas\.json$/, '')
        const before = rosterFromFlow({ name, chatflowId: `sample-${name}`, flowData: JSON.stringify(flow) })
        const afterTidy = rosterFromFlow({ name, chatflowId: `sample-${name}`, flowData: JSON.stringify(tidied) })
        assert.deepEqual(afterTidy, before)
        assert.ok(afterTidy.specialists.length > 0)
    })
}
