// Source receipts are scoped to one framework-issued specialist turn. Model text and
// streamed tool previews cannot create a receipt.
import { fromMarkdown } from 'mdast-util-from-markdown'

const active = new Map()
const MAX_SOURCES = 32
const MAX_BYTES = 262144
const keyOf = ({ harness, specialist, sourceTurn }) => JSON.stringify([harness, specialist, sourceTurn])

export function beginRetrievedSources(scope) {
    const key = keyOf(scope)
    active.set(key, { sources: [], bytes: 0, calls: new Set() })
}

function sourceUrl(value) {
    if (typeof value !== 'string' || value.length > 4096) return ''
    try {
        const url = new URL(value)
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
    } catch {
        return ''
    }
}

export function recordRetrievedSources(scope, { callId, documents } = {}) {
    if (!scope.harness || !scope.specialist || !scope.sourceTurn || !callId || !Array.isArray(documents)) return
    const capture = active.get(keyOf(scope))
    if (!capture || capture.calls.size >= 128 || capture.calls.has(callId)) return
    capture.calls.add(callId)
    for (const doc of documents) {
        if (capture.sources.length >= MAX_SOURCES) break
        const source = sourceUrl(doc?.metadata?.source) || sourceUrl(doc?.metadata?.url)
        if (!source || typeof doc.pageContent !== 'string' || !doc.pageContent.trim()) continue
        const item = {
            pageContent: doc.pageContent.slice(0, 12000),
            metadata: { source, ...(typeof doc.metadata.title === 'string' ? { title: doc.metadata.title.slice(0, 512) } : {}) }
        }
        const bytes = Buffer.byteLength(JSON.stringify(item))
        if (capture.bytes + bytes > MAX_BYTES) break
        capture.sources.push(item)
        capture.bytes += bytes
    }
}

export function takeRetrievedSources(scope) {
    const key = keyOf(scope)
    const capture = active.get(key)
    active.delete(key)
    return capture?.sources || []
}

export function endRetrievedSources(scope) {
    active.delete(keyOf(scope))
}

// This is a separate documentation section, not a verified financial result or a
// replacement for protected facts. Only retrieval-only roles with cited receipts
// may accompany a protected report; analyst and executable roles remain excluded.
export function retrievalOnlySpecialist(specialist) {
    return (
        !specialist.mcpServers?.length &&
        !specialist.trustedOutputs?.length &&
        !specialist.codeExecution &&
        !specialist.shell &&
        !specialist.fileAccess &&
        Boolean(specialist.modules?.some((binding) => ['retrieverTool', 'webBrowser'].includes(binding.nodeName)))
    )
}

// A repair chooses captured source identities; the runtime owns their destinations.
// Valid legacy Markdown still goes through the same citation check below.
export function renderRetrievedSourceReferences(reply, sources) {
    if (typeof reply !== 'string' || Buffer.byteLength(reply) > 65536) return null
    let text = reply.trim()
    const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*)\n```$/)
    if (fenced) text = fenced[1].trim()
    if (text.startsWith('{')) {
        try {
            const value = JSON.parse(text)
            if (!value || Object.keys(value).length !== 1 || typeof value.answer !== 'string') return null
            text = value.answer
        } catch {
            return null
        }
    }
    let invalid = false
    let bytes = Buffer.byteLength(text)
    text = text.replace(/\{\{source:([^}]+)\}\}/g, (_token, id) => {
        if (invalid) return ''
        const match = /^S([1-9]\d*)$/.exec(id)
        const index = match ? Number(match[1]) - 1 : -1
        const url = index >= 0 && index < MAX_SOURCES ? sourceUrl(sources?.[index]?.url) : ''
        if (!url) {
            invalid = true
            return ''
        }
        const reference = `[Source ${index + 1}](<${url}>)`
        bytes += Buffer.byteLength(reference) - Buffer.byteLength(_token)
        if (bytes > 65536) {
            invalid = true
            return ''
        }
        return reference
    })
    return !invalid && !text.includes('{{source:') && text.trim() ? text : null
}

export function citedRetrievedGuidance(specialist, text, sources) {
    if (!retrievalOnlySpecialist(specialist) || typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 65536) return null
    const urls = new Set((sources || []).map((doc) => sourceUrl(doc?.metadata?.source)).filter(Boolean))
    if (!urls.size) return null
    let cited = false
    const pending = [fromMarkdown(text)]
    while (pending.length) {
        const node = pending.pop()
        if (node.type === 'link' || node.type === 'definition' || node.type === 'image') {
            const url = sourceUrl(node.url)
            if (!url || !urls.has(url)) return null
            cited = true
        }
        if (node.type === 'text') {
            for (const match of node.value.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
                let candidate = match[0],
                    known = false
                // Prose punctuation can follow a bare URL. Try the complete URL
                // first, then at most four trailing punctuation characters.
                for (let count = 0; count <= 4; count++) {
                    if (urls.has(sourceUrl(candidate))) {
                        known = true
                        break
                    }
                    if (!/[.,;!?)\]]$/.test(candidate)) break
                    candidate = candidate.slice(0, -1)
                }
                if (!known) return null
                cited = true
            }
        }
        if (node.children) pending.push(...node.children)
    }
    return cited ? { text } : null
}
