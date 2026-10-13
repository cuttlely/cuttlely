/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
import fs from 'fs'
import path from 'path'
import PropTypes from 'prop-types'
import { createElement, useContext, useEffect } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import { render, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { createStore } from 'redux'

import { SET_DIRTY } from '@/store/actions'
import { ReactFlowContext, flowContext } from '@/store/context/ReactFlowContext'
import {
    actionBarSide,
    canvasAfterDelete,
    cardActionNames,
    createCanvasDeleteQueue,
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

// React Flow 11.10.4 turns each controlled setNodes / setEdges into a reset of the array it was given,
// and getNodes / getEdges stay on the pre-delete objects until the handler returns.
function createReactFlow11Store(nodes, edges) {
    const state = {
        nodes,
        edges,
        nodeWrites: [],
        edgeWrites: [],
        passthrough: []
    }
    let onNodesChange = () => {}
    let onEdgesChange = () => {}
    const write = (kind, payload, current, emit) => {
        const next = typeof payload === 'function' ? payload(current) : payload
        ;(kind === 'node' ? state.nodeWrites : state.edgeWrites).push(next)
        const changes =
            next.length === 0 ? current.map((item) => ({ type: 'remove', id: item.id })) : next.map((item) => ({ type: 'reset', item }))
        emit(changes)
    }
    return {
        state,
        instance: {
            getNodes: () => state.nodes,
            getEdges: () => state.edges,
            setNodes: (payload) => write('node', payload, state.nodes, (changes) => onNodesChange(changes)),
            setEdges: (payload) => write('edge', payload, state.edges, (changes) => onEdgesChange(changes))
        },
        setHandlers(handlers) {
            onNodesChange = handlers.nodes
            onEdgesChange = handlers.edges
        },
        saved() {
            return {
                nodes: state.renderedNodes ?? state.nodeWrites[state.nodeWrites.length - 1] ?? state.nodes,
                edges: state.renderedEdges ?? state.edgeWrites[state.edgeWrites.length - 1] ?? state.edges
            }
        }
    }
}

function flowGraph() {
    return {
        nodes: [
            { id: 'promptTemplate_0', data: { name: 'promptTemplate', inputs: {} } },
            { id: 'promptTemplate_1', data: { name: 'promptTemplate', inputs: {} } },
            {
                id: 'loop_0',
                data: { name: 'iteration', inputs: {} }
            },
            {
                id: 'child_0',
                parentNode: 'loop_0',
                data: { name: 'promptTemplate', inputs: {} }
            },
            {
                id: 'llmChain_0',
                data: {
                    name: 'llmChain',
                    inputAnchors: [{ name: 'tools', list: true }],
                    inputParams: [{ name: 'prompt', acceptVariable: true }],
                    inputs: {
                        prompt: '{{promptTemplate_0.data.instance}} {{child_0.data.instance}}',
                        tools: ['{{promptTemplate_0.data.instance}}', '{{promptTemplate_1.data.instance}}', 'keep']
                    }
                }
            },
            { id: 'startAgentflow_0', data: { name: 'startAgentflow', inputs: {} } }
        ],
        edges: [
            { id: 'e0', source: 'promptTemplate_0', target: 'llmChain_0', targetHandle: 'llmChain_0-input-prompt-string' },
            { id: 'e0tools', source: 'promptTemplate_0', target: 'llmChain_0', targetHandle: 'llmChain_0-input-tools-array' },
            { id: 'e1', source: 'promptTemplate_1', target: 'llmChain_0', targetHandle: 'llmChain_0-input-tools-array' },
            { id: 'eChild', source: 'child_0', target: 'llmChain_0', targetHandle: 'llmChain_0-input-prompt-string' }
        ]
    }
}

function Grab({ instance, rememberNodes, rememberEdges, api }) {
    const ctx = useContext(flowContext)
    useEffect(() => {
        ctx.setReactFlowInstance(instance)
        ctx.bindCanvasState(rememberNodes, rememberEdges)
        api.current = ctx
    })
    return null
}

Grab.propTypes = {
    instance: PropTypes.object.isRequired,
    rememberNodes: PropTypes.func.isRequired,
    rememberEdges: PropTypes.func.isRequired,
    api: PropTypes.object.isRequired
}

function mountCanvas(graph) {
    const rf = createReactFlow11Store(graph.nodes, graph.edges)
    const redux = createStore((state = { dirty: 0 }, action) => (action.type === SET_DIRTY ? { dirty: state.dirty + 1 } : state))
    const api = { current: null }
    const rememberNodes = (next) => {
        rf.state.renderedNodes = typeof next === 'function' ? next(rf.state.renderedNodes ?? rf.state.nodes) : next
    }
    const rememberEdges = (next) => {
        rf.state.renderedEdges = typeof next === 'function' ? next(rf.state.renderedEdges ?? rf.state.edges) : next
    }
    render(
        createElement(
            Provider,
            { store: redux },
            createElement(ReactFlowContext, null, createElement(Grab, { instance: rf.instance, rememberNodes, rememberEdges, api }))
        )
    )
    const queue = createCanvasDeleteQueue((batch) => api.current.deleteSelection(batch))
    rf.setHandlers({
        nodes: (changes) => {
            if (api.current?.applyingDelete?.current) return
            queue.nodes(changes, (rest) => rf.state.passthrough.push(...rest))
        },
        edges: (changes) => {
            if (api.current?.applyingDelete?.current) return
            queue.edges(changes, (rest) => rf.state.passthrough.push(...rest))
        }
    })
    return { rf, redux, api, queue }
}

describe('keyboard delete on a connected card', () => {
    test('the Delete button clears the downstream reference in one write', () => {
        const { rf, redux, api } = mountCanvas(flowGraph())
        act(() => {
            api.current.deleteNode('promptTemplate_0')
        })
        const saved = rf.saved()
        expect(redux.getState().dirty).toBe(1)
        expect(rf.state.nodeWrites).toHaveLength(0)
        expect(rf.state.edgeWrites).toHaveLength(0)
        expect(saved.nodes.map((node) => node.id)).not.toContain('promptTemplate_0')
        expect(saved.nodes.map((node) => node.id)).toContain('startAgentflow_0')
        const chain = saved.nodes.find((node) => node.id === 'llmChain_0')
        expect(chain.data.inputs.prompt).toBe(' {{child_0.data.instance}}')
        expect(chain.data.inputs.tools).toEqual(['{{promptTemplate_1.data.instance}}', 'keep'])
        expect(saved.edges.map((edge) => edge.id)).not.toContain('e0')
        expect(rf.state.nodes.find((node) => node.id === 'promptTemplate_0')).toBeTruthy()
    })

    test('deleteEdge clears the reference for that line and leaves the card', () => {
        const { rf, redux, api } = mountCanvas(flowGraph())
        act(() => {
            api.current.deleteEdge('e1')
        })
        const saved = rf.saved()
        expect(redux.getState().dirty).toBe(1)
        expect(rf.state.nodeWrites).toHaveLength(0)
        expect(saved.edges.map((edge) => edge.id)).not.toContain('e1')
        expect(saved.nodes.find((node) => node.id === 'promptTemplate_1')).toBeTruthy()
        expect(saved.nodes.find((node) => node.id === 'llmChain_0').data.inputs.tools).toEqual([
            '{{promptTemplate_0.data.instance}}',
            'keep'
        ])
    })

    test('keyboard delete of one card, two cards, and a loop each remove every card, edge, and reference', async () => {
        const one = mountCanvas(flowGraph())
        await act(async () => {
            one.queue.edges(
                [
                    { type: 'remove', id: 'e0' },
                    { type: 'remove', id: 'e0tools' }
                ],
                (rest) => one.rf.state.passthrough.push(...rest)
            )
            one.queue.nodes(
                [
                    { type: 'remove', id: 'promptTemplate_0' },
                    { type: 'position', id: 'llmChain_0', position: { x: 3, y: 4 } }
                ],
                (rest) => one.rf.state.passthrough.push(...rest)
            )
            await Promise.resolve()
        })
        let saved = one.rf.saved()
        expect(one.redux.getState().dirty).toBe(1)
        expect(one.rf.state.nodeWrites).toHaveLength(0)
        expect(saved.nodes.map((node) => node.id)).not.toContain('promptTemplate_0')
        expect(JSON.stringify(saved.nodes.find((node) => node.id === 'llmChain_0').data.inputs)).not.toContain('promptTemplate_0')
        expect(one.rf.state.passthrough).toEqual([{ type: 'position', id: 'llmChain_0', position: { x: 3, y: 4 } }])

        const two = mountCanvas(flowGraph())
        await act(async () => {
            two.queue.edges(
                [
                    { type: 'remove', id: 'e0' },
                    { type: 'remove', id: 'e0tools' },
                    { type: 'remove', id: 'e1' }
                ],
                (rest) => two.rf.state.passthrough.push(...rest)
            )
            two.queue.nodes(
                [
                    { type: 'remove', id: 'promptTemplate_0' },
                    { type: 'remove', id: 'promptTemplate_1' }
                ],
                (rest) => two.rf.state.passthrough.push(...rest)
            )
            await Promise.resolve()
        })
        saved = two.rf.saved()
        expect(two.rf.state.nodeWrites).toHaveLength(0)
        expect(saved.nodes.map((node) => node.id).sort()).toEqual(['child_0', 'llmChain_0', 'loop_0', 'startAgentflow_0'])
        expect(saved.nodes.find((node) => node.id === 'llmChain_0').data.inputs.tools).toEqual(['keep'])
        expect(saved.nodes.find((node) => node.id === 'llmChain_0').data.inputs.prompt).toBe(' {{child_0.data.instance}}')
        expect(saved.edges.map((edge) => edge.id)).toEqual(['eChild'])

        const loop = mountCanvas(flowGraph())
        await act(async () => {
            loop.queue.edges([{ type: 'remove', id: 'eChild' }], (rest) => loop.rf.state.passthrough.push(...rest))
            loop.queue.nodes(
                [
                    { type: 'remove', id: 'loop_0' },
                    { type: 'remove', id: 'child_0' }
                ],
                (rest) => loop.rf.state.passthrough.push(...rest)
            )
            await Promise.resolve()
        })
        saved = loop.rf.saved()
        expect(loop.rf.state.nodeWrites).toHaveLength(0)
        expect(saved.nodes.map((node) => node.id)).not.toContain('loop_0')
        expect(saved.nodes.map((node) => node.id)).not.toContain('child_0')
        expect(JSON.stringify(saved.nodes.find((node) => node.id === 'llmChain_0').data.inputs)).not.toContain('child_0')
        expect(saved.edges.map((edge) => edge.id)).not.toContain('eChild')
    })

    test('a selected start card is removed with the rest of the selection', async () => {
        const mounted = mountCanvas(flowGraph())
        await act(async () => {
            mounted.queue.nodes(
                [
                    { type: 'remove', id: 'startAgentflow_0' },
                    { type: 'remove', id: 'promptTemplate_0' },
                    { type: 'remove', id: 'promptTemplate_1' }
                ],
                (rest) => mounted.rf.state.passthrough.push(...rest)
            )
            await Promise.resolve()
        })
        const saved = mounted.rf.saved()
        expect(saved.nodes.map((node) => node.id)).not.toContain('startAgentflow_0')
        expect(saved.nodes.map((node) => node.id)).not.toContain('promptTemplate_0')
        expect(saved.nodes.map((node) => node.id)).not.toContain('promptTemplate_1')
        expect(saved.nodes.map((node) => node.id)).toContain('llmChain_0')
        expect(JSON.stringify(saved.nodes.find((node) => node.id === 'llmChain_0').data.inputs)).not.toContain('promptTemplate_0')
    })

    test('Delete and Backspace do nothing while the node dialog is open', () => {
        const dialog = fs.readFileSync(path.join(__dirname, '../agentflowsv2/EditNodeDialog.jsx'), 'utf8')
        const canvas = fs.readFileSync(path.join(__dirname, '../agentflowsv2/Canvas.jsx'), 'utf8')
        expect(dialog).toContain('onKeyDown={onPanelKeyDown}')
        expect(dialog).toContain("if (event.key === 'Delete' || event.key === 'Backspace') event.stopPropagation()")
        expect(canvas).toContain("deleteKeyCode={canvas.canvasDialogShow ? null : ['Delete', 'Backspace']}")
        const edge = fs.readFileSync(path.join(__dirname, '../agentflowsv2/AgentFlowEdge.jsx'), 'utf8')
        expect(edge).toContain('react-flow__edge-path')
        expect(edge).toContain('addSelectedEdges')
    })

    test('a workflow handle clears {{nodeId}} and {{nodeId.output...}} and does not write inputs.undefined', () => {
        const nodes = [
            { id: 'llmAgentflow_0', data: { name: 'llmAgentflow', inputs: {} } },
            {
                id: 'directReplyAgentflow_0',
                data: {
                    name: 'directReplyAgentflow',
                    inputParams: [{ name: 'directReplyMessage', acceptVariable: true }],
                    inputs: {
                        directReplyMessage: 'See {{llmAgentflow_0}} and {{llmAgentflow_0.output.content}}'
                    }
                }
            }
        ]
        const edges = [
            {
                id: 'llm-reply',
                source: 'llmAgentflow_0',
                target: 'directReplyAgentflow_0',
                targetHandle: 'directReplyAgentflow_0'
            }
        ]
        const next = canvasAfterDelete({ nodes, edges, nodeIds: ['llmAgentflow_0'], edgeIds: ['llm-reply'] })
        const reply = next.nodes.find((node) => node.id === 'directReplyAgentflow_0')
        expect(next.nodes.map((node) => node.id)).toEqual(['directReplyAgentflow_0'])
        expect(next.edges).toEqual([])
        expect(reply.data.inputs.directReplyMessage).toBe('See  and ')
        expect(JSON.stringify(reply.data.inputs)).not.toContain('llmAgentflow_0')
        expect(reply.data.inputs.undefined).toBeUndefined()
    })

    test('deleting promptTemplate_1 does not drop promptTemplate_10', () => {
        const nodes = [
            { id: 'promptTemplate_1', data: { inputs: {} } },
            { id: 'promptTemplate_10', data: { inputs: {} } },
            {
                id: 'llmChain_0',
                data: {
                    inputAnchors: [{ name: 'tools', list: true }],
                    inputs: {
                        tools: ['{{promptTemplate_1.data.instance}}', '{{promptTemplate_10.data.instance}}', 'keep']
                    }
                }
            }
        ]
        const edges = [
            { id: 'e1', source: 'promptTemplate_1', target: 'llmChain_0', targetHandle: 'llmChain_0-input-tools-array' },
            { id: 'e10', source: 'promptTemplate_10', target: 'llmChain_0', targetHandle: 'llmChain_0-input-tools-array' }
        ]
        const next = canvasAfterDelete({ nodes, edges, nodeIds: ['promptTemplate_1'], edgeIds: ['e1'] })
        const chain = next.nodes.find((node) => node.id === 'llmChain_0')
        expect(chain.data.inputs.tools).toEqual(['{{promptTemplate_10.data.instance}}', 'keep'])
        expect(next.edges.map((edge) => edge.id)).toEqual(['e10'])
        expect(next.nodes.map((node) => node.id)).toContain('promptTemplate_10')
    })

    test('a repeated token is cleared in every input', () => {
        const nodes = [
            { id: 'llmAgentflow_0', data: { inputs: {} } },
            {
                id: 'directReplyAgentflow_0',
                data: {
                    inputs: {
                        directReplyMessage: '{{llmAgentflow_0}} then {{llmAgentflow_0}}',
                        note: 'tail {{llmAgentflow_0.output.content}}'
                    }
                }
            }
        ]
        const edges = [{ id: 'e', source: 'llmAgentflow_0', target: 'directReplyAgentflow_0', targetHandle: 'directReplyAgentflow_0' }]
        const next = canvasAfterDelete({ nodes, edges, nodeIds: ['llmAgentflow_0'], edgeIds: ['e'] })
        const reply = next.nodes.find((node) => node.id === 'directReplyAgentflow_0')
        expect(reply.data.inputs.directReplyMessage).toBe(' then ')
        expect(reply.data.inputs.note).toBe('tail ')
    })

    test('a missing acceptVariable value does not skip a multi-select delete', () => {
        const nodes = [
            {
                id: 'a',
                data: { inputs: { note: undefined }, inputParams: [{ name: 'note', acceptVariable: true }] }
            },
            { id: 'b', data: { inputs: { note: '{{a}}' }, inputParams: [{ name: 'note', acceptVariable: true }] } },
            { id: 'c', data: { inputs: { note: '{{a}} {{b}}' }, inputParams: [{ name: 'note', acceptVariable: true }] } }
        ]
        const edges = [
            { id: 'ea', source: 'a', target: 'c', targetHandle: 'c' },
            { id: 'eb', source: 'b', target: 'c', targetHandle: 'c' }
        ]
        const next = canvasAfterDelete({ nodes, edges, nodeIds: ['a', 'b'], edgeIds: ['ea', 'eb'] })
        expect(next.nodes.map((node) => node.id)).toEqual(['c'])
        expect(next.edges).toEqual([])
        expect(next.nodes[0].data.inputs.note).toBe(' ')
        expect(next.nodes[0].data.inputs.undefined).toBeUndefined()
    })

    test('drag and select still pass through', () => {
        const { rf, queue } = mountCanvas(flowGraph())
        const changes = [
            { type: 'position', id: 'llmChain_0', position: { x: 8, y: 9 } },
            { type: 'select', id: 'llmChain_0', selected: true }
        ]
        queue.nodes(changes, (rest) => rf.state.passthrough.push(...rest))
        expect(rf.state.passthrough).toEqual(changes)
        expect(rf.state.nodeWrites).toHaveLength(0)
    })

    test('both editor canvases send remove changes through that path', () => {
        const files = [path.join(__dirname, 'index.jsx'), path.join(__dirname, '../agentflowsv2/Canvas.jsx')]
        for (const file of files) {
            const source = fs.readFileSync(file, 'utf8')
            expect(source).toContain('createCanvasDeleteQueue')
            expect(source).toContain('bindCanvasState')
            expect(source).toContain('deleteSelection')
            expect(source).toContain('onNodesChange={handleNodesChange}')
            expect(source).toContain('onEdgesChange={handleEdgesChange}')
            expect(source).not.toContain('onNodesChange={onNodesChange}')
        }
    })
})
