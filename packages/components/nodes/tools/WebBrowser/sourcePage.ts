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
type SourceFetch = (
    url: string,
    init?: RequestInit,
    maxRedirects?: number,
    policy?: { publicPageOrigin: string }
) => Promise<SourceResponse>

export interface NativeSourceTurn {
    question: string
    signal?: AbortSignal
    assertCurrent: () => void
}

function requestedPage(question: string, requested: URL): URL | undefined {
    if (requested.port) return
    for (const match of question.matchAll(/\bhttps?:\/\/[^\s<>"`]+/gi)) {
        // Apostrophes may be part of a path (such as a merchant name). Only a surrounding
        // single-quoted URL has a quote delimiter to remove after its last path character.
        const candidate = question[(match.index ?? 0) - 1] === "'" ? match[0].replace(/'[.,;:!?)\]}]*$/, '') : match[0]
        // Try both verbatim and sentence/Markdown-delimited URLs. Preserve an
        // explicitly written trailing slash even though the legacy tool parser strips it.
        for (const text of [candidate, candidate.replace(/[.,;:!?)\]}]+$/, '')]) {
            try {
                const url = new URL(text)
                if (!url.username && !url.password && (url.href === requested.href || url.href === requested.href + '/')) return url
            } catch {
                // Other literal URLs in the same question can still match.
            }
        }
    }
}

// This mode returns fetched text rather than a second model's account of the page.
export async function readSourcePage(input: string, fetchPage: SourceFetch, turn?: NativeSourceTurn): Promise<string> {
    const [target] = parseInputs(input)
    let requested = new URL(target)
    if (requested.href.length > 4096 || !['http:', 'https:'].includes(requested.protocol) || requested.username || requested.password)
        throw new Error('A public HTTP(S) page URL without embedded credentials is required.')
    // node-fetch 2's signal declaration predates Node's current AbortSignal fields.
    const timeout = AbortSignal.timeout(20000)
    const signal = (turn?.signal ? AbortSignal.any([turn.signal, timeout]) : timeout) as unknown as RequestInit['signal']
    const options = { size: 2097152, signal }
    if (turn) {
        const supplied = requestedPage(turn.question, requested)
        if (!supplied) throw new Error('Ask the user to include the exact public page URL in this message.')
        requested = supplied
    }
    turn?.assertCurrent()
    const response = turn
        ? await fetchPage(requested.href, options, 5, { publicPageOrigin: requested.origin })
        : await fetchPage(requested.href, options)
    if (!response.ok) throw new Error(`Source page returned HTTP ${response.status}.`)
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (!['text/html', 'application/xhtml+xml', 'text/plain', 'application/json', 'application/xml'].includes(type))
        throw new Error('Source page is not a supported text document.')
    const url = new URL(response.url || requested.href)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid source page destination.')
    if (turn && url.origin !== requested.origin) throw new Error('The source page redirected outside the requested public site.')
    const body = await response.text()
    turn?.signal?.throwIfAborted()
    turn?.assertCurrent()
    if (Buffer.byteLength(body) > 2097152) throw new Error('Source page exceeds the text limit.')
    let text = body
    let title = ''
    if (type.includes('html')) {
        const $ = load(body)
        title = $('title').first().text().slice(0, 512)
        $('script,style,svg,nav,header,footer').remove()
        const main = $('main').first()
        text = getText(main.length ? `<body>${$.html(main)}</body>` : $.html(), url.href, true)
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
