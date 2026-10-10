import fs from 'node:fs'
import path from 'node:path'
import {
    CANVAS_LOOK_EVENT,
    CANVAS_LOOK_KEY,
    DEFAULT_CANVAS_LOOK,
    cardPlugParams,
    cardSummary,
    isNewLook,
    panToKeepInView,
    panelNode,
    panelSections,
    readCanvasLook,
    serverDefaultLook,
    writeCanvasLook
} from './canvasLook'

const memoryStorage = (initial = {}) => {
    const values = { ...initial }
    return {
        values,
        getItem: (key) => (key in values ? values[key] : null),
        setItem: (key, value) => {
            values[key] = String(value)
        }
    }
}

describe('canvas look setting', () => {
    it('is the new look unless this browser chose classic cards', () => {
        expect(DEFAULT_CANVAS_LOOK).toBe('panel')
        expect(readCanvasLook(memoryStorage())).toBe('panel')
        expect(readCanvasLook(memoryStorage({ [CANVAS_LOOK_KEY]: 'classic' }))).toBe('classic')
        expect(readCanvasLook(memoryStorage({ [CANVAS_LOOK_KEY]: 'something else' }))).toBe('panel')
        expect(readCanvasLook(null)).toBe('panel')
        expect(
            readCanvasLook({
                getItem: () => {
                    throw new Error('blocked')
                }
            })
        ).toBe('panel')
    })

    it('follows the server default until this browser chooses', () => {
        expect(serverDefaultLook({ CANVAS_CARD_LOOK: 'classic' })).toBe('classic')
        expect(serverDefaultLook({ CANVAS_CARD_LOOK: 'new' })).toBe('panel')
        expect(serverDefaultLook({})).toBe('panel')
        expect(serverDefaultLook(undefined)).toBe('panel')
        expect(readCanvasLook(memoryStorage(), 'classic')).toBe('classic')
        expect(readCanvasLook(memoryStorage({ [CANVAS_LOOK_KEY]: 'panel' }), 'classic')).toBe('panel')
        expect(readCanvasLook(memoryStorage(), 'nonsense')).toBe('panel')
    })

    it('saves the choice and tells open canvases', () => {
        const storage = memoryStorage()
        const events = []
        const target = { dispatchEvent: (event) => events.push(event) }
        expect(writeCanvasLook('panel', storage, target)).toBe('panel')
        expect(storage.values[CANVAS_LOOK_KEY]).toBe('panel')
        expect(events.map((event) => [event.type, event.detail])).toEqual([[CANVAS_LOOK_EVENT, 'panel']])
        expect(writeCanvasLook('nonsense', storage, target)).toBe('panel')
        expect(storage.values[CANVAS_LOOK_KEY]).toBe('panel')
    })

    it('still switches when storage refuses to save', () => {
        const storage = {
            getItem: () => null,
            setItem: () => {
                throw new Error('full')
            }
        }
        expect(writeCanvasLook('panel', storage, null)).toBe('panel')
    })
})

