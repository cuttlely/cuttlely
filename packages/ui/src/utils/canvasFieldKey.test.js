import fs from 'node:fs'
import path from 'node:path'
import { canvasFieldKey, canvasOutputKey, variableNodesSignature } from './canvasFieldKey'

const node = (value, outputs = { output: 'llmChain' }) => ({ id: 'promptTemplate_0', inputs: { template: value }, outputs })
const templateParam = { name: 'template', type: 'string' }

describe('canvasFieldKey', () => {
    it('stays the same while 20 characters are typed into the field', () => {
        const data = node('')
        const first = canvasFieldKey(data, templateParam)
        const typed = 'abcdefghijklmnopqrst'
        for (let i = 1; i <= typed.length; i++) {
            data.inputs.template = typed.slice(0, i)
            expect(canvasFieldKey(data, templateParam)).toBe(first)
        }
    })

    it('is different for each card, each field and each list item', () => {
        const keys = new Set([
            canvasFieldKey({ id: 'a' }, { name: 'x' }),
            canvasFieldKey({ id: 'b' }, { name: 'x' }),
            canvasFieldKey({ id: 'a' }, { name: 'y' }),
            canvasFieldKey({ id: 'a' }, { name: 'x' }, 0, { name: 'list' }),
            canvasFieldKey({ id: 'a' }, { name: 'x' }, 1, { name: 'list' })
        ])
        expect(keys.size).toBe(5)
    })
})

describe('canvasOutputKey', () => {
    const anchor = { id: 'promptTemplate_0-output-output', name: 'output' }

    it('does not change when an input on the same card changes', () => {
        const data = node('a')
        const before = canvasOutputKey(data, anchor)
        data.inputs.template = 'abcdef'
        expect(canvasOutputKey(data, anchor)).toBe(before)
    })

    it('changes when that output choice changes, so the dropdown shows it', () => {
        expect(canvasOutputKey(node('a', { output: 'one' }), anchor)).not.toBe(canvasOutputKey(node('a', { output: 'two' }), anchor))
    })

    it('is different for two outputs on the same card', () => {
        const data = node('a')
        expect(canvasOutputKey(data, anchor)).not.toBe(canvasOutputKey(data, { id: 'promptTemplate_0-output-other', name: 'other' }))
    })
})

// Guard: the canvas card fields must not go back to keys built from their value.
describe('canvas card keys', () => {
    const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')

    it('NodeInputHandler keys text and rich-text fields by card and field, not value', () => {
        const source = read('views/canvas/NodeInputHandler.jsx')
        expect(source).not.toMatch(/key=\{data\.inputs\[inputParam\.name\]\}/)
        expect(source.match(/key=\{canvasFieldKey\(data, inputParam, arrayIndex, parentParamForArray\)\}/g)).toHaveLength(2)
    })

    it('DocStoreInputHandler keys its text field by loader and field, not value', () => {
        const source = read('views/docstore/DocStoreInputHandler.jsx')
        expect(source).not.toMatch(/key=\{data\.inputs\[inputParam\.name\]\}/)
        expect(source).toMatch(/<Input\s+key=\{canvasFieldKey\(data, inputParam\)\}/)
    })

    it('CanvasNode does not key output handlers by the whole card', () => {
        const source = read('views/canvas/CanvasNode.jsx')
        expect(source).not.toMatch(/key=\{JSON\.stringify\(data\)\}/)
        expect(source).toMatch(/<NodeOutputHandler[^>]*key=\{`\$\{canvasOutputKey\(data, outputAnchor\)\}/)
    })
})

describe('variableNodesSignature', () => {
    const llm = (label, output = 'text') => ({
        id: 'llm_0',
        data: { id: 'llm_0', name: 'llmAgentflow', label, inputs: {}, outputs: { output } }
    })

    it('is the same for a fresh copy of the same nodes, so the rich-text editor is not rebuilt', () => {
        expect(variableNodesSignature([llm('Draft reply')])).toBe(variableNodesSignature([llm('Draft reply')]))
        expect(variableNodesSignature([])).toBe(variableNodesSignature([]))
    })

    it('changes when what the variable menu shows changes', () => {
        expect(variableNodesSignature([llm('Draft reply')])).not.toBe(variableNodesSignature([llm('Check order')]))
        expect(variableNodesSignature([llm('Draft reply')])).not.toBe(variableNodesSignature([llm('Draft reply', 'json')]))
        expect(variableNodesSignature([])).not.toBe(variableNodesSignature([llm('Draft reply')]))
    })
})

describe('RichInput', () => {
    it('keeps its variable node list while the list is unchanged', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'ui-component/input/RichInput.jsx'), 'utf8')
        expect(source).toMatch(
            /variableNodesSignature\(current\) === variableNodesSignature\(nodesForVariable\) \? current : nodesForVariable/
        )
    })
})
