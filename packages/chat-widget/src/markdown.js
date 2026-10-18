// Markdown to HTML for model output. Written for this widget from the CommonMark and GFM descriptions of the syntax.
// Every piece of text goes through escapeHtml, and the only tags in the result are the ones this file writes.
// Raw HTML in the model output is shown as text. Links and images keep only safe URL schemes.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch])
}

/** `value` without trailing slashes. A scan from the end, so a long run of slashes stays linear. */
export function trimTrailingSlashes(value) {
    const text = String(value ?? '')
    let end = text.length
    while (end > 0 && text.charCodeAt(end - 1) === 47) end -= 1
    return text.slice(0, end)
}

const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i

/**
 * Returns a URL that is safe to put in href or src, or null.
 * Allowed: http, https, mailto (links only), a path on the Cuttlely server, and base64 png, jpeg, gif or webp images.
 */
export function safeUrl(raw, { image = false, base = '' } = {}) {
    if (typeof raw !== 'string') return null
    const url = raw.trim()
    if (!url || url.length > 4096) return null
    // Control characters and spaces are how scheme filters get bypassed ("java\tscript:"). Refuse them outright.
    if (/[\u0000-\u001f\u007f\s]/.test(url) && !(image && SAFE_DATA_IMAGE.test(url))) return null
    if (image && /^data:/i.test(url)) return SAFE_DATA_IMAGE.test(url) ? url.replace(/\s+/g, '') : null
    if (/^https?:\/\//i.test(url)) return url
    if (!image && /^mailto:[^/]/i.test(url)) return url
    if (url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\')) return base ? trimTrailingSlashes(base) + url : url
    return null
}

// ---------------------------------------------------------------- inline

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/

function findClosingBracket(text, start) {
    let depth = 0
    for (let i = start; i < text.length; i++) {
        const ch = text[i]
        if (ch === '\\') {
            i++
            continue
        }
        if (ch === '[') depth++
        else if (ch === ']') {
            depth--
            if (depth === 0) return i
        }
    }
    return -1
}

// Reads "(url "title")" starting at the "(" and returns { url, end } or null.
function readLinkTarget(text, start) {
    if (text[start] !== '(') return null
    let i = start + 1
    while (text[i] === ' ') i++
    let url = ''
    if (text[i] === '<') {
        const close = text.indexOf('>', i)
        if (close === -1) return null
        url = text.slice(i + 1, close)
        i = close + 1
    } else {
        let depth = 0
        const begin = i
        for (; i < text.length; i++) {
            const ch = text[i]
            if (ch === '\\') {
                i++
                continue
            }
            if (ch === '(') depth++
            else if (ch === ')') {
                if (depth === 0) break
                depth--
            } else if (ch === ' ') break
        }
        url = text.slice(begin, i)
    }
    while (text[i] === ' ') i++
    if (text[i] === '"' || text[i] === "'") {
        const quote = text[i]
        const close = text.indexOf(quote, i + 1)
        if (close === -1) return null
        i = close + 1
        while (text[i] === ' ') i++
    }
    if (text[i] !== ')') return null
    return { url, end: i + 1 }
}

const BARE_URL = /^https?:\/\/[^\s<>"'`]+/i

function trimUrlTail(url) {
    // A sentence often ends right after a URL: drop trailing punctuation and an unbalanced ")".
    let out = url.replace(/[.,;:!?*_~]+$/, '')
    while (out.endsWith(')') && (out.match(/\(/g) || []).length < (out.match(/\)/g) || []).length) out = out.slice(0, -1)
    return out
}

function emphasis(text, i, ctx) {
    const pairs = [
        ['**', 'strong'],
        ['__', 'strong'],
        ['~~', 'del'],
        ['*', 'em'],
        ['_', 'em']
    ]
    for (const [mark, tag] of pairs) {
        if (!text.startsWith(mark, i)) continue
        const after = text[i + mark.length]
        if (!after || /\s/.test(after)) continue
        // Underscores inside words (snake_case) are not emphasis.
        if (mark[0] === '_' && i > 0 && /[a-z0-9]/i.test(text[i - 1])) continue
        let close = text.indexOf(mark, i + mark.length + 1)
        while (close !== -1) {
            const before = text[close - 1]
            const next = text[close + mark.length]
            const wordy = mark[0] === '_' && next && /[a-z0-9]/i.test(next)
            const doubled = mark.length === 1 && next === mark
            if (before && !/\s/.test(before) && !wordy && !doubled) break
            close = text.indexOf(mark, close + 1)
        }
        if (close === -1) continue
        const inner = text.slice(i + mark.length, close)
        return { html: `<${tag}>${inline(inner, ctx)}</${tag}>`, end: close + mark.length }
    }
    return null
}

export function inline(text, ctx = {}) {
    let out = ''
    let plain = ''
    const flush = () => {
        if (plain) out += escapeHtml(plain).replace(/\n/g, '<br>')
        plain = ''
    }
    for (let i = 0; i < text.length; ) {
        const ch = text[i]
        if (ch === '\\' && PUNCT.test(text[i + 1] || '')) {
            plain += text[i + 1]
            i += 2
            continue
        }
        if (ch === '`') {
            let run = 1
            while (text[i + run] === '`') run++
            const fence = '`'.repeat(run)
            const close = text.indexOf(fence, i + run)
            if (close !== -1) {
                flush()
                let code = text.slice(i + run, close).replace(/\n/g, ' ')
                if (/^ .* $/.test(code)) code = code.slice(1, -1)
                out += `<code>${escapeHtml(code)}</code>`
                i = close + run
                continue
            }
            plain += fence
            i += run
            continue
        }
        if ((ch === '!' && text[i + 1] === '[') || ch === '[') {
            const isImage = ch === '!'
            const open = isImage ? i + 1 : i
            const close = findClosingBracket(text, open)
            const target = close !== -1 ? readLinkTarget(text, close + 1) : null
            if (target) {
                const label = text.slice(open + 1, close)
                const url = safeUrl(target.url, { image: isImage, base: ctx.base })
                flush()
                if (isImage) {
                    out += url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(label)}" loading="lazy">` : escapeHtml(label)
                } else if (url && !ctx.inLink) {
                    out += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${inline(label, {
                        ...ctx,
                        inLink: true
                    })}</a>`
                } else {
                    out += inline(label, ctx)
                }
                i = target.end
                continue
            }
        }
        if (ch === '<') {
            const auto = /^<(https?:\/\/[^\s<>]+|mailto:[^\s<>]+)>/i.exec(text.slice(i))
            if (auto) {
                const url = safeUrl(auto[1])
                if (url && !ctx.inLink) {
                    flush()
                    out += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(auto[1])}</a>`
                    i += auto[0].length
                    continue
                }
            }
        }
        if ((ch === 'h' || ch === 'H') && !ctx.inLink && (i === 0 || /[\s(]/.test(text[i - 1]))) {
            const bare = BARE_URL.exec(text.slice(i))
            if (bare) {
                const url = trimUrlTail(bare[0])
                flush()
                out += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(url)}</a>`
                i += url.length
                continue
            }
        }
        if (ch === '*' || ch === '_' || ch === '~') {
            const em = emphasis(text, i, ctx)
            if (em) {
                flush()
                out += em.html
                i = em.end
                continue
            }
        }
        plain += ch
        i++
    }
    flush()
    return out
}

// ---------------------------------------------------------------- blocks

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^ {0,3}> ?(.*)$/
const LIST_ITEM = /^( {0,12})([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function splitRow(line) {
    let row = line.trim()
    if (row.startsWith('|')) row = row.slice(1)
    if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
    const cells = []
    let cell = ''
    for (let i = 0; i < row.length; i++) {
        if (row[i] === '\\' && row[i + 1] === '|') {
            cell += '|'
            i++
        } else if (row[i] === '|') {
            cells.push(cell.trim())
            cell = ''
        } else cell += row[i]
    }
    cells.push(cell.trim())
    return cells
}

function isBlockStart(line, next) {
    return (
        FENCE.test(line) ||
        HEADING.test(line) ||
        RULE.test(line) ||
        QUOTE.test(line) ||
        LIST_ITEM.test(line) ||
        (line.includes('|') && next !== undefined && TABLE_DIVIDER.test(next) && next.includes('-'))
    )
}

function codeBlock(lang, code) {
    const label = lang ? escapeHtml(lang.slice(0, 24)) : 'code'
    return (
        `<div class="md-code"><div class="md-code-head"><span>${label}</span>` +
        `<button type="button" class="md-copy" data-copy-code aria-label="Copy code">Copy</button></div>` +
        `<pre><code>${escapeHtml(code)}</code></pre></div>`
    )
}

function table(lines, ctx) {
    const head = splitRow(lines[0])
    const aligns = splitRow(lines[1]).map((cell) => {
        const left = cell.startsWith(':')
        const right = cell.endsWith(':')
        return left && right ? 'center' : right ? 'right' : left ? 'left' : ''
    })
    const cellHtml = (tag, value, index) => {
        const align = aligns[index] ? ` style="text-align:${aligns[index]}"` : ''
        return `<${tag}${align}>${inline(value, ctx)}</${tag}>`
    }
    let html = '<div class="md-table"><table><thead><tr>'
    html += head.map((cell, index) => cellHtml('th', cell, index)).join('')
    html += '</tr></thead><tbody>'
    for (const line of lines.slice(2)) {
        const cells = splitRow(line)
        html += '<tr>' + head.map((_, index) => cellHtml('td', cells[index] ?? '', index)).join('') + '</tr>'
    }
    return html + '</tbody></table></div>'
}

function list(lines, start, ctx) {
    const first = LIST_ITEM.exec(lines[start])
    const ordered = /\d/.test(first[2])
    const baseIndent = first[1].length
    const items = []
    let i = start
    let loose = false
    while (i < lines.length) {
        const match = LIST_ITEM.exec(lines[i])
        if (!match || match[1].length !== baseIndent || /\d/.test(match[2]) !== ordered) break
        const contentIndent = baseIndent + match[2].length + 1
        const body = [match[3] ?? '']
        i++
        let blankSeen = false
        while (i < lines.length) {
            const line = lines[i]
            if (!line.trim()) {
                blankSeen = true
                body.push('')
                i++
                continue
            }
            const indent = line.length - line.trimStart().length
            const sibling = LIST_ITEM.exec(line)
            if (sibling && sibling[1].length <= baseIndent) break
            if (indent < Math.min(contentIndent, baseIndent + 2) && !sibling) {
                if (blankSeen) break
                // Lazy continuation of the item's paragraph.
                body.push(line.trim())
                i++
                continue
            }
            if (blankSeen) loose = true
            blankSeen = false
            body.push(line.slice(Math.min(indent, contentIndent)))
            i++
        }
        while (body.length && !body[body.length - 1].trim()) body.pop()
        items.push(body)
    }
    const startAttr = ordered && parseInt(first[2], 10) !== 1 ? ` start="${parseInt(first[2], 10)}"` : ''
    const tag = ordered ? 'ol' : 'ul'
    const html = items
        .map((body) => {
            let text = body.join('\n')
            let check = ''
            const task = /^\[([ xX])\]\s+/.exec(text)
            if (task) {
                check = `<span class="md-task" aria-hidden="true">${task[1] === ' ' ? '\u2610' : '\u2611'}</span> `
                text = text.slice(task[0].length)
            }
            let inner = blocks(text.split('\n'), ctx)
            if (!loose) inner = inner.replace(/^<p>([\s\S]*?)<\/p>/, (_, content) => content)
            return `<li>${check}${inner}</li>`
        })
        .join('')
    return { html: `<${tag}${startAttr}>${html}</${tag}>`, end: i }
}

function blocks(lines, ctx) {
    let html = ''
    let i = 0
    while (i < lines.length) {
        const line = lines[i]
        if (!line.trim()) {
            i++
            continue
        }
        const fence = FENCE.exec(line)
        if (fence) {
            const marker = fence[1]
            const code = []
            i++
            while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) {
                code.push(lines[i])
                i++
            }
            i++ // closing fence (or end of a still-streaming answer)
            html += codeBlock(fence[2], code.join('\n'))
            continue
        }
        const heading = HEADING.exec(line)
        if (heading) {
            const level = heading[1].length
            html += `<h${level}>${inline(heading[2] || '', ctx)}</h${level}>`
            i++
            continue
        }
        if (RULE.test(line)) {
            html += '<hr>'
            i++
            continue
        }
        if (QUOTE.test(line)) {
            const quoted = []
            while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) {
                quoted.push(QUOTE.exec(lines[i])[1])
                i++
            }
            html += `<blockquote>${blocks(quoted, ctx)}</blockquote>`
            continue
        }
        if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]) && lines[i + 1].includes('-')) {
            const rows = [line, lines[i + 1]]
            i += 2
            while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
                rows.push(lines[i])
                i++
            }
            html += table(rows, ctx)
            continue
        }
        if (LIST_ITEM.test(line)) {
            const result = list(lines, i, ctx)
            html += result.html
            i = result.end
            continue
        }
        const para = [line.trim()]
        i++
        while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) {
            para.push(lines[i].trim())
            i++
        }
        html += `<p>${inline(para.join('\n'), ctx)}</p>`
    }
    return html
}

/**
 * Renders model output to an HTML string that only contains tags written here.
 * options.base: the Cuttlely server origin, used for links and images that start with "/".
 */
export function renderMarkdown(source, options = {}) {
    if (typeof source !== 'string' || !source) return ''
    const lines = source.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
    return blocks(lines, { base: options.base || '' })
}
