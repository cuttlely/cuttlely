// The display changes for the Postgres (MCP) tool and the analyst must not touch saved flows. Each sample
// harness and chatflow is loaded the way the canvas loads it, every display helper reads it in both analyst
// states, and a save with no edits must write exactly what a save without those helpers writes.
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { cloneDeep, isEqual } from 'lodash'

import { normalizeCanvasFlow } from './normalizeCanvasFlow'
import { canvasSaveDocument } from './canvasSave'
import { displayLabel, displaySubtitle, docsLink, linkNote, regroupForPalette, wiredPostgres } from './nodeDisplayNames'
import { searchNodes } from './nodeSearch'
import { postgresGroups, isPostgresPanel } from './postgresPanel'
import { MODE_TEXT, credentialOf } from './analystStatus'

jest.mock('@/store/constant', () => ({ baseURL: 'http://localhost' }))

const root = path.join(__dirname, '..', '..', '..', '..')
const sampleFiles = ['samples/harnesses', 'samples/chatflows'].flatMap((dir) =>
    fs
        .readdirSync(path.join(root, dir))
        .filter((file) => file.endsWith('.json'))
        .map((file) => path.join(dir, file))
)

function flowOf(file) {
    const doc = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
    const flow = typeof doc.flowData === 'string' ? JSON.parse(doc.flowData) : doc.flowData || doc
    return Array.isArray(flow?.nodes) ? flow : null
}

// A made-up catalog entry with the Postgres tool's field names, so the spec path of a load runs too.
const specs = [
    {
        name: 'postgreSQLMCP',
        baseClasses: ['Tool'],
        inputs: [
            { name: 'mcpActions', label: 'Available Actions', type: 'asyncMultiOptions' },
            { name: 'analystRelations', label: 'Tables and views', type: 'asyncMultiOptions', optional: true },
            { name: 'analystRules', label: 'Rules', type: 'string', optional: true },
            { name: 'analystRowCap', label: 'Row cap', type: 'number', optional: true, additionalParams: true },
            { name: 'allowPinDefinitions', label: 'Expose pinned SQL definitions', type: 'boolean', optional: true, additionalParams: true }
        ]
    }
]

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value)
        for (const key of Object.keys(value)) deepFreeze(value[key])
    }
    return value
}

function saveWithoutEdits(flow) {
    const instance = { getNodes: () => cloneDeep(flow.nodes), toObject: () => cloneDeep(flow) }
    return JSON.stringify(canvasSaveDocument(instance))
}

// Everything the new display code reads, run against a frozen flow so any write throws.
function readForDisplay(flow, mode) {
    const nodes = flow.nodes
    const palette = nodes.map((node) => node.data)
    regroupForPalette({ Tools: palette }, {})
    searchNodes(palette, 'postgres')
    searchNodes(palette, 'mcp')
    for (const node of nodes) {
        displayLabel(node.data)
        displaySubtitle(node.data?.name)
        docsLink(node.data)
        linkNote(node.id, nodes, flow.edges)
        wiredPostgres(node.id, nodes, flow.edges)
        credentialOf(node.data)
        if (isPostgresPanel(node.data)) postgresGroups(node.data, { hide: mode === 'sandbox' ? ['analystRelations'] : [] })
    }
    return MODE_TEXT[mode]
}

// SHA-256 of every complete saved document, one per sample and catalog, written by the load and save code that
// shipped before this change (normalizeCanvasFlow.js and canvasSave.js are not changed by it). Regenerate only
// for an intended change to the saved format: CUTTLELY_WRITE_SAVED_GOLDEN=1 npx jest savedFlowsUnchanged.
const goldenPath = path.join(__dirname, '__fixtures__', 'savedFlows.golden.json')
const golden = fs.existsSync(goldenPath) ? JSON.parse(fs.readFileSync(goldenPath, 'utf8')) : {}
const written = {}
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex')

afterAll(() => {
    if (process.env.CUTTLELY_WRITE_SAVED_GOLDEN !== '1') return
    fs.mkdirSync(path.dirname(goldenPath), { recursive: true })
    const sorted = Object.fromEntries(
        Object.keys(written)
            .sort()
            .map((key) => [key, written[key]])
    )
    fs.writeFileSync(goldenPath, JSON.stringify(sorted, null, 4) + '\n')
})

const PICKED = ['id', 'label', 'name', 'version', 'type', 'category', 'inputs', 'credential', 'outputs']
const picked = (data) => Object.fromEntries(PICKED.filter((key) => key in (data || {})).map((key) => [key, data[key]]))

describe('saved flows load and save unchanged', () => {
    it('has samples with the Postgres tool wired to a specialist', () => {
        const withPostgres = sampleFiles.filter((file) => flowOf(file)?.nodes.some((node) => node.data?.name === 'postgreSQLMCP'))
        expect(withPostgres.length).toBeGreaterThan(0)
    })

    describe.each(['unavailable', 'sandbox', 'readonly', 'unknown'])('with the server answering %s', (mode) => {
        it.each(sampleFiles)('%s', (file) => {
            const original = flowOf(file)
            if (!original) return
            for (const catalog of [[], specs]) {
                const baseline = saveWithoutEdits(normalizeCanvasFlow(cloneDeep(original), catalog))
                const loaded = deepFreeze(normalizeCanvasFlow(cloneDeep(original), catalog))
                expect(() => readForDisplay(loaded, mode)).not.toThrow()
                expect(saveWithoutEdits(loaded)).toBe(baseline)
                const key = `${file.split(path.sep).join('/')} ${catalog.length ? 'with-spec' : 'no-spec'}`
                written[key] = sha(baseline)
                if (process.env.CUTTLELY_WRITE_SAVED_GOLDEN !== '1') expect(sha(baseline)).toBe(golden[key])

                const saved = JSON.parse(saveWithoutEdits(loaded))
                const byId = new Map(original.nodes.map((node) => [node.id, node]))
                for (const node of saved.nodes) {
                    const before = byId.get(node.id)
                    expect(node.type).toBe(before.type)
                    const keep = picked(before.data)
                    // A load fills defaults for fields a compact sample left out. Saved values stay as written.
                    expect({ ...picked(node.data), inputs: picked(node.data).inputs && pick(node.data.inputs, keep.inputs) }).toEqual(keep)
                }
                // Every field the file had is saved back with the same value; a load only adds missing defaults.
                for (const before of original.nodes) {
                    const after = saved.nodes.find((node) => node.id === before.id)
                    for (const [field, value] of Object.entries(before.data || {})) {
                        if (field === 'inputs' && value && typeof value === 'object') {
                            for (const [input, inputValue] of Object.entries(value))
                                expect(isEqual(after.data.inputs[input], inputValue)).toBe(true)
                        } else if (!isEqual(after.data[field], value)) {
                            expect({ node: before.id, field, value: after.data[field] }).toEqual({ node: before.id, field, value })
                        }
                    }
                }
                expect(saved.edges).toEqual(original.edges)
            }
        })
    })
})

function pick(inputs, keep) {
    if (!keep) return inputs
    return Object.fromEntries(Object.keys(keep).map((key) => [key, inputs[key]]))
}
