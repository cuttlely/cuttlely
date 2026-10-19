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
const home = `<html><head>${head}</head><body><h1>The visual agent builder, <span>ready for production.</span></h1><p>Drag-and-drop agents with real governance and lean context. Open source, Apache-2.0.</p><p>Copyright 2026 The Cuttlely Authors</p><a href="/docs/#build">Docs</a></body></html>`
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

describe('check-site message house', () => {
    it('requires the production headline in visible home text', () => {
        const dir = site({
            ...base,
            'index.html': `<html><head>${head}</head><body><h1>Hello</h1><p>Copyright 2026 The Cuttlely Authors</p></body></html>`
        })
        const problems = checkSite(dir).problems.join('\n')
        assert.match(problems, /missing "The visual agent builder, ready for production\."/)
    })

    it('fails on retired headlines, ratio claims and a whitepaper', () => {
        const cases = [
            ['Your applications deserve agents', /retired headline/],
            ['the agent platform for applications', /retired tagline/],
            ['zero failed runs', /ratio-style benchmark/],
            ['3.7 times', /ratio-style benchmark/],
            ['2,114 tokens', /ratio-style token count/],
            ['7,719 tokens', /ratio-style token count/],
            ['See the whitepaper', /removed whitepaper/],
            ['a third of the tokens', /ratio-style benchmark/],
            ['about a quarter of the prompt', /ratio-style benchmark/],
            ['2.5 times smaller', /ratio-style benchmark/]
        ]
        for (const [body, why] of cases) {
            const dir = site({
                ...base,
                'quickstart/index.html': `<html><head>${head}</head><body>${body}</body></html>`
            })
            assert.match(checkSite(dir).problems.join('\n'), why, body)
        }
    })

    it('fails on 5 of 5 and 9 of 9 claims, and on N of M questions', () => {
        for (const body of ['answered 5 of 5', 'routed 9 of 9', 'passed 4 of 8 questions']) {
            const dir = site({
                ...base,
                'quickstart/index.html': `<html><head>${head}</head><body>${body}</body></html>`
            })
            assert.match(checkSite(dir).problems.join('\n'), /score-style benchmark/, body)
        }
    })

    it('lets 6 of 20 relations, version numbers and step 5 of 5 through', () => {
        const dir = site({
            ...base,
            'quickstart/index.html': `<html><head>${head}</head><body>ticking 6 of 20 relations on Cuttlely 1.3.0, image step 5 of 5: keeping production packages only</body></html>`
        })
        assert.deepEqual(checkSite(dir).problems, [])
    })

    it('names other products on the home page, not on the import page or a reference library name', () => {
        const langflow = ['Lang', 'flow'].join('')
        const homeHit = site({
            ...base,
            'index.html': home.replace('</body>', `<p>Unlike ${langflow}</p></body>`)
        })
        assert.match(checkSite(homeHit).problems.join('\n'), /names another product/)
        const importPage = site({
            ...base,
            'docs/langflow-import/index.html': `<html><head>${head}</head><body>${langflow} import format</body></html>`
        })
        assert.deepEqual(
            checkSite(importPage).problems.filter((p) => p.includes('another product')),
            []
        )
        const reference = site({
            ...base,
            'docs/reference/startup-options/index.html': `<html><head>${head}</head><body>the n8n node pack</body></html>`
        })
        assert.deepEqual(
            checkSite(reference).problems.filter((p) => p.includes('another product')),
            []
        )
    })

    it('fails a sitemap that lists the Langflow import page', () => {
        const dir = site({
            ...base,
            'sitemap-0.xml': '<urlset><url><loc>https://cuttlely.com/docs/langflow-import/</loc></url></urlset>'
        })
        assert.match(checkSite(dir).problems.join('\n'), /lists the Langflow import page/)
    })

    it('the committed link preview is 1200x630 and under 300 KB', () => {
        const buf = fs.readFileSync(new URL('../public/social/og-light.png', import.meta.url))
        assert.equal(buf.readUInt32BE(16), 1200)
        assert.equal(buf.readUInt32BE(20), 630)
        assert.ok(buf.length < 300 * 1024, `${buf.length} bytes`)
    })

    it('skips retired copy on the changelog except a whitepaper', () => {
        const dir = site({
            ...base,
            'changelog/index.html': `<html><head>${head}</head><body>the agent platform for applications, 9 of 9, a third of the tokens</body></html>`
        })
        assert.deepEqual(checkSite(dir).problems, [])
        const withPaper = site({
            ...base,
            'changelog/index.html': `<html><head>${head}</head><body>See the whitepaper</body></html>`
        })
        assert.match(checkSite(withPaper).problems.join('\n'), /removed whitepaper/)
    })

    it('scans the analyst guide for score-style claims', () => {
        const dir = site({
            ...base,
            'docs/how-to/analyst/index.html': `<html><head>${head}</head><body>gpt-4.1 passed 9 of 9</body></html>`
        })
        assert.match(checkSite(dir).problems.join('\n'), /score-style benchmark/)
    })
})
