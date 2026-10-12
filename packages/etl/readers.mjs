import fs from 'node:fs'

const QUOTE = 0x22
const LF = 0x0a
const CR = 0x0d
const READ_BYTES = 1 << 20
// A raw row or line above this size is rejected as row_too_large instead of being buffered (E5).
export const MAX_RECORD_BYTES = 1 << 20

const fatalUtf8 = new TextDecoder('utf-8', { fatal: true })

export function hasBom(file) {
    const fd = fs.openSync(file, 'r')
    try {
        const buf = Buffer.alloc(3)
        const n = fs.readSync(fd, buf, 0, 3, 0)
        return n === 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
    } finally {
        fs.closeSync(fd)
    }
}

// Decodes UTF-8. Invalid bytes become U+FFFD; `invalid` says whether that happened (a real U+FFFD in the source is fine).
function decode(buf, start, end) {
    const text = buf.toString('utf8', start, end)
    if (!text.includes('\uFFFD')) return { text, invalid: false }
    try {
        fatalUtf8.decode(buf.subarray(start, end))
        return { text, invalid: false }
    } catch {
        return { text, invalid: true }
    }
}

// One CSV/TSV row from complete row bytes. A quote opens a quoted field only at the start of a field; a doubled quote
// inside it is a literal quote. A quote anywhere else, or text after a closing quote, is a parse_error for this row
// only. Returns { fields, quoted[], trailingEmpty, error }.
export function parseRow(buf, start, end, delim) {
    const fields = []
    const quoted = []
    let error = null
    let invalid = false
    let trailingEmpty = false
    let i = start
    const push = (from, to, isQuoted, escapes) => {
        const decoded = decode(buf, from, to)
        if (decoded.invalid) invalid = true
        fields.push(escapes ? decoded.text.replaceAll('""', '"') : decoded.text)
        quoted.push(isQuoted)
    }
    for (;;) {
        if (i === end) {
            fields.push('')
            quoted.push(false)
            trailingEmpty = fields.length > 1
            break
        }
        if (buf[i] === QUOTE) {
            let j = i + 1
            let escapes = false
            let closed = false
            while (j < end) {
                if (buf[j] === QUOTE) {
                    if (buf[j + 1] === QUOTE && j + 1 < end) {
                        escapes = true
                        j += 2
                        continue
                    }
                    closed = true
                    break
                }
                j += 1
            }
            if (!closed) {
                error = error || { code: 'parse_error', message: `field ${fields.length + 1} has an unterminated quote` }
                push(i + 1, end, true, escapes)
                break
            }
            push(i + 1, j, true, escapes)
            let k = j + 1
            if (k < end && buf[k] !== delim) {
                error = error || { code: 'parse_error', message: `field ${fields.length} has text after its closing quote` }
                while (k < end && buf[k] !== delim) k += 1
            }
            if (k >= end) break
            i = k + 1
            continue
        }
        let j = i
        while (j < end && buf[j] !== delim) {
            if (buf[j] === QUOTE && !error)
                error = { code: 'parse_error', message: `field ${fields.length + 1} has a quote inside an unquoted value` }
            j += 1
        }
        push(i, j, false, false)
        if (j >= end) break
        i = j + 1
    }
    if (!error && invalid) error = { code: 'encoding', message: 'the row is not valid UTF-8' }
    return { fields, quoted, trailingEmpty, error }
}

