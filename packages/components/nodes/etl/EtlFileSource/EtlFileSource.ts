import { INode, INodeOutputsValue, INodeParams } from '../../../src/Interface'
import { streamingOnlyError } from '../engine'

class EtlFileSource_ETL implements INode {
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
        this.label = 'Streaming Files'
        this.name = 'etlFileSource'
        this.version = 1.1
        this.type = 'Document'
        this.icon = 'etlfile.svg'
        this.category = 'ETL'
        this.badge = 'NEW'
        this.description =
            'Streams files from the server: CSV and TSV row by row, JSONL line by line, other text in segments. Never holds a whole file in memory.'
        this.baseClasses = [this.type]
        this.inputs = [
            {
                label: 'Text Splitter',
                name: 'textSplitter',
                type: 'TextSplitter',
                optional: true
            },
            {
                label: 'Paths',
                name: 'paths',
                type: 'string',
                rows: 3,
                placeholder: '/data/products.csv\n/data/manuals/',
                description: 'Files or folders on the server, one per line. Uploads from the ETL panel land under .cuttlely/etl/uploads.'
            },
            {
                label: 'Format',
                name: 'format',
                type: 'options',
                default: 'auto',
                options: [
                    { label: 'From extension', name: 'auto' },
                    { label: 'Text', name: 'text' },
                    { label: 'CSV', name: 'csv' },
                    { label: 'TSV', name: 'tsv' },
                    { label: 'JSON Lines', name: 'jsonl' }
                ],
                optional: true
            },
            {
                label: 'CSV Text Columns',
                name: 'textColumns',
                type: 'string',
                placeholder: 'title, body',
                description: 'Columns that become the document text. Empty uses every column as "name: value" lines.',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Key Column or Field',
                name: 'idColumn',
                type: 'string',
                placeholder: 'id',
                description:
                    'Required for CSV, TSV and JSONL: the column (or JSONL field) that identifies a record, so an edited record replaces its old chunks. Text files are keyed by path.',
                optional: true
            },
            {
                label: 'CSV Metadata Columns',
                name: 'metadataColumns',
                type: 'string',
                placeholder: 'category, url',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Delimiter',
                name: 'delimiter',
                type: 'string',
                placeholder: ',',
                optional: true,
                additionalParams: true
            },
            {
                label: 'JSONL Text Field',
                name: 'textField',
                type: 'string',
                placeholder: 'text',
                description: 'Defaults to the first of text, content or body; otherwise the whole line.',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Schema',
                name: 'schema',
                type: 'json',
                placeholder: '{ "fields": { "price": { "type": "decimal", "scale": 2 }, "updated": { "type": "datetime" } } }',
                description:
                    'Optional field types for CSV and JSONL (string, integer, bigint, number, decimal, boolean, date, datetime, json), null tokens and caps. A value that does not fit rejects its record with a reason; nothing is truncated.',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Allow Trailing Delimiter',
                name: 'allowTrailingDelimiter',
                type: 'boolean',
                default: true,
                description: 'Accept CSV rows that end with one extra empty field after a trailing delimiter.',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Folder Include Globs',
                name: 'include',
                type: 'string',
                placeholder: '**/*.md, **/*.txt',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Text Segment Size (KB)',
                name: 'segmentKb',
                type: 'number',
                default: 256,
                description: 'Large text files are cut into segments of this size at a paragraph or line break before splitting.',
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

    async init(): Promise<any> {
        throw streamingOnlyError(this.label)
    }
}

module.exports = { nodeClass: EtlFileSource_ETL }
