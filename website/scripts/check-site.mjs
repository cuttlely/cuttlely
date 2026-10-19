#!/usr/bin/env node
/* eslint-disable no-console -- build script; output is the interface */
// Checks the built site in dist/ without the network:
//   - every internal link points at a page or file that exists, and every #anchor exists on that page
//   - every image, script and stylesheet is served from the site itself (no third-party requests, no analytics)
//   - no page shows words that must not appear on the site
// Run after `astro build` (npm run build does both).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mediaHrefProblems, repoMediaLinkProblems } from './media-version.mjs'

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Product names are built from parts so this file does not spell them out.
const OTHER_PRODUCT = ['flow', 'ise'].join('')
export const BANNED = [
    { re: /\u00a7/, why: 'the section mark' },
    { re: new RegExp(`${OTHER_PRODUCT}[- ]compatible`, 'i'), why: 'a compatibility claim' },
    { re: new RegExp(['den', 'flow'].join(''), 'i'), why: 'an internal name' }
]

const RETIRED_COPY = [
    { needle: 'Your applications deserve agents', why: 'the retired headline' },
    { needle: 'agent platform for applications', why: 'the retired tagline' },
    { needle: 'zero failed runs', why: 'a ratio-style benchmark claim' },
    { needle: '3.7 times', why: 'a ratio-style benchmark claim' },
    { needle: '2,114', why: 'a ratio-style token count' },
    { needle: '7,719', why: 'a ratio-style token count' },
    { needle: 'whitepaper', why: 'a removed whitepaper' },
    { re: /picks up where|next generation of the visual builder/i, why: 'retired successor copy' },
    { needle: 'production layer on top', why: 'retired successor copy' }
]

const RATIO_CLAIMS = [
    { re: /\b\d+(\.\d+)? times (smaller|fewer|less)\b/i, why: 'a ratio-style benchmark claim' },
    { re: /a (third|quarter) of the/i, why: 'a ratio-style benchmark claim' }
]

const SCORE_CLAIMS = [
    { re: /\d+ of \d+ questions/i, why: 'a score-style benchmark claim' },
    { re: /(?<!step )\b5 of 5\b/i, why: 'a score-style benchmark claim' },
    { re: /(?<!step )\b9 of 9\b/i, why: 'a score-style benchmark claim' }
]

const OTHER_APPS = ['n8n', ['lang', 'flow'].join(''), 'dify', ['keel', 'flow'].join(''), 'heym', ['migrate', 'flows'].join(''), 'ashes']
const OTHER_APPS_RE = new RegExp(`\\b(${OTHER_APPS.join('|')})\\b`, 'i')

const HOME_LINES = [
    'The visual agent builder, ready for production.',
    'Drag-and-drop agents with real governance and lean context. Open source, Apache-2.0.',
    'Copyright 2026 The Cuttlely Authors'
]

export function htmlFiles(dir, base = dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) htmlFiles(full, base, out)
        else if (entry.name.endsWith('.html')) out.push(path.relative(base, full).split(path.sep).join('/'))
    }
    return out
}

export function ids(html) {
    const found = new Set()
    for (const m of html.matchAll(/\sid="([^"]+)"/g)) found.add(m[1])
    return found
}

/** Visible text, roughly: tags, scripts and styles removed. */
export function visibleText(html) {
    return html
        .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, ' ')
        .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
}

