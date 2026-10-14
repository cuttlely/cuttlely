// The sample exports used by the docs screenshots. No credentials and no prices.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanFlowiseMigration } from '../../packages/ui/src/utils/flowiseMigration.mjs'
import { isLangflowExport, langflowToFlowise } from '../../packages/ui/src/utils/langflowImport.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const catalog = JSON.parse(readFileSync(join(ROOT, 'packages/components/nodes/module-catalog.json'), 'utf8'))
const read = (name) => JSON.parse(readFileSync(join(ROOT, 'examples/imports', name), 'utf8'))

describe('docs import samples', () => {
    it('Bakery helper scans as a chatflow with one cleared credential and no secrets', () => {
        const file = read('bakery-helper.json')
        const dumped = JSON.stringify(file)
        assert.equal(/sk-|api[_-]?key|postgres:\/\//i.test(dumped), false)
        const report = scanFlowiseMigration(file, { catalog })
        assert.equal(report.ok, true)
        assert.equal(report.level, 'attention')
        assert.equal(report.title, 'Ready to open, with items to finish')
        assert.equal(report.counts.nodes, 3)
        assert.equal(report.counts.edges, 2)
        assert.equal(report.counts.clean, 2)
        assert.deepEqual(report.fixes, ['Cleared the credential on ChatOpenAI. The saved value was not copied.'])
        assert.equal(report.credentials.length, 1)
        assert.equal(report.credentials[0].label, 'ChatOpenAI')
        assert.equal(report.credentials[0].slot, 'Connect Credential')
        assert.equal(JSON.stringify(report).includes('demo-slot'), false)
        assert.equal(report.canvas.nodes[0].data.inputs.modelName, 'gpt-4.1-mini')
    })

    it('Bakery greeter is one Langflow chat with a model name and no key', () => {
        const file = read('bakery-greeter.json')
        assert.equal(/sk-|api[_-]?key|price|\$\d/i.test(JSON.stringify(file)), false)
        assert.equal(isLangflowExport(file), true)
        const result = langflowToFlowise(file)
        assert.equal(result.ok, true)
        assert.equal(result.name, 'Bakery greeter')
        const model = result.flow.nodes.find((node) => node.data.name === 'chatOpenAI')
        assert.equal(model.data.inputs.modelName, 'gpt-4.1-mini')
        assert.equal(model.data.inputs.temperature, 0.2)
        assert.equal(JSON.stringify(result).includes('api_key'), false)
    })
})
