// Saved custom functions and custom tools run in NodeVM. An operator can allow the
// earlier components specifier through TOOL_FUNCTION_EXTERNAL_DEP. The compatibility
// alias on the workspace root keeps that require working.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

function legacyComponentsSpecifier() {
    const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    const match = Object.entries(root.dependencies ?? {}).find(([, spec]) => spec === 'workspace:@cuttlely/components@*')
    assert.ok(match, 'compatibility alias for the components package is missing')
    return match[0]
}

describe('components package compatibility alias', () => {
    const previous = process.env.TOOL_FUNCTION_EXTERNAL_DEP

    afterEach(() => {
        if (previous === undefined) delete process.env.TOOL_FUNCTION_EXTERNAL_DEP
        else process.env.TOOL_FUNCTION_EXTERNAL_DEP = previous
    })

    it('runs a saved flow whose custom function requires the alias', async () => {
        const specifier = legacyComponentsSpecifier()
        assert.equal(require.resolve(specifier), require.resolve('@cuttlely/components'))

        const savedFlow = {
            name: 'Saved custom function',
            type: 'CHATFLOW',
            deployed: false,
            flowData: JSON.stringify({
                nodes: [
                    {
                        id: 'customFunction_0',
                        type: 'customNode',
                        position: { x: 0, y: 0 },
                        data: {
                            id: 'customFunction_0',
                            name: 'customFunction',
                            label: 'Custom JS Function',
                            type: 'CustomFunction',
                            version: 3.0,
                            category: 'Utilities',
                            inputs: {
                                javascriptFunction: [
                                    `const components = require('${specifier}')`,
                                    "if (typeof components.handleEscapeCharacters !== 'function') return 'missing'",
                                    'return 7'
                                ].join('\n')
                            }
                        }
                    }
                ],
                edges: [],
                viewport: { x: 0, y: 0, zoom: 1 }
            })
        }

        const flow = JSON.parse(savedFlow.flowData)
        const entry = require.resolve('@cuttlely/components')
        const nodePath = path.join(path.dirname(entry), '..', 'nodes', 'utilities', 'CustomFunction', 'CustomFunction.js')
        const { nodeClass: CustomFunction } = require(nodePath)
        process.env.TOOL_FUNCTION_EXTERNAL_DEP = specifier
        const result = await new CustomFunction().init(flow.nodes[0].data, 'hello', { skipVariables: true })
        assert.equal(result, 7)
    })
})
