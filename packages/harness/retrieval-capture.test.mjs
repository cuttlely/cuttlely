import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
    beginRetrievedSources,
    recordRetrievedSources,
    takeRetrievedSources,
    endRetrievedSources,
    citedRetrievedGuidance,
    renderRetrievedSourceReferences
} from './retrieval-capture.mjs'
import { composeTrustedOutputs } from './trusted-output.mjs'

const scope = { harness: 'example', specialist: 'docs', sourceTurn: 'example--docs:chat#turn-one' }
const url = 'https://example.org/docs/auth'
const document = {
    pageContent: 'The provider authenticates the user; the application assigns policies.',
    metadata: { source: url, title: 'Authentication', private: 'omit' }
}
const specialist = { modules: [{ nodeName: 'retrieverTool' }] }
const guidance = `Use the supported authentication method. [Authentication][auth]\n\n[auth]: ${url}`

test('documentation repair references use captured destinations and remain citation-validated', () => {
    const sources = [{ url }, { url: 'https://example.org/docs/a(b)?version=2&mode=auth#login' }]
    const answer = renderRetrievedSourceReferences(
        JSON.stringify({ answer: 'Authenticate using the documented method. {{source:S1}} Compare version limits. {{source:S2}}' }),
        sources
    )
    assert.equal(
        answer,
        `Authenticate using the documented method. [Source 1](<${url}>) Compare version limits. [Source 2](<${sources[1].url}>)`
    )
    assert(
        citedRetrievedGuidance(
            specialist,
            answer,
            sources.map((s) => ({ metadata: { source: s.url } }))
        )
    )
    assert.equal(renderRetrievedSourceReferences(guidance, sources), guidance)
    assert.equal(
        renderRetrievedSourceReferences('```json\n{"answer":"Use the method. {{source:S1}}"}\n```', sources),
        `Use the method. [Source 1](<${url}>)`
    )
    const invented = renderRetrievedSourceReferences('{"answer":"Read {{source:S1}} and https://unretrieved.example/"}', sources)
    assert.equal(citedRetrievedGuidance(specialist, invented, [document]), null)
})

test('invalid, missing, credentialed and out-of-range repair references fail closed', () => {
    for (const reply of [
        '{"answer":"Read {{source:S0}}"}',
        '{"answer":"Read {{source:S2}}"}',
        '{"answer":"Read {{source:S33}}"}',
        '{"answer":"Read {{source:S1.0}}"}',
        '{"answer":"Read {{source:S1}"}',
        '{{source:'.repeat(7000),
        '{"answer":"Read {{source:S1}}", "sources":["https://invented.example/"]}',
        '{"answer":null}',
        '{"answer":""}',
        '{invalid',
        'x'.repeat(65537)
    ])
        assert.equal(renderRetrievedSourceReferences(reply, [{ url }]), null, reply.slice(0, 100))
    for (const destination of ['file:///private/data', 'https://user:password@example.org/', 'not a URL'])
        assert.equal(renderRetrievedSourceReferences('{"answer":"Read {{source:S1}}"}', [{ url: destination }]), null)
    assert.equal(renderRetrievedSourceReferences('{"answer":"Read {{source:S1}}"}', []), null)
    assert.equal(
        renderRetrievedSourceReferences(JSON.stringify({ answer: '{{source:S1}}'.repeat(100) }), [
            { url: `https://example.org/${'x'.repeat(4000)}` }
        ]),
        null
    )
})

test('retrieval receipts require an active exact turn and actual call identity, and are consumed once', () => {
    beginRetrievedSources(scope)
    recordRetrievedSources({ ...scope, sourceTurn: 'other' }, { callId: 'call-one', documents: [document] })
    recordRetrievedSources(scope, { documents: [document] })
    recordRetrievedSources(scope, { callId: 'call-one', documents: [document] })
    recordRetrievedSources(scope, { callId: 'call-one', documents: [{ ...document, pageContent: 'duplicate' }] })
    recordRetrievedSources({ ...scope, specialist: 'other' }, { callId: 'call-two', documents: [document] })
    const sources = takeRetrievedSources(scope)
    assert.equal(sources.length, 1)
    assert.deepEqual(sources[0].metadata, { source: url, title: 'Authentication' })
    assert.deepEqual(takeRetrievedSources(scope), [])
    recordRetrievedSources(scope, { callId: 'late', documents: [document] })
    assert.deepEqual(takeRetrievedSources(scope), [])
})

test('cancelled turns and concurrent profiles cannot share retrieved evidence', () => {
    const other = { ...scope, sourceTurn: 'example--docs:chat#turn-two' }
    beginRetrievedSources(scope)
    beginRetrievedSources(other)
    recordRetrievedSources(scope, { callId: 'first', documents: [document] })
    endRetrievedSources(scope)
    assert.deepEqual(takeRetrievedSources(scope), [])
    assert.deepEqual(takeRetrievedSources(other), [])
})

