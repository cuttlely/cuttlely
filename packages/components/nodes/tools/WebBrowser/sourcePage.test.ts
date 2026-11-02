import { readSourcePage } from './sourcePage'
import type { RequestInit } from 'node-fetch'

const marker = '\n\n----FLOWISE_SOURCE_DOCUMENTS----\n\n'
function fetched(body: string, type = 'text/html', ok = true) {
    return jest.fn(async (_url: string, _init?: RequestInit) => ({
        ok,
        status: ok ? 200 : 503,
        url: 'https://example.org/final',
        headers: { get: () => type },
        text: async () => body
    }))
}

test('source mode returns fetched main content and actual destination, without model-generated procedure claims', async () => {
    const fetchPage = fetched(
        '<html><head><title>Authentication</title></head><body><nav>Invented role resource</nav><main><h1>Authentication</h1><p>Map users and groups to policies.</p><code>auth/example/groups/readers</code><a href="/other">Related page</a></main><script>invented implementation</script></body></html>'
    )
    const result = await readSourcePage('"https://example.org/requested", "authentication configuration"', fetchPage)
    const [text, metadata] = result.split(marker)
    expect(text).toContain('Map users and groups to policies.')
    expect(text).toContain('auth/example/groups/readers')
    expect(text).not.toContain('Invented role resource')
    expect(text).not.toContain('invented implementation')
    const docs = JSON.parse(metadata)
    expect(docs).toHaveLength(1)
    expect(docs[0].metadata).toEqual({ source: 'https://example.org/final', title: 'Authentication' })
    expect(docs[0].pageContent).toContain('Map users and groups to policies.')
    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(fetchPage.mock.calls[0]).toEqual(['https://example.org/requested', expect.objectContaining({ size: 2097152 })])
})

test('invalid destinations and unsuccessful or unsupported pages cannot become source evidence', async () => {
    for (const input of ['file:///private/path', 'https://user:password@example.org/']) {
        const fetchPage = fetched('text', 'text/plain')
        await expect(readSourcePage(input, fetchPage)).rejects.toThrow()
        expect(fetchPage).not.toHaveBeenCalled()
    }
    for (const fetchPage of [
        fetched('failed', 'text/plain', false),
        fetched('binary', 'application/octet-stream'),
        fetched(''),
        fetched('x'.repeat(2097153), 'text/plain')
    ])
        await expect(readSourcePage('https://example.org/', fetchPage)).rejects.toThrow()
})

test('raw excerpts and receipts remain bounded and do not promote linked destinations to visited sources', async () => {
    const result = await readSourcePage('https://example.org/', fetched('Actual fetched text. '.repeat(4000), 'text/plain'))
    const [text, metadata] = result.split(marker)
    const docs = JSON.parse(metadata)
    expect(text).toContain('Excerpt only')
    expect(Buffer.byteLength(JSON.stringify({ result: text }))).toBeLessThan(45000)
    expect(docs.length).toBeLessThanOrEqual(2)
    expect(
        docs.every(
            (doc: { pageContent: string; metadata: { source: string } }) =>
                doc.pageContent.length <= 12000 && doc.metadata.source === 'https://example.org/final'
        )
    ).toBe(true)
})