function decode(s) {
    return s.replace(/&(?:amp|#38);/g, '&')
}

function sitePath(page) {
    return '/' + page.replace(/index\.html$/, '')
}

function isChangelog(page) {
    const p = sitePath(page)
    return p === '/changelog/' || p === '/changelog' || p.startsWith('/changelog/')
}

function skipCompetitorNames(page) {
    const p = sitePath(page)
    return p.startsWith('/docs/reference/') || p.includes('langflow-import')
}

/** The dist file a site URL path maps to, or null. */
export function resolveFile(dist, urlPath) {
    const clean = decodeURIComponent(urlPath.split('?')[0])
    const candidates = clean.endsWith('/')
        ? [path.join(dist, clean, 'index.html')]
        : [path.join(dist, clean), path.join(dist, clean, 'index.html'), path.join(dist, `${clean}.html`)]
    return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) || null
}

/** The CSP hashes of the inline scripts in one page. */
export function inlineScriptHashes(html) {
    const out = []
    for (const m of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
        out.push(`'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`)
    }
    return out
}

function pngSize(buf) {
    if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/**
 * Checks the built site. With `csp` (the Content-Security-Policy value from website/render.yaml), also checks that
 * every inline script is allowed by it, so the live site does not block its own theme and menu scripts.
 */
export function checkSite(dist, { csp = null } = {}) {
    const problems = []
    const unlisted = new Set()
    const pages = htmlFiles(dist)
    const idCache = new Map()
    const idsOf = (file) => {
        if (!idCache.has(file)) idCache.set(file, ids(fs.readFileSync(file, 'utf8')))
        return idCache.get(file)
    }
    let links = 0
    for (const page of pages) {
        const file = path.join(dist, page)
        const html = fs.readFileSync(file, 'utf8')
        const pageUrl = '/' + page.replace(/index\.html$/, '')
        // Links and anchors
        for (const m of html.matchAll(/<a\b[^>]*\shref="([^"]*)"/g)) {
            const href = decode(m[1])
            if (!href || /^(https?:|mailto:|tel:)/i.test(href)) continue
            if (href.startsWith('//')) {
                problems.push(`${page}: protocol-relative link ${href}`)
                continue
            }
            links += 1
            const [p, anchor] = href.split('#')
            const target = p ? (p.startsWith('/') ? p : new URL(p, `https://x${pageUrl}`).pathname) : pageUrl
            const targetFile = resolveFile(dist, target)
            if (!targetFile) {
                problems.push(`${page}: broken link ${href}`)
                continue
            }
            if (anchor && targetFile.endsWith('.html') && !idsOf(targetFile).has(decodeURIComponent(anchor))) {
                problems.push(`${page}: missing anchor ${href}`)
            }
        }
        // Resources must come from this site
        for (const m of html.matchAll(/<(script|img|link|source|iframe|video|audio)\b[^>]*?\s(src|href|srcset)="([^"]*)"/g)) {
            const [, tag, attr, value] = m
            if (tag === 'link' && !/rel="(stylesheet|preload|icon|apple-touch-icon|manifest|modulepreload)"/.test(m[0])) continue
            const urls = attr === 'srcset' ? value.split(',').map((s) => s.trim().split(/\s+/)[0]) : [value]
            for (const u of urls) {
                if (/^(https?:)?\/\//i.test(u)) problems.push(`${page}: <${tag}> loads from another site: ${u}`)
                else if (u.startsWith('/') && !resolveFile(dist, u)) problems.push(`${page}: <${tag}> file not found: ${u}`)
            }
        }
        if (/<iframe\b/i.test(html)) problems.push(`${page}: has an iframe`)
        for (const href of mediaHrefProblems(html)) {
            problems.push(`${page}: unhashed or stale media link ${href}`)
        }
        if (csp) for (const h of inlineScriptHashes(html)) if (!csp.includes(h)) unlisted.add(h)
        // Words
        const text = visibleText(html)
        const haystack = `${text}\n${html}`
        for (const { re, why } of BANNED) {
            const hit = text.match(re) || html.match(re)
            if (hit) problems.push(`${page}: shows ${why} ("${hit[0]}")`)
        }
        for (const item of RETIRED_COPY) {
            if (item.needle !== 'whitepaper' && isChangelog(page)) continue
            if (item.re) {
                const hit = haystack.match(item.re)
                if (hit) problems.push(`${page}: shows ${item.why} ("${hit[0]}")`)
            } else if (item.needle && haystack.includes(item.needle)) {
                problems.push(`${page}: shows ${item.why} ("${item.needle}")`)
            }
        }
        for (const { re, why } of RATIO_CLAIMS) {
            if (isChangelog(page)) continue
            const hit = haystack.match(re)
            if (hit) problems.push(`${page}: shows ${why} ("${hit[0]}")`)
        }
        if (!isChangelog(page)) {
            for (const { re, why } of SCORE_CLAIMS) {
                const hit = haystack.match(re)
                if (hit) problems.push(`${page}: shows ${why} ("${hit[0]}")`)
            }
        }
        if (!skipCompetitorNames(page)) {
            const hit = text.match(OTHER_APPS_RE)
            if (hit) problems.push(`${page}: names another product ("${hit[0]}")`)
        }
        // Head. A static redirect is a meta refresh; it does not need social tags of its own.
        const redirect = /http-equiv=["']refresh["']/i.test(html)
        if (!redirect && !/<link rel="canonical"/.test(html) && page !== '404.html') problems.push(`${page}: no canonical link`)
        if (!redirect && !/property="og:image"/.test(html)) problems.push(`${page}: no og:image`)
    }
    for (const required of [
        'index.html',
        '404.html',
        'quickstart/index.html',
        'docs/index.html',
        'faq/index.html',
        'flowise/index.html',
        'robots.txt',
        'sitemap-index.xml',
        '.well-known/security.txt',
        'favicon.ico',
        'favicon.svg',
        'social/og-light.png'
    ]) {
        if (!fs.existsSync(path.join(dist, required))) problems.push(`missing ${required}`)
    }
    const og = path.join(dist, 'social/og-light.png')
    if (fs.existsSync(og)) {
        const buf = fs.readFileSync(og)
        const size = pngSize(buf)
        if (size) {
            if (size.width !== 1200 || size.height !== 630) {
                problems.push(`social/og-light.png is ${size.width}x${size.height}, need 1200x630`)
            }
            if (buf.length > 300 * 1024) problems.push('social/og-light.png is over 300 KB')
        } else if (buf.length > 0) {
            problems.push('social/og-light.png is not a PNG')
        }
    }
    for (const name of fs.existsSync(dist) ? fs.readdirSync(dist) : []) {
        if (!/^sitemap.*\.xml$/.test(name)) continue
        const xml = fs.readFileSync(path.join(dist, name), 'utf8')
        if (/langflow-import/i.test(xml)) problems.push(`${name}: lists the Langflow import page`)
        if (/\/migrate\/?<\/loc>/.test(xml)) problems.push(`${name}: lists the /migrate/ alias`)
    }
    if (unlisted.size) {
        problems.push(`inline scripts not allowed by the Content-Security-Policy in website/render.yaml, add: ${[...unlisted].join(' ')}`)
    }
    const home = fs.existsSync(path.join(dist, 'index.html')) ? fs.readFileSync(path.join(dist, 'index.html'), 'utf8') : ''
    const homeText = visibleText(home).replace(/\s+/g, ' ')
    for (const line of HOME_LINES) {
        if (!homeText.includes(line) && !home.includes(line)) problems.push(`index.html: missing "${line}"`)
    }
    if (!home.includes('href="/flowise/"')) {
        problems.push('index.html: missing href="/flowise/"')
    }
    if (!home.includes('Coming from Flowise?')) {
        problems.push('index.html: missing "Coming from Flowise?"')
    }
    const integrations = home.match(/<section id="integrations"[\s\S]*?<\/section>/)
    if (!integrations) {
        problems.push('index.html: missing the Integrations section')
    } else if (/flowise/i.test(integrations[0])) {
        problems.push('index.html: the Integrations section names Flowise')
    }
    const flowiseFile = path.join(dist, 'flowise/index.html')
    if (fs.existsSync(flowiseFile)) {
        const flowise = fs.readFileSync(flowiseFile, 'utf8')
        const flowiseText = visibleText(flowise)
        for (const line of [
            'Bring your Flowise flows.',
            'Import a flow (2-min guide)',
            'Star on GitHub',
            'Not affiliated with FlowiseAI. Flowise names and trademarks remain with their owners.'
        ]) {
            if (!flowise.includes(line) && !flowiseText.includes(line)) problems.push(`flowise/index.html: missing "${line}"`)
        }
        if (/waitlist/i.test(flowiseText)) problems.push('flowise/index.html: shows waitlist copy')
        if (/runs your flows unchanged/i.test(flowiseText)) problems.push('flowise/index.html: claims flows run unchanged')
        if (/opens a draft/i.test(flowiseText)) problems.push('flowise/index.html: says the import opens a draft')
    }
    // A real site build has hashed /_astro assets. Fixtures used by unit tests do not.
    if (home && fs.existsSync(path.join(dist, '_astro'))) {
        const { bytes } = homeFirstLoadBytes(dist)
        if (bytes > HOME_FIRST_LOAD_LIMIT) {
            problems.push(`index.html first-load ${bytes} bytes exceeds ${HOME_FIRST_LOAD_LIMIT} (${(bytes / 1024).toFixed(1)} KiB)`)
        }
    }
    return { pages: pages.length, links, problems }
}

/** Desktop first paint of `/` must stay under this, videos excluded because they stay detached until play. */
export const HOME_FIRST_LOAD_LIMIT = 600 * 1024

const VIDEO_RE = /\.(mp4|webm|m4v)(\?|$)/i
const FIRST_LOAD_LINK_REL = /(?:^|\s)(?:stylesheet|modulepreload|preload|icon|shortcut icon|apple-touch-icon|manifest)(?:\s|$)/i

function attr(tag, name) {
    return new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag)?.[1]
}

function cssUrls(css, fromPath) {
    const found = []
    for (const m of css.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g)) {
        const raw = m[1]
        if (/^(data:|https?:|\/\/)/i.test(raw)) continue
        found.push(path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), raw.split('?')[0])))
    }
    return found
}

