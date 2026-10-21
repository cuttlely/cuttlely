import { readFileSync } from 'fs'
import { join } from 'path'

import { scanFlowiseMigration as scanImport } from './flowiseMigration.mjs'
import { flowiseNodeCatalog as nodeCatalog } from './flowiseCatalog'

const fixture = (name) => JSON.parse(readFileSync(join(__dirname, '__fixtures__/import', name), 'utf8'))

const scan = (parsed) => scanImport(parsed, { catalog: nodeCatalog })

describe('migration scan', () => {
    it('lists a model credential for a model setting that does not store one', () => {
        const report = scan(fixture('agentic-rag-v2.json'))
        expect(report.level).not.toBe('compatible')
        expect(report.credentials.some((item) => item.nodeId === 'llmAgentflow_0' && item.slot === 'Model credential')).toBe(true)
    })

    it('refuses a tool file with the tools load message', () => {
        const report = scan(fixture('make-webhook.json'))
        expect(report.ok).toBe(false)
        expect(report.code).toBe('tool')
        expect(report.title).toBe('This is a Flowise tool, not a flow. Open Tools > Load to import it.')
        expect(report.canvas).toBeNull()
    })

    it('lists a custom tool that is only an id', () => {
        const report = scan(fixture('text-to-sql.json'))
        expect(report.level).not.toBe('compatible')
        expect(report.attention).toContain(
            "Custom tool 00000000-0000-4000-8000-000000000002 on 'Custom Tool'. Recreate it in Tools, then pick it in this node."
        )
    })
})
