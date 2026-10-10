import * as fs from 'fs'
import path from 'path'
import { normalizeTemplateFlow, sampleTemplates } from './sampleTemplates'
import {
    TEMPLATE_CLEARANCE,
    TEMPLATE_NODE_WIDTH,
    boxClearance,
    isShortDescription,
    isTitleCaseName,
    loadTemplateNodeSpecs,
    templateClearanceFailures,
    templateNodeBoxes
} from './templateLayout'

const nodeByName = loadTemplateNodeSpecs()

// Every shipped sample file, credentialed or not, as { file, nodes }.
const sampleFlows = () => {
    const root = path.resolve(__dirname, '../../../../../samples')
    const flows: Array<{ file: string; nodes: Array<{ data?: Record<string, any> }> }> = []
    for (const dir of ['harnesses', 'chatflows', 'etl']) {
        for (const file of fs.readdirSync(path.join(root, dir)).filter((name) => name.endsWith('.json'))) {
            const record = JSON.parse(fs.readFileSync(path.join(root, dir, file), 'utf8'))
            const flow = typeof record.flowData === 'string' ? JSON.parse(record.flowData) : record.flowData
            flows.push({ file: `${dir}/${file}`, nodes: flow?.nodes || [] })
        }
    }
    return flows
}

describe('templateLayout', () => {
    it('fails when two cards overlap or sit closer than the clearance', () => {
        const left = { id: 'a', name: 'a', x: 0, y: 0, w: 300, h: 400 }
        const overlap = { id: 'b', name: 'b', x: 100, y: 50, w: 300, h: 400 }
        const tight = { id: 'c', name: 'c', x: 310, y: 0, w: 300, h: 400 }
        expect(boxClearance(left, overlap)).toBeLessThan(0)
        expect(boxClearance(left, tight)).toBeLessThan(TEMPLATE_CLEARANCE)
        expect(templateClearanceFailures([left, overlap])).toHaveLength(1)
        expect(templateClearanceFailures([left, tight])).toHaveLength(1)
    })

    it('keeps every sample canvas clear, titled, and described', () => {
        const templates = sampleTemplates()
        expect(templates.length).toBeGreaterThanOrEqual(12)
        for (const template of templates) {
            expect(isTitleCaseName(template.templateName)).toBe(true)
            expect(isShortDescription(template.description)).toBe(true)
            expect(['Harness', 'Chatflow', 'ETL']).toContain(template.type)
            expect(template.usecases?.length).toBeGreaterThan(0)
            const boxes = templateNodeBoxes(normalizeTemplateFlow(template.flowData, nodeByName))
            expect(boxes.length).toBeGreaterThan(0)
            for (const box of boxes) {
                expect(box.w).toBe(TEMPLATE_NODE_WIDTH)
                expect(box.h).toBeGreaterThanOrEqual(400)
                if (box.name !== 'stickyNote' && box.name !== 'stickyNoteAgentflow') {
                    expect(nodeByName(box.name)?.name).toBe(box.name)
                }
            }
            expect(templateClearanceFailures(boxes)).toEqual([])
            const flow = JSON.parse(template.flowData)
            const ids = new Set((flow.nodes || []).map((node: { id?: string }) => node.id))
            for (const edge of flow.edges || []) {
                expect(ids.has(edge.source)).toBe(true)
                expect(ids.has(edge.target)).toBe(true)
            }
            for (const node of flow.nodes || []) {
                expect(node.positionAbsolute).toEqual(node.position)
            }
            expect(flow.viewport?.zoom).toBeGreaterThan(0)
        }
    })

    it('estimates a specialist and a chat model taller than the cards on screen', () => {
        const flow = JSON.stringify({
            nodes: [
                { id: 'chief', position: { x: 0, y: 0 }, data: { name: 'harnessSpecialist', inputs: {} } },
                { id: 'model', position: { x: 0, y: 0 }, data: { name: 'chatXAI', inputs: {} } }
            ],
            edges: []
        })
        const boxes = templateNodeBoxes(normalizeTemplateFlow(flow, nodeByName))
        const specialist = boxes.find((box) => box.name === 'harnessSpecialist')
        const model = boxes.find((box) => box.name === 'chatXAI')
        expect(specialist?.h).toBeGreaterThanOrEqual(700)
        expect(model?.h).toBeGreaterThanOrEqual(600)
    })
    it('ships every sample node at the current node version, with the current inputs', () => {
        const flows = sampleFlows()
        expect(flows.length).toBeGreaterThanOrEqual(19)
        const stale: string[] = []
        for (const { file, nodes } of flows) {
            for (const { data } of nodes) {
                const spec = data?.name ? nodeByName(String(data.name)) : undefined
                if (!data || !spec || spec.version === undefined) continue
                const where = `${file} ${data.id || data.name}`
                if (data.version !== spec.version) stale.push(`${where}: version ${data.version}, node is ${spec.version}`)
                // A sample that stores its fields must store the current ones; otherwise the canvas
                // shows removed fields and hides new ones until Sync Nodes.
                if (!Array.isArray(data.inputParams) && !Array.isArray(data.inputAnchors)) continue
                // Compare what decides how the card renders each field: name, type, and whether it sits
                // under Additional Parameters. Matching names alone would miss a field that moved.
                const field = (param: Record<string, unknown>) =>
                    `${param.name}:${param.type}${param.additionalParams === true ? ':additional' : ''}`
                const stored = [...(data.inputParams || []), ...(data.inputAnchors || [])].map(field).sort()
                const current = [
                    ...(spec.inputs || []).map(field),
                    ...(spec.credential ? [field({ name: spec.credential.name, type: 'credential' })] : [])
                ].sort()
                if (stored.join(',') !== current.join(','))
                    stale.push(`${where}: fields ${stored.join(',')}, node has ${current.join(',')}`)
            }
        }
        expect(stale).toEqual([])
    })
})
