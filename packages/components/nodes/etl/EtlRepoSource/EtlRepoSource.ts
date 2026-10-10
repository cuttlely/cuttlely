import { INode, INodeOutputsValue, INodeParams } from '../../../src/Interface'
import { streamingOnlyError } from '../engine'

class EtlRepoSource_ETL implements INode {
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
        this.label = 'Code Repository'
        this.name = 'etlRepoSource'
        this.version = 1.0
        this.type = 'Document'
        this.icon = 'etlrepo.svg'
        this.category = 'ETL'
        this.badge = 'NEW'
        this.description =
            'Walks a repository file by file with .gitignore and default ignores. Unchanged files are skipped on the next run without being read.'
        this.baseClasses = [this.type]
        this.inputs = [
            {
                label: 'Text Splitter',
                name: 'textSplitter',
                type: 'TextSplitter',
                optional: true,
                description: 'A Code Text Splitter keeps functions together.'
            },
            {
                label: 'Folder Path',
                name: 'repoPath',
                type: 'string',
                placeholder: '/srv/repos/my-service',
                optional: true,
                description: 'A checkout on the server. Leave empty to clone the Git URL instead.'
            },
            {
                label: 'Git URL',
                name: 'gitUrl',
                type: 'string',
                placeholder: 'https://github.com/org/repo.git',
                optional: true,
                description: 'Public https repository, shallow-cloned under .cuttlely/etl/repos and fetched again on each run.'
            },
            {
                label: 'Branch',
                name: 'branch',
                type: 'string',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Include Globs',
                name: 'include',
                type: 'string',
                placeholder: '**/*.ts, **/*.md',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Exclude Globs',
                name: 'exclude',
                type: 'string',
                placeholder: 'test/**, **/*.snap',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Respect .gitignore',
                name: 'respectGitignore',
                type: 'boolean',
                default: true,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Default Ignores',
                name: 'defaultIgnores',
                type: 'boolean',
                default: true,
                description: 'Skip .git, node_modules, build output, lockfiles, and binary files.',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Max File Size (KB)',
                name: 'maxFileKb',
                type: 'number',
                default: 1024,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Repository Label',
                name: 'repoLabel',
                type: 'string',
                placeholder: 'my-service',
                description: 'Stored as metadata.repository on every chunk.',
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

module.exports = { nodeClass: EtlRepoSource_ETL }
