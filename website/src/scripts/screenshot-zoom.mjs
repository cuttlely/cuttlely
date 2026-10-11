// Pure helpers for the screenshot viewer. Shared by the page script, the build
// rewrite and the unit tests. No DOM and no Node APIs, so the browser bundle
// stays a same-origin module (the site CSP allows script-src 'self' only).

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

export function enlargeLabel(alt) {
    return `Enlarge screenshot: ${alt}`
}

/** A content screenshot, not a logo, icon, mascot or other decorative image. */
export function shouldZoomImage({ alt, src, className = '', width = '' } = {}) {
    if (!alt || !String(alt).trim()) return false
    if (!src) return false
    const path = String(src).split(/[?#]/)[0]
    if (/\.svg$/i.test(path)) return false
    if (/(?:^|\s)(?:cl-mascot|cl-final-mascot)(?:\s|$)/.test(className)) return false
    const parsed = Number(width)
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 160) return false
    return true
}

/** The biggest candidate in a srcset, else the src. That file is the full-resolution image the site ships. */
export function largestSrc(src, srcset) {
    if (!srcset) return src || ''
    let bestUrl = src || ''
    let best = -1
    for (const part of String(srcset).split(',')) {
        const bits = part.trim().split(/\s+/)
        if (!bits[0]) continue
        const desc = bits[1] || ''
        let score = 0
        if (desc.endsWith('w')) score = Number.parseFloat(desc)
        else if (desc.endsWith('x')) score = Number.parseFloat(desc) * 1e6
        if (Number.isFinite(score) && score >= best) {
            best = score
            bestUrl = bits[0]
        }
    }
    return bestUrl
}

/**
 * Scale that fits the whole image in the viewport without enlarging it past 100%.
 * `pad` is the dark rim on each side, which is also the backdrop people can click.
 */
export function fitScale(viewW, viewH, imgW, imgH, pad = 24) {
    if (!(viewW > 0) || !(viewH > 0) || !(imgW > 0) || !(imgH > 0)) return 1
    const contain = Math.min(Math.max(1, viewW - pad * 2) / imgW, Math.max(1, viewH - pad * 2) / imgH)
    return Math.min(1, contain)
}

/** The other double-click stop: 100% when the image is larger than the viewport, otherwise 2×. */
export function zoomedScale(fit) {
    if (!(fit > 0) || fit < 0.999) return 1
    return 2
}

/**
 * Zoom toward a pointer. `pointerX/Y` are relative to the top-left of the viewport.
 * The image is centred, then shifted by `tx/ty`, with transform-origin at its centre.
 */
export function zoomAtPoint(state, pointerX, pointerY, nextScale) {
    const scale = state.scale > 0 ? state.scale : 1
    const clamped = Math.min(state.max, Math.max(state.min, nextScale))
    const ratio = clamped / scale
    const px = pointerX - state.viewW / 2
    const py = pointerY - state.viewH / 2
    return {
        scale: clamped,
        tx: px - (px - state.tx) * ratio,
        ty: py - (py - state.ty) * ratio
    }
}

/** Keep the scaled image from sliding entirely off the viewport. */
export function clampPan(state) {
    const maxX = Math.max(0, (state.imgW * state.scale - state.viewW) / 2)
    const maxY = Math.max(0, (state.imgH * state.scale - state.viewH) / 2)
    return {
        tx: Math.min(maxX, Math.max(-maxX, state.tx)),
        ty: Math.min(maxY, Math.max(-maxY, state.ty))
    }
}

function decode(value) {
    return String(value)
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
}

function esc(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function attr(tag, name) {
    const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'))
    if (!match) return ''
    return decode(match[2] ?? match[3] ?? '')
}

function hasAttr(tag, name) {
    return new RegExp(`(?:^|\\s)${name}(?:\\s*=|\\s|/?>)`, 'i').test(tag)
}

function classHas(tag, className) {
    return attr(tag, 'class').split(/\s+/).includes(className)
}

function parseTag(tag) {
    const match = tag.match(/^<\s*(\/)?\s*([a-zA-Z][\w:-]*)/)
    if (!match) return null
    const name = match[2].toLowerCase()
    return { name, closing: Boolean(match[1]), selfClosing: /\/>\s*$/.test(tag) || VOID.has(name) }
}

/**
 * Wrap content screenshots in a link to the full image file.
 * The link is the no-JS fallback; the page script opens the viewer instead.
 * Only images inside `[data-screenshot-zoom]` are touched. Logos, empty-alt
 * images, SVG, mascots and anything under `.not-content` or an existing link stay put.
 */
export function wrapZoomableImages(html) {
    let i = 0
    let out = ''
    const stack = []
    const inZoom = () => stack.some((frame) => frame.zoom)
    const blocked = () => stack.some((frame) => frame.block)

    while (i < html.length) {
        if (html.startsWith('<!--', i)) {
            const end = html.indexOf('-->', i)
            const to = end === -1 ? html.length : end + 3
            out += html.slice(i, to)
            i = to
            continue
        }
        if (html[i] !== '<') {
            const next = html.indexOf('<', i)
            const to = next === -1 ? html.length : next
            out += html.slice(i, to)
            i = to
            continue
        }
        const end = html.indexOf('>', i)
        if (end === -1) {
            out += html.slice(i)
            break
        }
        const tag = html.slice(i, end + 1)
        const parsed = parseTag(tag)
        if (!parsed) {
            out += tag
            i = end + 1
            continue
        }
        if (parsed.closing) {
            for (let s = stack.length - 1; s >= 0; s -= 1) {
                if (stack[s].name === parsed.name) {
                    stack.length = s
                    break
                }
            }
            out += tag
            i = end + 1
            continue
        }
        if ((parsed.name === 'script' || parsed.name === 'style') && !parsed.selfClosing) {
            const close = new RegExp(`</${parsed.name}\\s*>`, 'i')
            const rest = html.slice(end + 1)
            const found = close.exec(rest)
            const to = found ? end + 1 + found.index + found[0].length : html.length
            out += html.slice(i, to)
            i = to
            continue
        }
        if (parsed.name === 'img' && inZoom() && !blocked()) {
            const info = {
                alt: attr(tag, 'alt'),
                src: attr(tag, 'src'),
                className: attr(tag, 'class'),
                width: attr(tag, 'width')
            }
            if (shouldZoomImage(info)) {
                const full = largestSrc(info.src, attr(tag, 'srcset'))
                out += `<a class="cl-zoom" href="${esc(full)}" role="button" draggable="false" aria-label="${esc(
                    enlargeLabel(info.alt)
                )}">${tag}</a>`
                i = end + 1
                continue
            }
        }
        out += tag
        if (!parsed.selfClosing) {
            const parent = stack[stack.length - 1]
            stack.push({
                name: parsed.name,
                zoom: Boolean(parent?.zoom) || hasAttr(tag, 'data-screenshot-zoom'),
                block: classHas(tag, 'not-content') || classHas(tag, 'cl-zoom') || parsed.name === 'a'
            })
        }
        i = end + 1
    }
    return out
}
