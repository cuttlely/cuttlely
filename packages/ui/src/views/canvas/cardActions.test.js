import fs from 'fs'
import path from 'path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import {
    actionBarSide,
    applyCanvasChanges,
    dispatchCanvasChanges,
    cardActionNames,
    nodesAfterConnectedDelete,
    panelHeaderActions,
    panelStateWhenNodesChange,
    showCardActions
} from './cardActions'
import NodePanelHeader from './NodePanelHeader'

const theme = createTheme({
    palette: {
        text: { primary: '#ffffff' },
        background: { paper: '#1b1913', default: '#14120b' },
        divider: '#2b2923'
    }
})

describe('card action visibility', () => {
    test('shows the toolbar on hover and on the selected card, and not when the canvas is read-only', () => {
        expect(showCardActions({ hovered: true })).toBe(true)
        expect(showCardActions({ selected: true })).toBe(true)
        expect(showCardActions({ hovered: false, selected: false })).toBe(false)
        expect(showCardActions({ hovered: true, selected: true, readOnly: true })).toBe(false)
    })

    test('every card except the start card can be duplicated, and read-only canvases have no destructive actions', () => {
        expect(cardActionNames({ nodeName: 'directReplyAgentflow' })).toEqual(['duplicate', 'delete', 'info'])
        expect(cardActionNames({ nodeName: 'startAgentflow' })).toEqual(['delete', 'info'])
        expect(cardActionNames({ nodeName: 'stickyNote', includeInfo: false })).toEqual(['duplicate', 'delete'])
        expect(cardActionNames({ nodeName: 'promptTemplate', readOnly: true })).toEqual([])
    })

    test('the settings header has Duplicate, Delete, and Close, and a read-only panel keeps only Close', () => {
        expect(panelHeaderActions({ nodeName: 'promptTemplate' })).toEqual({ duplicate: true, delete: true, close: true })
        expect(panelHeaderActions({ nodeName: 'startAgentflow' })).toEqual({ duplicate: false, delete: true, close: true })
        expect(panelHeaderActions({ nodeName: 'promptTemplate', readOnly: true })).toEqual({
            duplicate: false,
            delete: false,
            close: true
        })
    })
})

describe('action bar side', () => {
    const card = { left: 400, top: 200, width: 200, right: 600, bottom: 280 }
    const bar = { width: 96, height: 32 }
    const canvas = { left: 0, top: 70, right: 1440, bottom: 900 }

    test('stays above the card when that place is on the canvas and clear of floating buttons', () => {
        expect(actionBarSide({ card, bar, canvas, overlays: [{ left: 1200, top: 90, right: 1280, bottom: 130 }] })).toBe('above')
    })

    test('moves below the card when the top of the canvas would clip it', () => {
        expect(actionBarSide({ card: { ...card, top: 74, bottom: 150 }, bar, canvas })).toBe('below')
    })

    test('moves below the card when a floating button would cover it', () => {
        const lower = { left: 500, top: 140, width: 180, right: 680, bottom: 220 }
        const button = { left: 540, top: 100, right: 620, bottom: 140 }
        expect(actionBarSide({ card: lower, bar, canvas, overlays: [button] })).toBe('below')
    })
})

describe('panel id after a card is deleted', () => {
    test('clears the open panel when its card is gone, so a reused id does not show the deleted settings', () => {
        const settings = { template: 'Hello from the deleted card' }
        const open = {
            panelNodeId: 'promptTemplate_0',
            panelProps: { data: { id: 'promptTemplate_0', inputs: settings } },
            nodes: [{ id: 'promptTemplate_0', data: { inputs: settings } }]
        }
        const deleted = panelStateWhenNodesChange({ ...open, nodes: [] })
        expect(deleted).toEqual({ panelNodeId: null, panelProps: {} })
        const reused = panelStateWhenNodesChange({
            ...deleted,
            nodes: [{ id: 'promptTemplate_0', data: { inputs: { template: '' } } }]
        })
        expect(reused.panelNodeId).toBe(null)
        expect(reused.panelProps).toEqual({})
        expect(JSON.stringify(reused)).not.toContain('Hello from the deleted card')
    })

    test('keeps the panel while its card is still on the canvas', () => {
        const state = panelStateWhenNodesChange({
            panelNodeId: 'promptTemplate_0',
            panelProps: { data: { id: 'promptTemplate_0' } },
            nodes: [{ id: 'promptTemplate_0' }]
        })
        expect(state.panelNodeId).toBe('promptTemplate_0')
    })
})

