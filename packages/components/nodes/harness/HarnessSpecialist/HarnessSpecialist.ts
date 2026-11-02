import { INode, INodeData, INodeParams } from '../../../src/Interface'

class HarnessSpecialist_Harness implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]
    inputs: INodeParams[]

    constructor() {
        this.label = 'Harness Specialist'
        this.name = 'harnessSpecialist'
        this.version = 2.5
        this.type = 'HarnessSpecialist'
        this.icon = 'harness.svg'
        this.category = 'Harness'
        this.description =
            "Specialist on a harness roster. Uses Harness Prime's chat model unless you connect its own chat model. If that node needs a credential, select it there. Attach its tools."
        this.baseClasses = [this.type]
        this.inputs = [
            {
                label: 'Chat Model',
                name: 'chatModel',
                type: 'BaseChatModel',
                optional: true,
                description:
                    "Optional. Leave empty to use Harness Prime's chat model. When connected, this specialist uses only that node. If that node needs a credential, select it there."
            },
            {
                label: 'Fallback Chat Model',
                name: 'fallbackModel',
                type: 'BaseChatModel',
                optional: true,
                description:
                    "Optional. Used when this specialist's chat model is slow or returns 503. With nothing connected here, Harness Prime's fallback model is used if it has one."
            },
            {
                label: 'Attached',
                name: 'attached',
                type: 'BaseRetriever | Tool | VectorStore | Document | Embeddings | TextSplitter | BaseDocumentTransformer',
                list: true,
                optional: true,
                description: 'Connect a retriever, tool, MCP server, vector store, or the loader and splitter that feed them.'
            },
            {
                label: 'Name',
                name: 'specialistName',
                type: 'string',
                placeholder: 'researcher'
            },
            {
                label: 'Preset',
                name: 'preset',
                type: 'options',
                optional: true,
                additionalParams: true,
                default: 'none',
                options: [
                    { label: 'None', name: 'none', description: 'Only the instructions and tools set here.' },
                    {
                        label: 'Assets',
                        name: 'assets',
                        description:
                            'Makes PDF, DOCX, XLSX, CSV and PNG files with a shared style kit and sends them to the chat. Turns on Code execution and Files. An empty Name becomes assets.'
                    }
                ],
                description: 'Optional. A ready-made specialist. Its instructions come first; Instructions here are added after them.'
            },
            {
                label: 'Instructions',
                name: 'instructions',
                type: 'string',
                rows: 4,
                optional: true
            },
            {
                label: 'Routing summary',
                name: 'routingSummary',
                type: 'string',
                rows: 2,
                optional: true,
                description:
                    'Optional. What this specialist does, in up to 300 characters. Harness Prime reads it to choose specialists. Leave empty to use the start of the instructions.'
            },
            {
                label: 'Playbooks',
                name: 'playbooks',
                type: 'array',
                optional: true,
                additionalParams: true,
                description:
                    'Optional. Long rules this specialist loads only when a question needs them. It sees each name and "when to use" line, and reads the content on demand. The specialist runs in Hermes.',
                array: [
                    { label: 'Name', name: 'name', type: 'string', placeholder: 'refund-rules' },
                    { label: 'When to use', name: 'description', type: 'string', placeholder: 'Questions about refunds and credits' },
                    { label: 'Content', name: 'content', type: 'string', rows: 8 }
                ]
            },
            {
                label: 'Answer direct',
                name: 'answerDirect',
                type: 'boolean',
                default: false,
                optional: true,
                additionalParams: true,
                description:
                    "Return this specialist's answer as the reply when it is the only step and it succeeded. Harness Prime's instructions, persona and Handoff limit do not apply to that reply."
            },
            {
                label: 'Trusted outputs',
                name: 'trustedOutputs',
                type: 'json',
                optional: true,
                additionalParams: true,
                description:
                    'Optional pin-to-output contracts. Each names a tested pin and hash, with mode markdown (source field paths), monthly-utilization-png or table-payload-csv. Markdown can use renderWhen: {path, equals} to render only matching complete source outcomes; other outcomes remain evidence for resolution or clarification. Consumes the actual server result for exact factual output/files and skips Harness Prime rewriting. Interpret protected evidence can add a separate source-grounded readout before those facts. Empty is off.'
            },
            {
                label: 'Unmapped output policy',
                name: 'trustedOutputPolicy',
                type: 'options',
                options: [
                    { label: 'Require a trusted contract', name: 'strict' },
                    { label: 'Allow other verified pinned queries', name: 'verified-passthrough' },
                    { label: 'Allow verified read-only SQL fallback', name: 'verified-query-passthrough' }
                ],
                default: 'strict',
                optional: true,
                additionalParams: true,
                description:
                    'Applies only with Trusted outputs. Passthrough keeps ordinary answers/files for independently stamped unmapped queries, or non-data clarifications without files. The guarded SQL option also accepts native, read-only query evidence with turn identity and statement hash, with at most two query calls per turn. Mapped factual output is never replaced by model output.'
            },
            {
                label: 'Interpret protected evidence',
                name: 'trustedInterpretation',
                type: 'boolean',
                default: false,
                optional: true,
                additionalParams: true,
                description:
                    'Let the specialist read bounded source evidence and lead with a labeled interpretation. Source-owned factual output remains unchanged. Unsupported numeric, date or currency claims suppress the interpretation.'
            },
            {
                label: 'Interpretation evidence paths',
                name: 'trustedInterpretationPaths',
                type: 'json',
                optional: true,
                additionalParams: true,
                description:
                    'Optional JSON array of source-result paths, in priority order, such as ["rows.0.report", "rows.0.notes"]. Missing optional paths are disclosed; source context is bounded and never a source completeness claim.'
            },
            {
                label: 'Pin first',
                name: 'pinFirst',
                type: 'boolean',
                default: false,
                optional: true,
                additionalParams: true,
                description:
                    "Run one matching pinned query before the specialist model. A matching success is shown as written; Harness Prime's persona and Handoff limit do not apply to that reply. Interpret protected evidence takes precedence: the specialist model runs the matching source and explains it instead of using this model-free shortcut."
            },
            {
                label: 'Pin first rules',
                name: 'pinFirstRules',
                type: 'json',
                optional: true,
                additionalParams: true,
                description: 'Optional array of rules with id, pin, when, params and answer. Rules contain named parameter values only.'
            },
            {
                label: 'Capacity wait (seconds)',
                name: 'capacityWaitSeconds',
                type: 'number',
                optional: true,
                additionalParams: true,
                default: 0,
                description:
                    'Optional. Wait up to 60 seconds when the agent runtime rejects a new run because all slots are busy. Default 0, off. Honors Retry-After and the existing turn time limit. Never retries a run that was accepted or a tool that already ran.'
            },
            {
                label: 'Handoff limit',
                name: 'handoffChars',
                type: 'number',
                optional: true,
                additionalParams: true,
                placeholder: '4000',
                description:
                    "Optional. How many characters of this specialist's answer Harness Prime reads before it writes the reply. A decimal is rounded down first. Default 4,000. Empty or 0 means the default. -1 means no limit: Harness Prime reads the whole answer, but a full context still shortens it. Other values are kept from 160 to 20,000: a lower value is read as 160, a higher one as 20,000. Any other negative number, or text, means the default. A long knowledge answer may need more."
            },
            {
                label: 'Shell',
                name: 'enableShell',
                type: 'boolean',
                default: false,
                optional: true,
                description: 'Off unless this specialist needs a shell.'
            },
            {
                label: 'Browser',
                name: 'enableBrowser',
                type: 'boolean',
                default: false,
                optional: true
            },
            {
                label: 'Code execution',
                name: 'enableCodeExecution',
                type: 'boolean',
                default: false,
                optional: true,
                description: 'Runs Python scripts with execute_code.'
            },
            {
                label: 'Files',
                name: 'enableFileAccess',
                type: 'boolean',
                default: false,
                optional: true,
                description: 'Reads and writes files in this specialist workspace.'
            }
        ]
    }

    async run(_nodeData: INodeData): Promise<string> {
        const error = new Error('A specialist is saved with the harness. A chat flow runs it by selecting the harness name.') as Error & {
            harnessError?: boolean
        }
        error.harnessError = true
        throw error
    }
}

module.exports = { nodeClass: HarnessSpecialist_Harness }
