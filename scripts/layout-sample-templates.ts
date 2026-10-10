import * as fs from 'fs'
import path from 'path'
import { normalizeTemplateFlow } from '../packages/server/src/services/marketplaces/sampleTemplates.ts'
import {
    estimateTemplateNodeSize,
    layoutTemplateFlow,
    loadTemplateNodeSpecs,
    templateClearanceFailures,
    templateNodeBoxes
} from '../packages/server/src/services/marketplaces/templateLayout.ts'

const root = process.cwd()

const cards: Record<string, { name: string; description: string; usecases: string[] }> = {
    'samples/harnesses/calculator.canvas.json': {
        name: 'Calculator Harness',
        description: 'Harness Prime answers arithmetic through one in-process Calculator specialist.',
        usecases: ['Calculator']
    },
    'samples/harnesses/field-team.canvas.json': {
        name: 'Field Team Harness',
        description: 'Harness Prime splits work across browser, Python, files, and a public HTTP GET.',
        usecases: ['Field Team']
    },
    'samples/harnesses/chief-of-staff.canvas.json': {
        name: 'Chief of Staff Harness',
        description: 'Researcher searches a local note. Analyst uses isolated storage when CUTTLELY_ANALYST=auto.',
        usecases: ['Documents']
    },
    'samples/harnesses/upload.canvas.json': {
        name: 'Upload Harness',
        description: 'Python and Shell specialists sample the file on disk and return a short summary.',
        usecases: ['File Upload']
    },
    'samples/harnesses/ops.canvas.json': {
        name: 'Ops Harness',
        description: 'Harness Prime answers from one specialist that calls an allowlisted MCP tool.',
        usecases: ['Operations']
    },
    'samples/harnesses/research.canvas.json': {
        name: 'Research Harness',
        description: 'Harness Prime answers from one specialist bound to a custom retriever.',
        usecases: ['Research']
    },
    'samples/chatflows/upload.chatflow.json': {
        name: 'Upload Chatflow',
        description: 'Tool Agent that sends file and spreadsheet questions to the upload harness.',
        usecases: ['File Upload']
    },
    'samples/chatflows/field-team.chatflow.json': {
        name: 'Field Team Chatflow',
        description: 'Tool Agent that sends questions to the field-team harness.',
        usecases: ['Field Team']
    },
    'samples/chatflows/openai-calculator.chatflow.json': {
        name: 'OpenAI Calculator Chatflow',
        description: 'Tool Agent that sends arithmetic to the calculator harness.',
        usecases: ['Calculator']
    },
    'samples/chatflows/ops.chatflow.json': {
        name: 'Ops Chatflow',
        description: 'Chat that runs the ops harness by name.',
        usecases: ['Operations']
    },
    'samples/chatflows/research.chatflow.json': {
        name: 'Research Chatflow',
        description: 'Chat that runs the research harness by name.',
        usecases: ['Research']
    },
    'samples/etl/cuttlely-handbook.pipeline.json': {
        name: 'Cuttlely Handbook',
        description: 'Reads this checkout as a repository, splits Markdown, and stores local embeddings.',
        usecases: ['Documents']
    },
    'samples/etl/outdoor-catalog.pipeline.json': {
        name: 'Outdoor Catalog',
        description: 'Loads a product CSV by SKU and stores it with local hash embeddings.',
        usecases: ['Catalog']
    }
}

const nodeByName = loadTemplateNodeSpecs(path.join(root, 'packages', 'server', 'src', 'services', 'marketplaces'))

for (const [relative, card] of Object.entries(cards)) {
    const file = path.join(root, relative)
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    const flow = typeof record.flowData === 'string' ? JSON.parse(record.flowData) : record.flowData
    const normalized = JSON.parse(normalizeTemplateFlow(JSON.stringify(flow), nodeByName))
    const sizeById = new Map(
        (normalized.nodes || []).map((node: { id?: string; data?: Record<string, unknown> }) => [
            String(node.id),
            estimateTemplateNodeSize(node.data || {})
        ])
    )
    layoutTemplateFlow(flow, sizeById)
    record.name = card.name
    record.description = card.description
    record.usecases = card.usecases
    record.flowData = typeof record.flowData === 'string' ? JSON.stringify(flow) : flow
    fs.writeFileSync(file, JSON.stringify(record, null, 4) + '\n')
    const laidOut = typeof record.flowData === 'string' ? record.flowData : JSON.stringify(record.flowData)
    const boxes = templateNodeBoxes(normalizeTemplateFlow(laidOut, nodeByName))
    const failures = templateClearanceFailures(boxes)
    const heights = boxes.map((box) => `${box.name}:${box.h}@${box.x},${box.y}`).join(' ')
    console.info(`${card.name} nodes=${boxes.length} failures=${failures.length}`)
    if (failures.length) console.info(failures.join('\n'))
    console.info(heights)
}
