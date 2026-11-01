// Tidy on every shipped sample harness: the canvas loads it, Tidy moves the cards, Save writes it, and a reload
// gives back JSON that differs from an untidied save only in card positions. scripts/harness-tidy-samples.test.mjs
// compiles the same tidied canvases with the harness runtime.
import fs from 'fs'
import path from 'path'
import { cloneDeep, omit } from 'lodash'

import { normalizeCanvasFlow } from './normalizeCanvasFlow'
import { canvasSaveDocument } from './canvasSave'
import { positionSnapshot, tidyStep, undoTidy } from './tidyHarnessLayout'

jest.mock('@/store/constant', () => ({ baseURL: 'http://localhost' }))

const root = path.join(__dirname, '..', '..', '..', '..')

const sampleFiles = fs
    .readdirSync(path.join(root, 'samples', 'harnesses'))
    .filter((file) => file.endsWith('.canvas.json'))
    .map((file) => path.join('samples', 'harnesses', file))

const flowOf = (file) => {
    const doc = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
    return typeof doc.flowData === 'string' ? JSON.parse(doc.flowData) : doc.flowData
}

const save = (flow) => {
    const instance = { getNodes: () => cloneDeep(flow.nodes), toObject: () => cloneDeep(flow) }
    return JSON.stringify(canvasSaveDocument(instance))
}

const semantics = (saved) => {
    const flow = JSON.parse(saved)
    return { ...flow, nodes: flow.nodes.map((node) => omit(node, ['position', 'positionAbsolute'])) }
}

describe('Tidy on the sample harnesses', () => {
    it('has sample harness canvases', () => {
        expect(sampleFiles.length).toBeGreaterThan(0)
    })

    it.each(sampleFiles)('%s loads, tidies, saves and reloads with only positions changed', (file) => {
        const loaded = normalizeCanvasFlow(flowOf(file), [])
        const untidied = save(loaded)
        const step = tidyStep(loaded.nodes, loaded.edges)
        const tidied = save({ ...loaded, nodes: step.nodes })
        const reloaded = normalizeCanvasFlow(JSON.parse(tidied), [])

        expect(semantics(tidied)).toEqual(semantics(untidied))
        expect(semantics(save(reloaded))).toEqual(semantics(untidied))
        expect(reloaded.edges).toEqual(JSON.parse(untidied).edges)
        expect(positionSnapshot(reloaded.nodes)).toEqual(positionSnapshot(step.nodes))
        if (step.undo) expect(positionSnapshot(step.nodes)).not.toEqual(positionSnapshot(loaded.nodes))
        expect(positionSnapshot(undoTidy(step.undo, step.nodes))).toEqual(positionSnapshot(loaded.nodes))
    })
})
