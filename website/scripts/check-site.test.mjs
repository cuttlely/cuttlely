import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { checkSite, visibleText, homeFirstLoadBytes } from './check-site.mjs'

function site(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-site-'))
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
        fs.writeFileSync(path.join(dir, rel), body)
    }
    return dir
}

const head =
    '<link rel="canonical" href="https://cuttlely.com/"><meta property="og:image" content="https://cuttlely.com/social/og-light.png">'
const home = `<html><head>${head}</head><body><h1>Your applications deserve agents.</h1><p>The open-source agent platform for applications.</p><p>Copyright 2026 The Cuttlely Authors</p><a href="/docs/#build">Docs</a></body></html>`
const base = {
    'index.html': home,
    '404.html': `<html><head>${head}</head><body>Not found</body></html>`,
    'quickstart/index.html': `<html><head>${head}</head><body></body></html>`,
    'docs/index.html': `<html><head>${head}</head><body><h2 id="build">Build</h2></body></html>`,
    'faq/index.html': `<html><head>${head}</head><body></body></html>`,
    'robots.txt': '',
    'sitemap-index.xml': '',
    '.well-known/security.txt': '',
    'favicon.ico': '',
    'favicon.svg': '',
    'social/og-light.png': ''
}

describe('check-site', () => {
    it('passes a clean site', () => {
        assert.deepEqual(checkSite(site(base)).problems, [])
    })

    it('finds broken links, missing anchors and outside resources', () => {
        const dir = site({
            ...base,
            'docs/index.html': `<html><head>${head}</head><body><a href="/nope/">x</a><a href="/#missing">y</a><img src="https://cdn.example.com/a.png"><script src="https://example.com/t.js"></script></body></html>`
        })
        const problems = checkSite(dir).problems.join('\n')
        assert.match(problems, /broken link \/nope\//)
        assert.match(problems, /missing anchor \/#missing/)
        assert.match(problems, /<img> loads from another site/)
        assert.match(problems, /<script> loads from another site/)
        assert.match(problems, /index\.html: missing anchor \/docs\/#build/)
    })

    it('fails when the FAQ page was not built', () => {
        const files = { ...base }
        delete files['faq/index.html']
        assert.ok(checkSite(site(files)).problems.includes('missing faq/index.html'))
    })

    it('decodes an escaped ampersand in a link once', () => {
        const dir = site({
            ...base,
            'quickstart/index.html': `<html><head>${head}</head><body><a href="/a&amp;#38;b/">x</a></body></html>`
        })
        assert.match(checkSite(dir).problems.join('\n'), /broken link \/a&#38;b\/$/m)
    })

    it('drops scripts and styles whose end tag has spaces or attributes', () => {
        const text = visibleText('<p>a</p><script>one</script ><style>two</style\n data-x>b<SCRIPT type="m">three</SCRIPT foo>c')
        assert.equal(text.replace(/\s+/g, ' ').trim(), 'a b c')
    })

    it('flags the section mark', () => {
        const dir = site({ ...base, 'quickstart/index.html': `<html><head>${head}</head><body>See \u00a7 2</body></html>` })
        assert.match(checkSite(dir).problems.join('\n'), /section mark/)
    })
})

describe('website render.yaml cache headers', () => {
    it('sets a year-long immutable cache for hashed media, social and astro assets', () => {
        const yaml = fs.readFileSync(new URL('../render.yaml', import.meta.url), 'utf8')
        for (const route of ['/_astro/*', '/media/*', '/social/*']) {
            const block = yaml.split(`path: ${route}`)[1]
            assert.ok(block, route)
            assert.match(block.slice(0, 180), /name: Cache-Control/)
            assert.match(block.slice(0, 180), /value: public, max-age=31536000, immutable/)
        }
        const html = yaml.split('path: /*')[1]
        assert.equal(/name: Cache-Control/.test(html.slice(0, 400)), false)
    })
})

describe('home first-load weight', () => {
    it('counts HTML, CSS, scripts, eager images and posters, and leaves video, lazy images and nav pages out', () => {
        const dir = site({
            ...base,
            'index.html': `${home}<link rel="stylesheet" href="/s.css"><script src="/app.js"></script><img src="/a.webp"><img loading="lazy" src="/lazy.webp"><video poster="/p.webp"><source src="/clip.mp4"></video><a href="/docs/">Docs</a>`,
            '_astro/keep.txt': '',
            's.css': 'body{background:url("/bg.webp")}',
            'app.js': 'x'.repeat(10),
            'a.webp': 'x'.repeat(100),
            'lazy.webp': 'L'.repeat(8000),
            'p.webp': 'y'.repeat(50),
            'bg.webp': 'z'.repeat(25),
            'clip.mp4': 'm'.repeat(5000),
            'docs/index.html': 'D'.repeat(9000)
        })
        const { bytes, files } = homeFirstLoadBytes(dir)
        const paths = files.map((f) => f.urlPath)
        assert.equal(
            paths.some((p) => p.includes('clip.mp4')),
            false
        )
        assert.equal(
            paths.some((p) => p.includes('lazy.webp')),
            false
        )
        assert.equal(
            paths.some((p) => p === '/docs/' || p === '/docs/index.html'),
            false
        )
        assert.ok(paths.includes('/app.js'))
        assert.ok(bytes < 5000)
        assert.ok(bytes >= 100 + 50 + 25 + 10)
    })
})

describe('check-site content security policy', () => {
    it('flags an inline script the policy does not list', () => {
        const dir = site({
            ...base,
            'quickstart/index.html': `<html><head>${head}<script>console.log(1)</script></head><body></body></html>`
        })
        assert.match(checkSite(dir, { csp: "script-src 'self'" }).problems.join('\n'), /not allowed by the Content-Security-Policy/)
        assert.deepEqual(checkSite(dir).problems, [])
    })
})
