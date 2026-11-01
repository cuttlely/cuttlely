import { protectedReportingCaption } from './protected-interpretation.mjs'
import { sourceRecordTables } from './answer-context.mjs'

const privatePath =
    /(?:^|\.)(?:_cuttlely[^.]*|[^.]*(?:password|api_?key|credential|secret|token|authorization)[^.]*|connection_?string|testedStamp|sql|queryEvidence)(?:\.|$)/i
const markdownCharacters = new Set([92, 96, 42, 95, 91, 93, 123, 125, 40, 41, 33, 35, 126])
const escapeCell = (value) =>
    [...String(value)]
        .map((char) => {
            if (char === '&') return '&amp;'
            if (char === '<') return '&lt;'
            if (char === '>') return '&gt;'
            if (char === '|') return '&#124;'
            if (char === '\r' || char === '\0') return ''
            if (char === '\n') return '<br>'
            return markdownCharacters.has(char.charCodeAt(0)) ? `&#${char.charCodeAt(0)};` : char
        })
        .join('')

// The fallback is a bounded table of returned business records. Nested resolver
// packets, source metadata and arbitrary internal paths are never field-dumped.
export function sourceAnswerFallback(captured, reportingCurrencySymbol, { interpretationFailed = true } = {}) {
    const tables = captured.flatMap((item) => sourceRecordTables(item.result, { maxRows: 10000 }))
    const rendered = []
    let remaining = 100
    let remainingBytes = 128000
    let bounded = false
    for (const rows of tables) {
        if (!remaining) {
            bounded = true
            break
        }
        const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((key) => !privatePath.test(key))
        if (!keys.length) continue
        const columns = keys.slice(0, 12)
        bounded ||= rows.length > remaining || keys.length > columns.length
        const shown = rows.slice(0, remaining)
        remaining -= shown.length
        const cell = (value) =>
            escapeCell(
                value === null
                    ? 'Unavailable (NULL)'
                    : value === undefined
                    ? 'Unavailable'
                    : String(value).length > 1500
                    ? 'Long source value omitted.'
                    : value
            )
        const lines = [
            '| ' + columns.map((key) => escapeCell(key.replace(/_/g, ' '))).join(' | ') + ' |',
            '|' + columns.map(() => '---').join('|') + '|'
        ]
        remainingBytes -= Buffer.byteLength(lines.join('\n'))
        for (const row of shown) {
            const line = '| ' + columns.map((key) => cell(row[key])).join(' | ') + ' |'
            if (Buffer.byteLength(line) > remainingBytes) {
                bounded = true
                remaining = 0
                break
            }
            lines.push(line)
            remainingBytes -= Buffer.byteLength(line) + 1
        }
        rendered.push(lines.join('\n'))
    }
    const caption = protectedReportingCaption(
        captured.map((item) => item.result),
        ['rows'],
        reportingCurrencySymbol
    )
    const introduction =
        (interpretationFailed ? 'I could not verify the additional analysis. The source-backed values follow.' : '') +
        (caption ? `\n\n${caption}` : '')
    if (!rendered.length) {
        const empty = captured.length && captured.every((item) => Array.isArray(item.result?.rows) && item.result.rows.length === 0)
        return `${introduction}\n\n${
            empty
                ? 'The executed query returned no rows.'
                : 'The returned source packet could not be presented as a reliable business table.'
        }`
    }
    return `${introduction}\n\n${rendered.join('\n\n')}${bounded ? '\n\nThis is a bounded display of returned records.' : ''}`
}
