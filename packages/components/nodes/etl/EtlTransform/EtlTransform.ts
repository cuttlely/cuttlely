import { flatten } from 'lodash'
import { Document } from '@langchain/core/documents'
import { INode, INodeData, INodeOutputsValue, INodeParams } from '../../../src/Interface'
import { loadEtlModule } from '../engine'

class EtlTransform_ETL implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    badge: string
    baseClasses: string[]
    inputs: INodeParams[]
    outputs: INodeOutputsValue[]

    constructor() {
        this.label = 'Clean & Transform'
        this.name = 'etlTransform'
        this.version = 1.1
        this.type = 'Document'
        this.icon = 'etltransform.svg'
        this.category = 'ETL'
        this.badge = 'NEW'
        this.description = 'Cleans documents before splitting: Unicode and whitespace, HTML, short documents, metadata, and a text prefix.'
        this.baseClasses = [this.type]
        this.inputs = [
            {
                label: 'Document',
                name: 'document',
                type: 'Document',
                list: true
            },
            {
                label: 'Normalize Whitespace',
                name: 'normalizeWhitespace',
                type: 'boolean',
                default: true,
                optional: true
            },
            {
                label: 'Normalize Unicode (NFC)',
                name: 'normalizeUnicode',
                type: 'boolean',
                default: true,
                optional: true
            },
            {
                label: 'Strip HTML',
                name: 'stripHtml',
                type: 'boolean',
                default: false,
                optional: true
            },
            {
                label: 'Minimum Characters',
                name: 'minChars',
                type: 'number',
                default: 1,
                description: 'Drop documents shorter than this after cleaning.',
                optional: true
            },
            {
                label: 'Key Template',
                name: 'keyTemplate',
                type: 'string',
                placeholder: '{{source}}#{{loc.pageNumber}}',
                description:
                    'Required after a document loader: builds each record key from its metadata, so an edited document replaces its old chunks. A document missing a referenced value is rejected as missing_key.',
                optional: true
            },
            {
                label: 'Prefix Template',
                name: 'prefixTemplate',
                type: 'string',
                placeholder: 'File: {path}\\n',
                description: 'Prepended to the text. {key} is replaced by that metadata value.',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Add Metadata',
                name: 'metadata',
                type: 'json',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Keep Only Metadata Keys',
                name: 'keepMetadataKeys',
                type: 'string',
                placeholder: 'source, path, title',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Omit Metadata Keys',
                name: 'omitMetadataKeys',
                type: 'string',
                placeholder: 'loc, pdf',
                optional: true,
                additionalParams: true
            }
        ]
        this.outputs = [
            {
                label: 'Document',
                name: 'document',
                baseClasses: this.baseClasses
            }
        ]
    }

    async init(nodeData: INodeData): Promise<any> {
        const docs = flatten((nodeData.inputs?.document as Document[]) || [])
        const engine = await loadEtlModule('transform.mjs')
        const apply = engine.compileTransform({ inputs: nodeData.inputs || {} })
        const out: Document[] = []
        for (const doc of docs) {
            if (!doc?.pageContent) continue
            const shaped = apply({ pageContent: doc.pageContent, metadata: { ...(doc.metadata || {}) } })
            if (shaped) out.push(new Document({ pageContent: shaped.pageContent, metadata: shaped.metadata }))
        }
        return out
    }
}

module.exports = { nodeClass: EtlTransform_ETL }
