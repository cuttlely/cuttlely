// Code-point-safe cuts and Unicode well-formedness (E17). Every place that shortens a string for storage or display
// uses these, so a cut never leaves half of a surrogate pair behind. Grapheme clusters (ZWJ emoji, combining marks)
// can still be split at a code-point boundary; that is acceptable for diagnostic text.

function isHigh(code) {
    return code >= 0xd800 && code <= 0xdbff
}

function isLow(code) {
    return code >= 0xdc00 && code <= 0xdfff
}

// Cuts to at most maxUnits UTF-16 code units, backing off one unit when the cut would leave a lone high surrogate.
export function truncateCodePoints(text, maxUnits) {
    const s = String(text ?? '')
    if (s.length <= maxUnits) return s
    let end = Math.max(0, maxUnits)
    if (end > 0 && isHigh(s.charCodeAt(end - 1))) end -= 1
    return s.slice(0, end)
}

// As truncateCodePoints, with a suffix (an ellipsis by default) when the text was cut. The suffix counts toward the cap.
export function clipText(text, maxUnits, suffix = '…') {
    const s = String(text ?? '')
    if (s.length <= maxUnits) return s
    return `${truncateCodePoints(s, Math.max(0, maxUnits - suffix.length))}${suffix}`
}

// Cuts to at most maxBytes of UTF-8 on a character boundary.
export function truncateUtf8(text, maxBytes) {
    const s = String(text ?? '')
    const buf = Buffer.from(s, 'utf8')
    if (buf.length <= maxBytes) return s
    let end = Math.max(0, maxBytes)
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1
    return buf.toString('utf8', 0, end)
}

export function isWellFormed(text) {
    return String(text).isWellFormed()
}

// Replaces lone surrogates with U+FFFD and returns { text, replaced }.
export function repairUnicode(text) {
    const s = String(text)
    if (s.isWellFormed()) return { text: s, replaced: 0 }
    let replaced = 0
    for (let i = 0; i < s.length; i += 1) {
        const code = s.charCodeAt(i)
        if (isHigh(code) && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) i += 1
        else if (isHigh(code) || isLow(code)) replaced += 1
    }
    return { text: s.toWellFormed(), replaced }
}

// Splitter boundary repair: when a chunk ends with a high surrogate and the next starts with its low half, the high
// half moves to the next chunk. Text is preserved and no U+FFFD is introduced for a pair intact in the source. With
// chunk overlap the whole character can sit in the neighbour already; then the stray half at the edge is dropped.
export function repairChunkBoundaries(chunks) {
    const out = [...chunks]
    for (let i = 0; i + 1 < out.length; i += 1) {
        const a = out[i]
        const b = out[i + 1]
        if (typeof a !== 'string' || typeof b !== 'string' || !a.length || !b.length) continue
        const aEnd = a.charCodeAt(a.length - 1)
        const aLone = isHigh(aEnd)
        if (aLone && isLow(b.charCodeAt(0))) {
            out[i] = a.slice(0, -1)
            out[i + 1] = a.slice(-1) + b
        } else if (aLone && b.charCodeAt(0) === aEnd && isLow(b.charCodeAt(1))) {
            out[i] = a.slice(0, -1)
        } else if (
            isLow(b.charCodeAt(0)) &&
            a.length > 1 &&
            isHigh(a.charCodeAt(a.length - 2)) &&
            a.charCodeAt(a.length - 1) === b.charCodeAt(0)
        ) {
            out[i + 1] = b.slice(1)
        }
    }
    return out.filter((chunk) => typeof chunk !== 'string' || chunk.length > 0)
}
