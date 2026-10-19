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
    { needle: 'whitepaper', why: 'a removed whitepaper' }
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
        if (csp) for (const h of inlineScriptHashes(html)) if (!csp.includes(h)) unlisted.add(h)
        // Words
        const text = visibleText(html)
        const haystack = `${text}\n${html}`
        for (const { re, why } of BANNED) {
            const hit = text.match(re) || html.match(re)
            if (hit) problems.push(`${page}: shows ${why} ("${hit[0]}")`)
        }
        for (const { needle, why } of RETIRED_COPY) {
            if (needle !== 'whitepaper' && isChangelog(page)) continue
            if (haystack.includes(needle)) problems.push(`${page}: shows ${why} ("${needle}")`)
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
    if (/picks up where/.test(home) && !home.includes('href="/flowise/"')) {
        problems.push('index.html: lineage line should point at /flowise/')
    }
    if (/picks up where/.test(home) && !home.includes('Coming from Flowise?')) {
        problems.push('index.html: missing "Coming from Flowise?"')
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
    return { pages: pages.length, links, problems }
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
    for (const p of problems) console.error(`check-site: ${p}`)
    if (problems.length) {
        console.error(`check-site: FAILED, ${problems.length} problem(s) in ${pages} pages`)
        process.exit(1)
    }
    console.log(`check-site: OK, ${pages} pages, ${links} internal links checked`)
}
