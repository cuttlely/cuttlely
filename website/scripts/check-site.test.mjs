import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { checkSite, visibleText } from './check-site.mjs'

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
    'whitepaper/index.html': `<html><head>${head}</head><body></body></html>`,
    'whitepaper/cuttlely-benchmark-whitepaper.html': `<html><head>${head}</head><body></body></html>`,
    'whitepaper/cuttlely-benchmark-whitepaper.pdf': '%PDF-1.7',
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

    it('fails when the whitepaper page or its files were not built', () => {
        for (const missing of [
            'whitepaper/index.html',
            'whitepaper/cuttlely-benchmark-whitepaper.html',
            'whitepaper/cuttlely-benchmark-whitepaper.pdf'
        ]) {
            const files = { ...base }
            delete files[missing]
            assert.ok(checkSite(site(files)).problems.includes(`missing ${missing}`), missing)
        }
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
