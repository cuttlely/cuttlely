const { nodeClass, formatRetrievedDocuments } = require('./RetrieverTool')
import { INodeData } from '../../../src/Interface'
import { SOURCE_DOCUMENTS_PREFIX } from '../../../src/agents'

function createNodeData(inputs: Record<string, unknown>): INodeData {
    return {
        id: 'retriever-tool-test',
        label: 'Retriever Tool',
        name: 'retrieverTool',
        type: 'RetrieverTool',
        icon: 'retrievertool.svg',
        version: 3.0,
        category: 'Tools',
        baseClasses: ['RetrieverTool', 'DynamicTool'],
        inputs
    }
}

const sourcedDocs = [
    {
        pageContent: 'Calloway directs Brindlewick.',
        metadata: { source: '/srv/cuttlely/corpus/brindlewick.md', loc: { lines: { from: 1, to: 3 } } }
    },
    { pageContent: 'The mirror is 4.7 m.', metadata: { source: 'C:\\data\\mirror.md', url: 'https://example.com/a/b' } }
]

describe('formatRetrievedDocuments', () => {
    it('writes a title and http(s) url header before each chunk', () => {
        const docs = [
            {
                pageContent: 'The speech.',
                metadata: {
                    title: ' State\nof the Union ',
                    url: ' https://example.com/sotu ',
                    source: '/srv/secret/speech.md'
                }
            },
            { pageContent: 'Second chunk.', metadata: { title: 'Notes', url: 'https://example.com/notes' } }
        ]

        expect(formatRetrievedDocuments(docs)).toBe(
            '[1] State of the Union - https://example.com/sotu\nThe speech.\n\n[2] Notes - https://example.com/notes\nSecond chunk.'
        )
        expect(
            formatRetrievedDocuments([
                {
                    pageContent: 'Canonical.',
                    metadata: { title: 'Memo', url: 'doc-42', source: 'https://example.com/other' }
                }
            ])
        ).toBe('[1] Memo - https://example.com/other\nCanonical.')
    })

    it('uses an http(s) source, link, or href as the url when no url field is set', () => {
        expect(formatRetrievedDocuments([{ pageContent: 'From source.', metadata: { source: 'https://example.com/doc' } }])).toBe(
            '[1] https://example.com/doc\nFrom source.'
        )
        expect(formatRetrievedDocuments([{ pageContent: 'From link.', metadata: { link: 'https://example.com/l' } }])).toBe(
            '[1] https://example.com/l\nFrom link.'
        )
        expect(formatRetrievedDocuments([{ pageContent: 'From href.', metadata: { href: 'http://example.com/h' } }])).toBe(
            '[1] http://example.com/h\nFrom href.'
        )
    })

    it('uses only the file name when source, file, or filename is an absolute path or file url', () => {
        expect(formatRetrievedDocuments([{ pageContent: 'Unix.', metadata: { source: '/srv/cuttlely/corpus/brindlewick.md' } }])).toBe(
            '[1] brindlewick.md\nUnix.'
        )
        expect(formatRetrievedDocuments([{ pageContent: 'Windows.', metadata: { source: 'C:\\data\\mirror.md' } }])).toBe(
            '[1] mirror.md\nWindows.'
        )
        expect(formatRetrievedDocuments([{ pageContent: 'File URL.', metadata: { source: 'file:///var/data/notes.md' } }])).toBe(
            '[1] notes.md\nFile URL.'
        )
        expect(formatRetrievedDocuments([{ pageContent: 'File field.', metadata: { file: '/tmp/a.txt' } }])).toBe('[1] a.txt\nFile field.')
        expect(formatRetrievedDocuments([{ pageContent: 'Name field.', metadata: { filename: 'D:\\docs\\readme.txt' } }])).toBe(
            '[1] readme.txt\nName field.'
        )
        expect(formatRetrievedDocuments([{ pageContent: 'Relative.', metadata: { source: 'corpus/brindlewick.md' } }])).toBe(
            '[1] corpus/brindlewick.md\nRelative.'
        )
    })

    it('uses a bare index when the document has no title or url', () => {
        expect(formatRetrievedDocuments([{ pageContent: 'Loose note.' }])).toBe('[1]\nLoose note.')
        expect(formatRetrievedDocuments([{ pageContent: 'Empty meta.', metadata: {} }])).toBe('[1]\nEmpty meta.')
        expect(formatRetrievedDocuments([{ pageContent: 'Other meta.', metadata: { loc: { lines: { from: 1 } } } }])).toBe(
            '[1]\nOther meta.'
        )
    })
})

describe('retriever tool', () => {
    async function initTool(returnSourceDocuments?: boolean) {
        const inputs: Record<string, unknown> = {
            name: 'search_kb',
            description: 'Search the knowledge base',
            retriever: { invoke: async () => sourcedDocs }
        }
        if (returnSourceDocuments !== undefined) inputs.returnSourceDocuments = returnSourceDocuments
        return new nodeClass().init(createNodeData(inputs), '', { chatflowid: 'x' })
    }

    it('puts headers and chunks before the source JSON when returnSourceDocuments is true', async () => {
        const tool = await initTool(true)
        const output = await tool.call({ input: 'Who directs Brindlewick?' })
        const at = output.indexOf(SOURCE_DOCUMENTS_PREFIX)
        const visible = output.slice(0, at)
        const json = output.slice(at + SOURCE_DOCUMENTS_PREFIX.length)

        expect(at).toBeGreaterThan(0)
        expect(visible).toBe(
            '[1] brindlewick.md\nCalloway directs Brindlewick.\n\n[2] mirror.md - https://example.com/a/b\nThe mirror is 4.7 m.'
        )
        expect(visible).toBe(formatRetrievedDocuments(sourcedDocs))
        expect(json).toBe(JSON.stringify(sourcedDocs))
        expect(output).toBe(visible + SOURCE_DOCUMENTS_PREFIX + json)
        expect(visible.includes('/srv/cuttlely')).toBe(false)
        expect(visible.includes('C:\\data')).toBe(false)
    })

    it('returns exactly the joined page content when returnSourceDocuments is false or omitted', async () => {
        const joined = sourcedDocs.map((doc) => doc.pageContent).join('\n\n')
        const off = await initTool(false)
        const omitted = await initTool()

        expect(await off.call({ input: 'Who directs Brindlewick?' })).toBe(joined)
        expect(await omitted.call({ input: 'Who directs Brindlewick?' })).toBe(joined)
        expect(joined.includes(SOURCE_DOCUMENTS_PREFIX)).toBe(false)
        expect(joined.includes('[1]')).toBe(false)
    })
})