function enqueueSrcset(srcset, enqueue) {
    const candidates = String(srcset || '')
        .split(',')
        .map((part) => part.trim().split(/\s+/)[0])
        .filter(Boolean)
    if (candidates.length) enqueue(candidates[candidates.length - 1])
}

/**
 * Bytes `/` fetches on a first desktop visit: the HTML, render-blocking CSS and JS, fonts,
 * eager images, and video posters. Navigation links, lazy images, and video files stay out
 * because those files are not requested until the visitor follows a link, scrolls, or clicks play.
 */
export function homeFirstLoadBytes(dist) {
    const htmlPath = path.join(dist, 'index.html')
    const html = fs.readFileSync(htmlPath, 'utf8')
    const pending = new Set(['/index.html'])
    const seen = new Set()
    let bytes = 0
    const files = []
    const enqueue = (urlPath) => {
        const clean = decodeURIComponent(String(urlPath).split('?')[0])
        if (!clean.startsWith('/') || VIDEO_RE.test(clean)) return
        pending.add(clean)
    }
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
        const tag = m[0]
        const rel = attr(tag, 'rel') || ''
        const href = attr(tag, 'href')
        if (href && FIRST_LOAD_LINK_REL.test(rel)) enqueue(href)
    }
    for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
        const src = attr(m[0], 'src')
        if (src) enqueue(src)
    }
    for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
        const tag = m[0]
        if (/\sloading="lazy"/i.test(tag)) continue
        const srcset = attr(tag, 'srcset')
        if (srcset) enqueueSrcset(srcset, enqueue)
        else {
            const src = attr(tag, 'src')
            if (src) enqueue(src)
        }
    }
    for (const m of html.matchAll(/<video\b[^>]*>/gi)) {
        const poster = attr(m[0], 'poster')
        if (poster) enqueue(poster)
    }
    for (const m of html.matchAll(/<track\b[^>]*>/gi)) {
        const src = attr(m[0], 'src')
        if (src) enqueue(src)
    }
    while (pending.size) {
        const urlPath = pending.values().next().value
        pending.delete(urlPath)
        if (seen.has(urlPath)) continue
        seen.add(urlPath)
        const file = resolveFile(dist, urlPath)
        if (!file) continue
        const size = fs.statSync(file).size
        bytes += size
        files.push({ urlPath, size })
        if (file.endsWith('.css')) {
            const rel = '/' + path.relative(dist, file).split(path.sep).join('/')
            for (const u of cssUrls(fs.readFileSync(file, 'utf8'), rel)) enqueue(u)
        }
    }
    return { bytes, files }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const dist = path.resolve(process.argv[2] || path.join(SITE, 'dist'))
    if (!fs.existsSync(dist)) {
        console.error(`check-site: ${dist} does not exist. Run npm run build first.`)
        process.exit(2)
    }
    const blueprint = path.join(SITE, 'render.yaml')
    const cspLine = fs.existsSync(blueprint) ? fs.readFileSync(blueprint, 'utf8').match(/value: "(default-src[^"]*)"/) : null
    const { pages, links, problems } = checkSite(dist, { csp: cspLine ? cspLine[1] : '' })
    problems.push(...repoMediaLinkProblems(path.join(SITE, '..')))
    for (const p of problems) console.error(`check-site: ${p}`)
    if (problems.length) {
        console.error(`check-site: FAILED, ${problems.length} problem(s) in ${pages} pages`)
        process.exit(1)
    }
    console.log(`check-site: OK, ${pages} pages, ${links} internal links checked`)
}