// Parses on bytes, not strings: quote, delimiter, CR and LF are ASCII and never occur inside a UTF-8 multi-byte
// sequence, so every yielded offset is an exact byte position a resumed run can seek to. Malformed rows come out as
// row results with `error` instead of throwing (E5):
// - a quote that never closes before end of file rejects that row only, cut at its first line break, and parsing
//   resyncs on the next line;
// - a row over maxRecordBytes is rejected as row_too_large. A quote still open at the cap is cut at the row's first line
//   break and parsing resumes on the next line; otherwise parsing resumes at the next line break after the cap.
// A UTF-8 BOM at offset 0 is skipped and reported on the first row (`bom: true`).
export async function* readDelimitedRows(
    file,
    { start = 0, delimiter = ',', highWaterMark = READ_BYTES, maxRecordBytes = MAX_RECORD_BYTES } = {}
) {
    const delim = delimiter.charCodeAt(0)
    let bom = false
    if (start === 0 && hasBom(file)) {
        bom = true
        start = 3
    }
    const state = { inQuotes: false, pendingQuote: false, fieldStart: true, skipping: false }
    const reset = () => {
        state.inQuotes = false
        state.pendingQuote = false
        state.fieldStart = true
    }
    const row = (buf, rowStart, end, base, next, extra = {}) => {
        const parsed = parseRow(buf, rowStart, end, delim)
        const out = { fields: parsed.fields, quoted: parsed.quoted, trailingEmpty: parsed.trailingEmpty, offset: base + rowStart, next }
        if (parsed.error) out.error = parsed.error
        if (bom) {
            out.bom = true
            bom = false
        }
        return { ...out, ...extra }
    }
    // Scans buf from `from`; yields complete rows. Returns the index where the unfinished row starts.
    function* scan(buf, from, rowStart, base) {
        for (let i = from; i < buf.length; i += 1) {
            const c = buf[i]
            if (state.skipping) {
                if (c === LF) {
                    yield {
                        fields: [],
                        quoted: [],
                        offset: state.skipStart,
                        next: base + i + 1,
                        error: { code: 'row_too_large', message: `the row is larger than ${maxRecordBytes} bytes` }
                    }
                    state.skipping = false
                    reset()
                    rowStart = i + 1
                }
                continue
            }
            if (i - rowStart > maxRecordBytes) {
                // A runaway quote (spec v1.3.4, row_too_large): an open quote that passes the cap is cut at the end of its
                // first physical line, that line is rejected, and reading resumes on the next line.
                const lf = state.inQuotes || state.pendingQuote ? buf.indexOf(LF, rowStart) : -1
                if (lf !== -1 && lf < i) {
                    yield {
                        fields: [],
                        quoted: [],
                        offset: base + rowStart,
                        next: base + lf + 1,
                        error: {
                            code: 'row_too_large',
                            message: `a quote opened in this row is still open after ${maxRecordBytes} bytes; the row is cut at its first line`
                        }
                    }
                    rowStart = lf + 1
                    i = lf
                    reset()
                    continue
                }
                state.skipping = true
                state.skipStart = base + rowStart
                if (c === LF) i -= 1
                continue
            }
            if (state.pendingQuote) {
                state.pendingQuote = false
                if (c === QUOTE) continue
                state.inQuotes = false
            }
            if (state.inQuotes) {
                if (c === QUOTE) state.pendingQuote = true
                continue
            }
            if (c === QUOTE) {
                if (state.fieldStart) state.inQuotes = true
                state.fieldStart = false
                continue
            }
            if (c === delim) {
                state.fieldStart = true
                continue
            }
            if (c === LF) {
                const end = i > rowStart && buf[i - 1] === CR ? i - 1 : i
                if (end > rowStart) {
                    const out = row(buf, rowStart, end, base, base + i + 1)
                    // A malformed row that spans lines most likely holds a runaway quote that a later quote closed.
                    // Reject its first line only and parse again from the next one.
                    const lf = out.error?.code === 'parse_error' ? buf.indexOf(LF, rowStart) : -1
                    if (lf !== -1 && lf < i) {
                        const lineEnd = lf > rowStart && buf[lf - 1] === CR ? lf - 1 : lf
                        yield row(buf, rowStart, lineEnd, base, base + lf + 1, {
                            error: { code: 'parse_error', message: 'a quote opened in this row is never closed on its line' }
                        })
                        rowStart = lf + 1
                        i = lf
                        reset()
                        continue
                    }
                    yield out
                }
                rowStart = i + 1
                reset()
                continue
            }
            state.fieldStart = false
        }
        return rowStart
    }
    let carry = null
    let base = start
    let scanFrom = 0
    for await (const chunk of fs.createReadStream(file, { start, highWaterMark })) {
        const buf = carry ? Buffer.concat([carry, chunk]) : chunk
        const gen = scan(buf, scanFrom, 0, base)
        let step = gen.next()
        while (!step.done) {
            yield step.value
            step = gen.next()
        }
        const rowStart = step.value
        if (state.skipping) {
            carry = null
            scanFrom = 0
            base += buf.length
            continue
        }
        carry = rowStart < buf.length ? Buffer.from(buf.subarray(rowStart)) : null
        scanFrom = carry ? carry.length : 0
        base += rowStart
    }
    if (state.skipping) {
        yield {
            fields: [],
            quoted: [],
            offset: state.skipStart,
            next: base,
            error: { code: 'row_too_large', message: `the row is larger than ${maxRecordBytes} bytes` }
        }
        return
    }
    // End of file. A quote still open means a runaway quote: reject up to its first line break and parse the rest again.
    let rest = carry
    while (rest && rest.length) {
        if (state.inQuotes && !state.pendingQuote) {
            const lf = rest.indexOf(LF)
            const cut = lf === -1 ? rest.length : lf
            const end = cut > 0 && rest[cut - 1] === CR ? cut - 1 : cut
            yield row(rest, 0, end, base, base + (lf === -1 ? rest.length : lf + 1), {
                error: { code: 'parse_error', message: 'a quote opened in this row is never closed' }
            })
            if (lf === -1) return
            reset()
            const remaining = Buffer.from(rest.subarray(lf + 1))
            base += lf + 1
            const gen = scan(remaining, 0, 0, base)
            let step = gen.next()
            while (!step.done) {
                yield step.value
                step = gen.next()
            }
            rest = step.value < remaining.length ? Buffer.from(remaining.subarray(step.value)) : null
            base += step.value
            continue
        }
        const end = rest[rest.length - 1] === CR ? rest.length - 1 : rest.length
        if (end > 0) yield row(rest, 0, end, base, base + rest.length)
        return
    }
}

