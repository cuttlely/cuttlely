import { protectedInterpretationEvidence } from './protected-interpretation.mjs'

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

function label(path) {
    return path
        .split('.')
        .filter((part) => part !== 'rows' && !/_payload$/i.test(part))
        .map((part) => (/^\d+$/.test(part) ? `Record ${Number(part) + 1}` : part.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')))
        .join(' / ')
}

// Emergency delivery only: no generated conclusion survives a failed literal
// check. Fields come directly from bounded server captures, not model JSON.
export function sourceAnswerFallback(captured) {
    const rows = []
    let bounded = false
    for (let source = 0; source < captured.length; source++) {
        const body = captured[source]?.result
        const view = protectedInterpretationEvidence(body, ['rows'])
        bounded ||= !view.evidenceCoverage.complete
        for (const field of view.sourceEvidence) {
            if (privatePath.test(field.path)) continue
            if (rows.length >= 100) {
                bounded = true
                break
            }
            const value = field.value === null ? 'Unavailable (NULL)' : String(field.value)
            // Large records remain in the trace; do not show a clipped number as an exact amount.
            const shown = value.length > 1500 ? 'Long source value omitted from this bounded display.' : value
            rows.push(`| ${captured.length > 1 ? `Source ${source + 1} / ` : ''}${escapeCell(label(field.path))} | ${escapeCell(shown)} |`)
        }
    }
    const introduction = 'The additional interpretation could not be verified. The source-backed values are shown below.'
    if (!rows.length) {
        const empty = captured.length && captured.every((item) => Array.isArray(item.result?.rows) && item.result.rows.length === 0)
        return `${introduction}\n\n${empty ? 'The executed query returned no rows.' : 'No displayable source values were returned.'}`
    }
    return `${introduction}\n\n| Source field | Returned value |\n|---|---|\n${rows.join('\n')}\n\n${
        bounded
            ? 'This is a bounded display of returned source fields; it is not a complete population claim.'
            : 'Fields retain their returned values; source coverage remains as reported.'
    }`
}