describe('settings panel header', () => {
    const header = (props) =>
        renderToStaticMarkup(createElement(ThemeProvider, { theme }, createElement(NodePanelHeader, { label: 'Reply', ...props })))

    test('renders Duplicate, Delete, and a close button that uses the theme text color', () => {
        const html = header({
            onDuplicate: () => {},
            onDelete: () => {},
            onClose: () => {}
        })
        expect(html).toContain('aria-label="Duplicate"')
        expect(html).toContain('aria-label="Delete"')
        expect(html).toContain('aria-label="Close settings"')
        expect(html).toContain('data-testid="close-settings"')
        const source = fs.readFileSync(path.join(__dirname, 'NodePanelHeader.jsx'), 'utf8')
        expect(source).toMatch(/color: 'text\.primary'/)
    })

    test('a read-only header has the close button and no Duplicate or Delete', () => {
        const html = header({ readOnly: true, nodeName: 'promptTemplate', onClose: () => {} })
        expect(html).not.toContain('aria-label="Duplicate"')
        expect(html).not.toContain('aria-label="Delete"')
        expect(html).toContain('aria-label="Close settings"')
    })

    test('the start card header has Delete and Close, and no Duplicate', () => {
        const html = header({ nodeName: 'startAgentflow', onDelete: () => {}, onClose: () => {} })
        expect(html).not.toContain('aria-label="Duplicate"')
        expect(html).toContain('aria-label="Delete"')
        expect(html).toContain('aria-label="Close settings"')
    })
})

function connectedCanvas() {
    return {
        dirty: false,
        nodes: [
            { id: 'promptTemplate_0', data: { name: 'promptTemplate', inputs: { template: '' } } },
            { id: 'promptTemplate_1', data: { name: 'promptTemplate', inputs: { template: '' } } },
            {
                id: 'llmChain_0',
                data: {
                    name: 'llmChain',
                    inputAnchors: [{ name: 'tools', list: true }],
                    inputParams: [{ name: 'prompt', acceptVariable: true }],
                    inputs: {
                        prompt: 'Hello {{promptTemplate_0.data.instance}}',
                        tools: ['{{promptTemplate_0.data.instance}}', '{{promptTemplate_1.data.instance}}', 'keep']
                    }
                }
            },
            { id: 'startAgentflow_0', data: { name: 'startAgentflow', inputs: {} } }
        ],
        edges: [
            {
                id: 'e0',
                source: 'promptTemplate_0',
                target: 'llmChain_0',
                targetHandle: 'llmChain_0-input-prompt-string'
            },
            {
                id: 'e0tools',
                source: 'promptTemplate_0',
                target: 'llmChain_0',
                targetHandle: 'llmChain_0-input-tools-array'
            },
            {
                id: 'e1',
                source: 'promptTemplate_1',
                target: 'llmChain_0',
                targetHandle: 'llmChain_0-input-tools-array'
            }
        ]
    }
}

// The same path both editor canvases use. deleteNode and deleteEdge mark the canvas unsaved and clear references.
function applyKey(state, nodeChanges, edgeChanges) {
    const applied = { nodes: [], edges: [] }
    const deleteNode = (id) => {
        state.nodes = nodesAfterConnectedDelete(state.nodes, state.edges, id, 'node')
        state.nodes = state.nodes.filter((node) => node.id !== id)
        state.edges = state.edges.filter((edge) => edge.source !== id && edge.target !== id)
        state.dirty = true
    }
    const deleteEdge = (id) => {
        state.nodes = nodesAfterConnectedDelete(state.nodes, state.edges, id, 'edge')
        state.edges = state.edges.filter((edge) => edge.id !== id)
        state.dirty = true
    }
    applyCanvasChanges(nodeChanges, {
        remove: deleteNode,
        apply: (rest) => applied.nodes.push(...rest)
    })
    applyCanvasChanges(edgeChanges, {
        remove: deleteEdge,
        apply: (rest) => applied.edges.push(...rest)
    })
    return applied
}