test('receipts are bounded and only retain public HTTP source documents', () => {
    beginRetrievedSources(scope)
    recordRetrievedSources(scope, {
        callId: 'docs',
        documents: [
            { pageContent: 'private', metadata: { source: '/private/file' } },
            { pageContent: 'secret', metadata: { source: 'https://user:password@example.org/' } },
            { pageContent: '', metadata: { source: url } },
            ...Array.from({ length: 100 }, () => document)
        ]
    })
    assert.equal(takeRetrievedSources(scope).length, 32)
    beginRetrievedSources(scope)
    recordRetrievedSources(scope, {
        callId: 'large',
        documents: Array.from({ length: 100 }, () => ({ ...document, pageContent: 'x'.repeat(50000) }))
    })
    const sources = takeRetrievedSources(scope)
    assert.ok(Buffer.byteLength(JSON.stringify(sources)) < 262144)
    assert.ok(sources.every((doc) => doc.pageContent.length <= 12000))
})

test('only cited retrieval-only guidance may accompany the exact protected report', () => {
    assert.deepEqual(citedRetrievedGuidance(specialist, guidance, [document]), { text: guidance })
    for (const role of [
        { ...specialist, mcpServers: [{ nodeName: 'postgreSQLMCP' }] },
        { ...specialist, trustedOutputs: [{}] },
        { ...specialist, codeExecution: true },
        { ...specialist, shell: true },
        { ...specialist, fileAccess: true },
        { modules: [{ nodeName: 'customTool' }] }
    ])
        assert.equal(citedRetrievedGuidance(role, guidance, [document]), null)
    assert.equal(citedRetrievedGuidance(specialist, guidance, []), null)
    assert.equal(citedRetrievedGuidance(specialist, 'Uncited invented guidance', [document]), null)
    assert.equal(citedRetrievedGuidance(specialist, guidance.replace(url, 'https://example.org/docs/other'), [document]), null)
    assert.equal(citedRetrievedGuidance(specialist, guidance + '\n[Unretrieved](https://unretrieved.example/)', [document]), null)
    assert.ok(citedRetrievedGuidance(specialist, `See ${url}.`, [document]))
    assert.equal(citedRetrievedGuidance(specialist, `See ${url}-unretrieved.`, [document]), null)
    const protectedText = '| Account | ACV |\n|---|---:|\n| Example | $123.45 |\n\nSource: exact returned scope.'
    const result = composeTrustedOutputs([
        { status: 'completed', trustedOutput: true, text: protectedText },
        { status: 'completed', retrievedGuidance: true, text: guidance }
    ])
    assert.equal(result, protectedText + '\n\nAdditional requested guidance from retrieved documentation:\n\n' + guidance)
    assert.ok(
        !composeTrustedOutputs([
            { status: 'completed', trustedOutput: true, text: protectedText },
            { status: 'failed', retrievedGuidance: true, text: guidance }
        ]).includes(guidance)
    )
    assert.ok(
        !composeTrustedOutputs([
            { status: 'completed', trustedOutput: true, text: protectedText },
            { status: 'completed', text: 'Fabricated business data' }
        ]).includes('Fabricated business data')
    )
})

test('successful browser summaries supply exact visited URLs; failed calls and unrelated tools cannot create receipts', async () => {
    const { executeModule } = await import('./bridge.mjs')
    const run = async (nodeName, input, response) => {
        let sources = []
        const result = await executeModule({ nodeName, nodeId: 'browser-source', inputs: {} }, input, {
            flowOptions: { appDataSource: {} },
            onRetrievedSources: (docs) => {
                sources = docs
            },
            loadNode: async () =>
                class {
                    async init() {
                        return { name: 'browser', invoke: async () => response }
                    }
                }
        })
        return { result, sources }
    }
    const text = 'The fetched documentation describes authentication and mapped policies.'
    const result = await run('webBrowser', '"https://example.org/docs/auth/", "summarize"', text)
    assert.equal(result.result, text)
    assert.deepEqual(result.sources, [{ pageContent: text, metadata: { source: 'https://example.org/docs/auth' } }])
    assert(
        citedRetrievedGuidance({ modules: [{ nodeName: 'webBrowser' }] }, '[Documentation](https://example.org/docs/auth)', result.sources)
    )
    assert.equal(
        citedRetrievedGuidance(
            { modules: [{ nodeName: 'webBrowser' }], codeExecution: true },
            '[Documentation](https://example.org/docs/auth)',
            result.sources
        ),
        null
    )
    for (const response of ['Error: http response 404', 'TypeError: fetch failed', 'There was a problem connecting to the site', '']) {
        assert.deepEqual((await run('webBrowser', 'https://example.org/docs/auth', response)).sources, [])
    }
    for (const input of ['file:///tmp/private', 'https://user:secret@example.org/docs', 'not a URL']) {
        assert.deepEqual((await run('webBrowser', input, text)).sources, [])
    }
    assert.deepEqual((await run('customTool', 'https://example.org/docs/auth', text)).sources, [])
})
