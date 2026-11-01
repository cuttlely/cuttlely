import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
    beginRetrievedSources,
    recordRetrievedSources,
    takeRetrievedSources,
    endRetrievedSources,
    citedRetrievedGuidance
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
        { modules: [{ nodeName: 'webBrowser' }] }
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