describe('keyboard delete on a connected card', () => {
    test.each(['Delete', 'Backspace'])('%s marks the canvas unsaved and clears the downstream reference', (key) => {
        const state = connectedCanvas()
        const applied = applyKey(
            state,
            [
                { type: 'remove', id: 'promptTemplate_0', key },
                { type: 'position', id: 'llmChain_0', position: { x: 4, y: 8 } }
            ],
            [
                { type: 'remove', id: 'e0', key },
                { type: 'remove', id: 'e0tools', key }
            ]
        )
        expect(state.dirty).toBe(true)
        expect(state.nodes.map((node) => node.id)).not.toContain('promptTemplate_0')
        expect(state.nodes.map((node) => node.id)).toContain('startAgentflow_0')
        const chain = state.nodes.find((node) => node.id === 'llmChain_0')
        expect(chain.data.inputs.prompt).toBe('Hello ')
        expect(JSON.stringify(chain.data.inputs)).not.toContain('promptTemplate_0')
        expect(chain.data.inputs.tools).toEqual(['{{promptTemplate_1.data.instance}}', 'keep'])
        expect(applied.nodes).toEqual([{ type: 'position', id: 'llmChain_0', position: { x: 4, y: 8 } }])
        expect(applied.edges).toEqual([])
    })

    test('Delete removes every selected card and leaves the start card', () => {
        const state = connectedCanvas()
        applyKey(
            state,
            [
                { type: 'remove', id: 'promptTemplate_0' },
                { type: 'remove', id: 'promptTemplate_1' }
            ],
            [
                { type: 'remove', id: 'e0' },
                { type: 'remove', id: 'e0tools' },
                { type: 'remove', id: 'e1' }
            ]
        )
        expect(state.dirty).toBe(true)
        expect(state.nodes.map((node) => node.id).sort()).toEqual(['llmChain_0', 'startAgentflow_0'])
        const chain = state.nodes.find((node) => node.id === 'llmChain_0')
        expect(chain.data.inputs.prompt).toBe('Hello ')
        expect(chain.data.inputs.tools).toEqual(['keep'])
        expect(state.edges).toEqual([])
    })

    test('a delete that updates the canvas does not delete again', () => {
        const applying = { current: false }
        const applied = []
        const removed = []
        dispatchCanvasChanges([{ type: 'remove', id: 'promptTemplate_0' }], {
            applying,
            remove: (id) => {
                removed.push(id)
                dispatchCanvasChanges(
                    [
                        { type: 'reset', item: { id: 'llmChain_0' } },
                        { type: 'remove', id: 'e0' }
                    ],
                    {
                        applying,
                        remove: (nested) => removed.push(nested),
                        apply: (rest) => applied.push(...rest)
                    }
                )
            },
            apply: (rest) => applied.push(...rest)
        })
        expect(removed).toEqual(['promptTemplate_0'])
        expect(applied.map((change) => change.type)).toEqual(['reset', 'remove'])
        expect(applying.current).toBe(false)
    })

    test('both editor canvases send remove changes through that path', () => {
        const files = [path.join(__dirname, 'index.jsx'), path.join(__dirname, '../agentflowsv2/Canvas.jsx')]
        for (const file of files) {
            const source = fs.readFileSync(file, 'utf8')
            expect(source).toContain('dispatchCanvasChanges')
            expect(source).toContain('onNodesChange={handleNodesChange}')
            expect(source).toContain('onEdgesChange={handleEdgesChange}')
            expect(source).not.toContain('onNodesChange={onNodesChange}')
        }
    })
})
