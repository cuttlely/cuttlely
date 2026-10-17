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
// Pages where naming another product is not allowed (the docs and credits name them where they must).
const BRAND_PAGES = new Set(['index.html', '404.html'])

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
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
}

function decode(s) {
    return s.replace(/&amp;/g, '&').replace(/&#38;/g, '&')
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
        for (const { re, why } of BANNED) {
            const hit = text.match(re) || html.match(re)
            if (hit) problems.push(`${page}: shows ${why} ("${hit[0]}")`)
        }
        if (BRAND_PAGES.has(page) && new RegExp(OTHER_PRODUCT, 'i').test(text)) problems.push(`${page}: names another product`)
        // Head
        if (!/<link rel="canonical"/.test(html) && page !== '404.html') problems.push(`${page}: no canonical link`)
        if (!/property="og:image"/.test(html)) problems.push(`${page}: no og:image`)
    }
    for (const required of [
        'index.html',
        '404.html',
        'quickstart/index.html',
        'docs/index.html',
        'whitepaper/index.html',
        'whitepaper/cuttlely-benchmark-whitepaper.html',
        'whitepaper/cuttlely-benchmark-whitepaper.pdf',
        'robots.txt',
        'sitemap-index.xml',
        '.well-known/security.txt',
        'favicon.ico',
        'favicon.svg',
        'social/og-light.png'
    ]) {
        if (!fs.existsSync(path.join(dist, required))) problems.push(`missing ${required}`)
    }
    if (unlisted.size) {
        problems.push(`inline scripts not allowed by the Content-Security-Policy in website/render.yaml, add: ${[...unlisted].join(' ')}`)
    }
    const home = fs.existsSync(path.join(dist, 'index.html')) ? fs.readFileSync(path.join(dist, 'index.html'), 'utf8') : ''
    for (const line of [
        'Your applications',
        'deserve agents.',
        'The open-source agent platform for applications.',
        'Copyright 2026 The Cuttlely Authors'
    ]) {
        if (!home.includes(line)) problems.push(`index.html: missing "${line}"`)
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
