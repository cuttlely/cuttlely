import fs from 'fs'
import os from 'os'
import path from 'path'
import { marketplaceFlowTemplates, marketplaceRoot, normalizeTemplateFlow, sampleTemplates } from './sampleTemplates'

const byName = (type: string, name: string) =>
    sampleTemplates().find((template) => template.type === type && template.templateName === name)

describe('sampleTemplates', () => {
    it('lists stock harness canvases, including upload, with no credential', () => {
        for (const name of ['Calculator Harness', 'Field Team Harness', 'Chief of Staff Harness', 'Upload Harness']) {
            const template = byName('Harness', name)
            expect(template?.type).toBe('Harness')
            expect(template?.flowData).toContain('harnessChief')
            expect(template?.flowData).not.toMatch(/"credential"\s*:/)
            expect(template?.flowData).not.toMatch(/postgres(ql)?:\/\//i)
        }
        const upload = byName('Harness', 'Upload Harness')
        expect(upload?.description).toMatch(/sample the file/i)
        expect(upload?.flowData).toContain('"specialistName":"python"')
        expect(upload?.flowData).toContain('"specialistName":"shell"')
    })

    it('lists the upload chatflow next to the other stock chatflows', () => {
        const upload = byName('Chatflow', 'Upload Chatflow')
        expect(upload?.description).toMatch(/upload harness/)
        expect(upload?.flowData).toContain('"harnessName":"upload"')
        expect(upload?.flowData).toContain('tool:harness')
        expect(upload?.flowData).not.toMatch(/"credential"\s*:/)
        expect(byName('Chatflow', 'Field Team Chatflow')?.flowData).toContain('"harnessName":"field-team"')
        expect(byName('Chatflow', 'OpenAI Calculator Chatflow')?.flowData).toContain('"harnessName":"calculator"')
    })

    it('drops a canvas that still has a credential selected', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-templates-'))
        const harnessDir = path.join(root, 'samples', 'harnesses')
        fs.mkdirSync(harnessDir, { recursive: true })
        fs.mkdirSync(path.join(root, 'samples', 'etl'), { recursive: true })
        fs.mkdirSync(path.join(root, 'samples', 'chatflows'), { recursive: true })
        const flow = (credential?: string) =>
            JSON.stringify({
                nodes: [{ data: { name: 'chatXAI', category: 'Chat Models', ...(credential ? { credential } : {}) } }],
                edges: []
            })
        fs.writeFileSync(
            path.join(harnessDir, 'open.canvas.json'),
            JSON.stringify({ name: 'open', description: 'no key', flowData: flow() })
        )
        fs.writeFileSync(
            path.join(harnessDir, 'keyed.canvas.json'),
            JSON.stringify({ name: 'keyed', description: 'has a key', flowData: flow('cred-1') })
        )
        const names = sampleTemplates(root).map((template) => template.templateName)
        expect(names).toEqual(['open'])
        fs.rmSync(root, { recursive: true, force: true })
    })

    it('loads every marketplace flow with nodes and edges, and only registered node names', () => {
        const nodeNames = new Set<string>()
        const nodesDir = path.join(marketplaceRoot(), '..', 'components', 'nodes')
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name)
                if (entry.isDirectory()) {
                    if (entry.name === 'node_modules' || entry.name === 'dist') continue
                    walk(full)
                } else if (entry.name.endsWith('.ts')) {
                    const text = fs.readFileSync(full, 'utf8')
                    for (const match of text.matchAll(/this\.name = '([^']+)'/g)) nodeNames.add(match[1])
                }
            }
        }
        walk(nodesDir)
        const spec = (name: string) => ({
            name,
            type: 'Node',
            baseClasses: ['Node'],
            inputs: [
                { name: 'model', type: 'BaseChatModel' },
                { name: 'instructions', type: 'string', default: '' }
            ]
        })
        const templates = marketplaceFlowTemplates()
        expect(templates.find((template) => template.type === 'Harness' && template.templateName === 'Upload Harness')).toBeTruthy()
        expect(templates.find((template) => template.type === 'Chatflow' && template.templateName === 'Upload Chatflow')).toBeTruthy()
        expect(templates.find((template) => template.templateName === 'CSV Agent')).toBeUndefined()
        expect(templates.length).toBeGreaterThan(10)
        for (const template of templates) {
            const normalized = normalizeTemplateFlow(template.flowData, spec)
            const flow = JSON.parse(normalized)
            expect(Array.isArray(flow.nodes)).toBe(true)
            expect(Array.isArray(flow.edges)).toBe(true)
            for (const node of flow.nodes) {
                expect(Array.isArray(node.data.inputAnchors)).toBe(true)
                expect(Array.isArray(node.data.inputParams)).toBe(true)
                expect(Array.isArray(node.data.outputAnchors)).toBe(true)
                const name = node.data.name
                if (name === 'stickyNote' || name === 'stickyNoteAgentflow') continue
                expect(nodeNames.has(name)).toBe(true)
            }
        }
        const upload = templates.find((template) => template.type === 'Harness' && template.templateName === 'Upload Harness')
        const uploadFlow = JSON.parse(normalizeTemplateFlow(upload!.flowData, spec))
        const chief = uploadFlow.nodes.find((node: { data?: { name?: string } }) => node.data?.name === 'harnessChief')
        expect(chief.data.inputAnchors.some((anchor: { name?: string }) => anchor.name === 'model')).toBe(true)
        expect(chief.data.inputParams.some((param: { name?: string }) => param.name === 'instructions')).toBe(true)
        expect(chief.data.inputs.instructions).toMatch(/sample the file/i)
        const uploadChat = templates.find((template) => template.type === 'Chatflow' && template.templateName === 'Upload Chatflow')
        const chatFlow = JSON.parse(normalizeTemplateFlow(uploadChat!.flowData, spec))
        expect(chatFlow.nodes.map((node: { data?: { name?: string } }) => node.data?.name).sort()).toEqual([
            'bufferMemory',
            'chatXAI',
            'harness',
            'toolAgent'
        ])
    })

    it('repairs a chief-of-staff edge that omitted the handle type', () => {
        const attached = 'BaseRetriever | Tool | VectorStore | Document | Embeddings | TextSplitter | BaseDocumentTransformer'
        const spec = (name: string) => {
            if (name === 'harnessChief') {
                return {
                    name,
                    type: 'HarnessChief',
                    baseClasses: ['HarnessChief'],
                    inputs: [
                        { name: 'chatModel', type: 'BaseChatModel' },
                        { name: 'specialists', type: 'HarnessSpecialist' },
                        { name: 'instructions', type: 'string' }
                    ]
                }
            }
            if (name === 'harnessSpecialist') {
                return {
                    name,
                    type: 'HarnessSpecialist',
                    baseClasses: ['HarnessSpecialist'],
                    inputs: [
                        { name: 'attached', type: attached },
                        { name: 'instructions', type: 'string' }
                    ]
                }
            }
            return { name, type: 'Node', baseClasses: ['Node'], inputs: [] }
        }
        const raw = JSON.stringify({
            nodes: [
                { id: 'analyst_0', data: { id: 'analyst_0', name: 'harnessSpecialist' } },
                { id: 'chief_0', data: { id: 'chief_0', name: 'harnessChief' } }
            ],
            edges: [
                {
                    id: 'analyst_0-chief_0-specialists',
                    source: 'analyst_0',
                    target: 'chief_0',
                    targetHandle: 'chief_0-input-specialists'
                }
            ]
        })
        const flow = JSON.parse(normalizeTemplateFlow(raw, spec))
        expect(flow.edges[0].sourceHandle).toBe('analyst_0-output-harnessSpecialist-HarnessSpecialist')
        expect(flow.edges[0].targetHandle).toBe('chief_0-input-specialists-HarnessSpecialist')
    })
})