describe('side panel contents', () => {
    const data = {
        inputParams: [
            { name: 'modelName', label: 'Model', type: 'options' },
            { name: 'hiddenOne', label: 'Hidden', type: 'string', hidden: true },
            { name: 'notShown', label: 'Not shown', type: 'string', display: false },
            { name: 'systemMessage', label: 'System message', type: 'string', acceptVariable: true, id: 'n_0-input-systemMessage-string' },
            { name: 'temperature', label: 'Temperature', type: 'number', additionalParams: true },
            { name: 'extra', label: 'Extra', type: 'string', additionalParams: true, acceptVariable: true }
        ]
    }

    it('shows the card fields first, then the ones behind Additional Parameters, never hidden ones', () => {
        const { main, more } = panelSections(data)
        expect(main.map((param) => param.name)).toEqual(['modelName', 'systemMessage'])
        expect(more.map((param) => param.name)).toEqual(['temperature', 'extra'])
        expect(panelSections({})).toEqual({ main: [], more: [] })
    })

    it('keeps the plug point of a field that also takes a connection on the card', () => {
        expect(cardPlugParams(data).map((param) => param.id)).toEqual(['n_0-input-systemMessage-string'])
    })

    it('opens only for a card that is still on the canvas and is not a sticky note', () => {
        const nodes = [
            { id: 'chatOpenAI_0', type: 'customNode', data: {} },
            { id: 'stickyNote_0', type: 'stickyNote', data: {} }
        ]
        expect(panelNode(nodes, 'chatOpenAI_0')?.id).toBe('chatOpenAI_0')
        expect(panelNode(nodes, 'stickyNote_0')).toBeNull()
        expect(panelNode(nodes, 'deleted_0')).toBeNull()
        expect(panelNode(nodes, null)).toBeNull()
        expect(panelNode(undefined, 'chatOpenAI_0')).toBeNull()
    })
})

describe('panToKeepInView', () => {
    const viewport = { x: 0, y: 0, zoom: 1 }

    it('leaves the view alone when the card fits', () => {
        expect(panToKeepInView({ x: 100, y: 0, width: 300, height: 200 }, viewport, 1000)).toBeNull()
    })

    it('pans left just enough to show a card the panel would cover', () => {
        expect(panToKeepInView({ x: 700, y: 0, width: 300, height: 200 }, viewport, 900)).toEqual({ x: -140, y: 0, zoom: 1 })
    })

    it('never pans the left edge of the card out of view', () => {
        const next = panToKeepInView({ x: 100, y: 0, width: 2000, height: 200 }, viewport, 900)
        expect(next).toEqual({ x: -60, y: 0, zoom: 1 })
    })

    it('uses the zoom', () => {
        expect(panToKeepInView({ x: 400, y: 0, width: 300, height: 200 }, { x: 0, y: 0, zoom: 2 }, 1000)).toEqual({
            x: -440,
            y: 0,
            zoom: 2
        })
    })

    it('does nothing without a size', () => {
        expect(panToKeepInView(null, viewport, 900)).toBeNull()
        expect(panToKeepInView({ x: 0, y: 0, width: 10 }, viewport, 0)).toBeNull()
    })
})

describe('canvas wiring', () => {
    const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')

    it('the side panel edits fields without plug points, so a connection never lands in the panel', () => {
        const source = read('views/canvas/NodeSidePanel.jsx')
        expect(source.match(/<NodeInputHandler\b/g)).toHaveLength(2)
        expect(source.match(/isAdditionalParams=\{true\}/g)).toHaveLength(2)
    })

    it('the panel sits inside the same React Flow provider as the canvas', () => {
        const source = read('views/canvas/index.jsx')
        const provider = source.indexOf('<ReactFlowProvider>')
        const panel = source.indexOf('<NodeSidePanel ')
        expect(provider).toBeGreaterThan(-1)
        expect(panel).toBeGreaterThan(provider)
        expect(panel).toBeLessThan(source.indexOf('</ReactFlowProvider>'))
    })
})

