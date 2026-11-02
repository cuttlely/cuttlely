import { load } from 'cheerio'
import { getText, parseInputs } from '@langchain/classic/tools/webbrowser'
import type { RequestInit } from 'node-fetch'

const SOURCE_MARKER = '\n\n----FLOWISE_SOURCE_DOCUMENTS----\n\n'
type SourceResponse = {
    ok: boolean
    status: number
    url: string
    headers: { get: (name: string) => string | null }
    text: () => Promise<string>
}
type SourceFetch = (url: string, init?: RequestInit) => Promise<SourceResponse>

// This mode returns fetched text rather than a second model's account of the page.
export async function readSourcePage(input: string, fetchPage: SourceFetch): Promise<string> {
    const [target] = parseInputs(input)
    const requested = new URL(target)
    if (requested.href.length > 4096 || !['http:', 'https:'].includes(requested.protocol) || requested.username || requested.password)
        throw new Error('A public HTTP(S) page URL without embedded credentials is required.')
    // node-fetch 2's signal declaration predates Node's current AbortSignal fields.
    const signal = AbortSignal.timeout(20000) as unknown as RequestInit['signal']
    const response = await fetchPage(requested.href, { size: 2097152, signal })
    if (!response.ok) throw new Error(`Source page returned HTTP ${response.status}.`)
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (!['text/html', 'application/xhtml+xml', 'text/plain', 'application/json', 'application/xml'].includes(type))
        throw new Error('Source page is not a supported text document.')
    const url = new URL(response.url || requested.href)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid source page destination.')
    const body = await response.text()
    if (Buffer.byteLength(body) > 2097152) throw new Error('Source page exceeds the text limit.')
    let text = body
    let title = ''
    if (type.includes('html')) {
        const $ = load(body)
        title = $('title').first().text().slice(0, 512)
        $('script,style,svg,nav,header,footer').remove()
        const main = $('main').first()
        text = getText(main.length ? `<body>${main.html()}</body>` : $.html(), url.href, true)
    }
    if (!text.trim()) throw new Error('Source page contains no readable text.')
    let excerpt = text.slice(0, 24000)
    while (Buffer.byteLength(JSON.stringify({ result: excerpt })) > 44000) excerpt = excerpt.slice(0, -512)
    const documents = []
    for (let start = 0; start < excerpt.length; start += 12000)
        documents.push({ pageContent: excerpt.slice(start, start + 12000), metadata: { source: url.href, title } })
    const shown = excerpt.split(SOURCE_MARKER).join('\n\n[page content separator]\n\n')
    return `Fetched source page: ${url.href}\n${
        excerpt.length < text.length ? 'Excerpt only; later page content is not shown.\n' : ''
    }${shown}${SOURCE_MARKER}${JSON.stringify(documents)}`
}
