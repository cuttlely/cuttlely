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

test('native source reads use the original user URL, survive same-site redirects, and retain the released excerpt', async () => {
    const url = 'https://example.org/guide'
    const page = fetched('<html><title>Guide</title><main>Order received.</main></html>')
    const current = jest.fn()
    const turn = { question: 'Please summarize [the guide](' + url + ').', assertCurrent: current }
    const released = await readSourcePage(url, page)
    expect(await readSourcePage('"' + url + '", "purchase"', page, turn)).toBe(released)
    expect(page.mock.calls.at(-1)).toEqual([
        url,
        expect.objectContaining({ size: 2097152 }),
        5,
        { publicPageOrigin: 'https://example.org' }
    ])
    expect(current).toHaveBeenCalledTimes(2)
    const trailing = fetched('User page', 'text/plain')
    await readSourcePage(url + '/', trailing, { ...turn, question: 'Read ' + url + '/' })
    expect(trailing.mock.calls[0][0]).toBe(url + '/')
    for (const other of ['https://example.org/other', 'https://example.org:8080/guide', 'https://other.example/guide']) {
        await expect(readSourcePage(other, page, turn)).rejects.toThrow(/exact public page URL/)
    }
    expect(page).toHaveBeenCalledTimes(2)
    const stop = new AbortController()
    const blocked = jest.fn(async (_url: string, init?: RequestInit) => {
        const signal = init?.signal
        return new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('stopped'))))
    })
    const pending = readSourcePage(url, blocked, { ...turn, signal: stop.signal })
    stop.abort()
    await expect(pending).rejects.toThrow(/stopped/)
    await expect(readSourcePage('https://other.example/', page, { ...turn, question: 'https://other.example/' })).rejects.toThrow(
        /redirected/
    )
})

test('native source reads keep an apostrophe inside the caller-selected public URL', async () => {
    const url = "https://example.org/catalog/O'Brien"
    const response = {
        ok: true,
        status: 200,
        url,
        headers: { get: () => 'text/plain' },
        text: async () => 'The catalog is open.'
    }
    const page = jest.fn(async () => response)
    const released = await readSourcePage(url, page)
    for (const question of [`Read ${url}.`, `Read '${url}', please.`, `Read [the catalog](${url}).`]) {
        const turn = { question, assertCurrent: jest.fn() }
        expect(await readSourcePage(url, page, turn)).toBe(released)
        expect(page.mock.calls.at(-1)).toEqual([
            url,
            expect.objectContaining({ size: 2097152 }),
            5,
            { publicPageOrigin: 'https://example.org' }
        ])
        expect(turn.assertCurrent).toHaveBeenCalledTimes(2)
        const calls = page.mock.calls.length
        await expect(readSourcePage('https://example.org/catalog/other', page, turn)).rejects.toThrow(/exact public page URL/)
        expect(page).toHaveBeenCalledTimes(calls)
    }
})
