import fs from 'fs'
import path from 'path'
import { PartDefinition } from './recipe'

export const workflowSamplesDir = path.join(__dirname, '..', '..', '..', 'marketplaces', 'agentflowsv2')

export const readWorkflowSamples = () =>
    fs
        .readdirSync(workflowSamplesDir)
        .filter((file) => file.endsWith('.json'))
        .map((file) => ({ file, flow: JSON.parse(fs.readFileSync(path.join(workflowSamplesDir, file), 'utf8')) }))

// Part definitions rebuilt from the cards saved in the bundled workflows, so the tests use real part names,
// settings and plugs without loading the whole nodes pool. Tools named in those workflows come too.
export function partsFromSamples(): Record<string, PartDefinition> {
    const parts: Record<string, PartDefinition> = {}
    for (const { flow } of readWorkflowSamples()) {
        for (const node of flow.nodes || []) {
            const data = node.data || {}
            if (!parts[data.name]) {
                const params = (data.inputParams || []).map(({ id: _id, ...param }: any) => param)
                parts[data.name] = {
                    name: data.name,
                    label: data.label,
                    description: data.description || `${data.label} part`,
                    category: 'Agent Flows',
                    color: data.color,
                    hideInput: data.hideInput,
                    hideOutput: data.hideOutput,
                    outputs:
                        (data.outputAnchors || []).length > 1
                            ? data.outputAnchors.map((anchor: any) => ({ label: String(anchor.label), name: String(anchor.name) }))
                            : undefined,
                    inputs: params.filter((param: any) => param.type !== 'credential'),
                    credential: params.find((param: any) => param.type === 'credential')
                }
            }
            const inputs = data.inputs || {}
            const tools = [
                ...(Array.isArray(inputs.agentTools) ? inputs.agentTools.map((t: any) => t?.agentSelectedTool) : []),
                inputs.toolAgentflowSelectedTool
            ].filter(Boolean)
            for (const tool of tools) parts[tool] ||= { name: tool, label: tool, description: `${tool} tool`, category: 'Tools' }
        }
    }
    parts.chatOpenAI = { name: 'chatOpenAI', label: 'ChatOpenAI', category: 'Chat Models' }
    parts.serpAPI = {
        name: 'serpAPI',
        label: 'Serp API',
        description: 'Web search',
        category: 'Tools',
        credential: { label: 'Connect Credential', name: 'credential', type: 'credential', credentialNames: ['serpApi'] }
    }
    return parts
}

// A light stand-in for the card setup in @cuttlely/components: default inputs, one output plug per output.
// Like the real one, it rewrites the object it is given (inputs become values, the credential is emptied).
export const fakeInitNode = (definition: Record<string, any>, id: string) => {
    const inputs: Record<string, any> = {}
    for (const param of definition.inputs || []) inputs[param.name] = param.default ?? ''
    const outputs = definition.hideOutput
        ? []
        : definition.outputs?.length
        ? definition.outputs.map((_: any, index: number) => ({
              id: `${id}-output-${index}`,
              label: definition.label,
              name: definition.name
          }))
        : [{ id: `${id}-output-${definition.name}`, label: definition.label, name: definition.name }]
    return Object.assign(definition, {
        id,
        inputParams: [...(definition.credential ? [definition.credential] : []), ...(definition.inputs || [])],
        inputs,
        outputAnchors: outputs,
        credential: ''
    })
}