describe('compact card summary', () => {
    const data = {
        inputs: {
            modelName: 'gpt-4o-mini',
            mode: 'fast',
            apiKey: 'not shown',
            prompt: 'You are a helpful   baker.\nAnswer in one line about rye, spelt and sourdough starters please.',
            temperature: 0.4,
            tools: ['a'],
            hiddenOne: 'x'
        },
        inputParams: [
            { name: 'credential', label: 'Connect Credential', type: 'credential' },
            { name: 'apiKey', label: 'API key', type: 'password' },
            { name: 'modelName', label: 'Model', type: 'asyncOptions' },
            {
                name: 'mode',
                label: 'Mode',
                type: 'options',
                options: [
                    { name: 'fast', label: 'Fast answers' },
                    { name: 'slow', label: 'Careful answers' }
                ]
            },
            { name: 'hiddenOne', label: 'Hidden', type: 'string', hidden: true },
            { name: 'prompt', label: 'Prompt', type: 'string', rows: 4 },
            { name: 'temperature', label: 'Temperature', type: 'number', additionalParams: true },
            { name: 'tools', label: 'Tools', type: 'string' }
        ]
    }

    it('shows up to three short card values, with option labels, never passwords or credentials', () => {
        expect(cardSummary(data)).toEqual([
            { name: 'modelName', label: 'Model', value: 'gpt-4o-mini' },
            { name: 'mode', label: 'Mode', value: 'Fast answers' },
            { name: 'prompt', label: 'Prompt', value: 'You are a helpful baker. Answer in one line abo\u2026' }
        ])
    })

    it('skips empty values, lists and settings behind Additional Parameters', () => {
        expect(cardSummary({ ...data, inputs: { tools: ['a'], temperature: 1, modelName: '' } })).toEqual([])
        expect(cardSummary({})).toEqual([])
        expect(cardSummary(data, 1)).toHaveLength(1)
    })

    it('treats only the panel value as the new look', () => {
        expect(isNewLook('panel')).toBe(true)
        expect(isNewLook('classic')).toBe(false)
        expect(isNewLook(undefined)).toBe(false)
    })
})

describe('compact card wiring', () => {
    const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')

    it('draws plug points with the same components as the classic card, so their ids match', () => {
        const source = read('views/canvas/CompactCardBody.jsx')
        expect(source).toMatch(/<NodeInputHandler[^>]*inputAnchor=\{inputAnchor\}/)
        expect(source).toMatch(/<NodeInputHandler[^>]*inputAnchor=\{inputParam\}/)
        expect(source).toMatch(/<NodeOutputHandler/)
        expect(source).not.toMatch(/inputParam=\{/)
    })

    it('never draws the classic body and the compact body together', () => {
        for (const file of ['views/canvas/CanvasNode.jsx', 'views/marketplaces/MarketplaceCanvasNode.jsx']) {
            const source = read(file)
            expect(source).toMatch(/\{compact && <CompactCardBody /)
            expect(source).toMatch(/\{!compact && \(/)
        }
    })

    it('keeps classic cards in the version history viewer, which compares fields', () => {
        expect(read('views/versions/VersionCanvas.jsx')).not.toMatch(/CanvasPanelContext/)
    })
})

describe('classic cards setting', () => {
    const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')

    it('sits in the profile menu as a switch on the same setting the canvas button uses', () => {
        const source = read('layout/MainLayout/Header/ProfileSection/index.jsx')
        expect(source).toMatch(/useCanvasLook\(\)/)
        expect(source).toMatch(/Classic cards/)
        expect(source).toMatch(/role='switch'/)
    })
})

describe('workflow side panel wiring', () => {
    const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')

    it('opens the workflow settings in a docked panel inside the React Flow provider', () => {
        const source = read('views/agentflowsv2/Canvas.jsx')
        const provider = source.indexOf('<ReactFlowProvider>')
        const panel = source.search(/<EditNodeDialog\s+variant='panel'/)
        expect(provider).toBeGreaterThan(-1)
        expect(panel).toBeGreaterThan(provider)
        expect(panel).toBeLessThan(source.indexOf('</ReactFlowProvider>'))
        expect(source).toMatch(/else if \(newLook\) \{/)
    })

    it('the panel does not block canvas shortcuts the way the dialog does, and keeps Delete to itself', () => {
        const source = read('views/agentflowsv2/EditNodeDialog.jsx')
        expect(source).toMatch(/if \(asPanel\) return\n\s+if \(show\) dispatch\(\{ type: SHOW_CANVAS_DIALOG \}\)/)
        expect(source).toMatch(/event\.key === 'Delete' \|\| event\.key === 'Backspace'\) event\.stopPropagation\(\)/)
    })
})