// The header row: BOM stripped, names trimmed. `duplicates` lists names that appear more than once.
export async function readHeader(file, delimiter = ',') {
    for await (const row of readDelimitedRows(file, { start: 0, delimiter, highWaterMark: 64 * 1024 })) {
        const fields = row.fields.map((field) => field.trim())
        const seen = new Set()
        const duplicates = []
        for (const name of fields) {
            if (seen.has(name) && !duplicates.includes(name)) duplicates.push(name)
            seen.add(name)
        }
        return { fields, next: row.next, bom: Boolean(row.bom), duplicates, error: row.error || null }
    }
    return { fields: [], next: 0, bom: false, duplicates: [], error: null }
}

// Lines of a JSONL file. Blank lines are yielded too (`blank: true`) so they can be counted. A line over maxRecordBytes
// is rejected as row_too_large and the reader resumes after its line break.
export async function* readLines(file, { start = 0, highWaterMark = READ_BYTES, maxRecordBytes = MAX_RECORD_BYTES } = {}) {
    let bom = false
    if (start === 0 && hasBom(file)) {
        bom = true
        start = 3
    }
    const mark = (out) => {
        if (bom) {
            out.bom = true
            bom = false
        }
        return out
    }
    const line = (buf, lineStart, end, offset, next) => {
        const decoded = decode(buf, lineStart, end)
        const out = { text: decoded.text, offset, next }
        if (!decoded.text.trim()) out.blank = true
        if (decoded.invalid) out.error = { code: 'encoding', message: 'the line is not valid UTF-8' }
        return mark(out)
    }
    let carry = null
    let base = start
    let skipStart = null
    for await (const chunk of fs.createReadStream(file, { start, highWaterMark })) {
        const buf = carry ? Buffer.concat([carry, chunk]) : chunk
        let lineStart = 0
        let i = buf.indexOf(LF, lineStart)
        while (i !== -1) {
            if (skipStart !== null) {
                yield mark({
                    text: '',
                    offset: skipStart,
                    next: base + i + 1,
                    error: { code: 'row_too_large', message: `the line is larger than ${maxRecordBytes} bytes` }
                })
                skipStart = null
            } else if (i - lineStart > maxRecordBytes) {
                yield mark({
                    text: '',
                    offset: base + lineStart,
                    next: base + i + 1,
                    error: { code: 'row_too_large', message: `the line is larger than ${maxRecordBytes} bytes` }
                })
            } else {
                const end = i > lineStart && buf[i - 1] === CR ? i - 1 : i
                yield line(buf, lineStart, end, base + lineStart, base + i + 1)
            }
            lineStart = i + 1
            i = buf.indexOf(LF, lineStart)
        }
        if (skipStart === null && buf.length - lineStart > maxRecordBytes) skipStart = base + lineStart
        if (skipStart !== null) {
            carry = null
            base += buf.length
            continue
        }
        carry = lineStart < buf.length ? Buffer.from(buf.subarray(lineStart)) : null
        base += lineStart
    }
    if (skipStart !== null) {
        yield mark({
            text: '',
            offset: skipStart,
            next: base,
            error: { code: 'row_too_large', message: `the line is larger than ${maxRecordBytes} bytes` }
        })
        return
    }
    if (carry && carry.length) {
        const end = carry[carry.length - 1] === CR ? carry.length - 1 : carry.length
        yield line(carry, 0, end, base, base + carry.length)
    }
}

const PARAGRAPH = Buffer.from('\n\n')

// Cuts a text file into segments of about segmentBytes at a paragraph or line break, never inside a UTF-8 character.
// A BOM at offset 0 is skipped and reported on the first segment.
export async function* readSegments(file, { start = 0, segmentBytes = 256 * 1024, highWaterMark = READ_BYTES } = {}) {
    let bom = false
    if (start === 0 && hasBom(file)) {
        bom = true
        start = 3
    }
    let parts = []
    let size = 0
    let base = start
    const emit = function* (buf, final) {
        let pos = 0
        while (buf.length - pos >= segmentBytes || (final && pos < buf.length)) {
            let cut = buf.length
            if (buf.length - pos > segmentBytes) {
                const limit = pos + segmentBytes
                cut = buf.lastIndexOf(PARAGRAPH, limit)
                if (cut <= pos + segmentBytes / 2) cut = buf.lastIndexOf(LF, limit)
                if (cut <= pos + segmentBytes / 2) {
                    cut = limit
                    while (cut > pos && (buf[cut] & 0xc0) === 0x80) cut -= 1
                } else cut += 1
            }
            const out = { text: buf.toString('utf8', pos, cut), offset: base + pos, next: base + cut }
            if (bom) {
                out.bom = true
                bom = false
            }
            yield out
            pos = cut
        }
        return pos
    }
    for await (const chunk of fs.createReadStream(file, { start, highWaterMark })) {
        parts.push(chunk)
        size += chunk.length
        if (size < segmentBytes * 2) continue
        const buf = Buffer.concat(parts)
        const gen = emit(buf, false)
        let step = gen.next()
        while (!step.done) {
            yield step.value
            step = gen.next()
        }
        const used = step.value
        parts = used < buf.length ? [Buffer.from(buf.subarray(used))] : []
        size = buf.length - used
        base += used
    }
    if (size > 0) yield* emit(Buffer.concat(parts), true)
}
