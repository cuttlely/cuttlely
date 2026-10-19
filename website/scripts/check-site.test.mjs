import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { checkSite, visibleText, homeFirstLoadBytes } from './check-site.mjs'
import { mediaUrl } from './media-version.mjs'

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
const home = `<html><head>${head}</head><body><h1>The visual agent builder, <span>ready for production.</span></h1><p>Drag-and-drop agents with real governance and lean context. Open source, Apache-2.0.</p><p>Copyright 2026 The Cuttlely Authors</p><a href="/flowise/">Coming from Flowise? Bring your flows</a><a href="/docs/#build">Docs</a><section id="integrations"></section></body></html>`
const base = {
    'index.html': home,
    '404.html': `<html><head>${head}</head><body>Not found</body></html>`,
    'quickstart/index.html': `<html><head>${head}</head><body></body></html>`,
    'docs/index.html': `<html><head>${head}</head><body><h2 id="build">Build</h2></body></html>`,
    'faq/index.html': `<html><head>${head}</head><body></body></html>`,
    'flowise/index.html': `<html><head>${head}</head><body><h1>Bring your Flowise flows.</h1><p>Import a flow (2-min guide)</p><p>Star on GitHub</p><p>Not affiliated with FlowiseAI. Flowise names and trademarks remain with their owners.</p></body></html>`,
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

    it('fails when the Flowise import page was not built', () => {
        const files = { ...base }
        delete files['flowise/index.html']
        assert.ok(checkSite(site(files)).problems.includes('missing flowise/index.html'))
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

    it('fails an unhashed /media/ link in built HTML', () => {
        const dir = site({
            ...base,
            'docs/index.html': `<html><head>${head}</head><body><h2 id="build">Build</h2><a href="https://cuttlely.com/media/products/testing.mp4">Watch</a></body></html>`
        })
        assert.match(checkSite(dir).problems.join('\n'), /unhashed or stale media link/)
    })

    it('accepts a /media/ link hashed to the public file', () => {
        const hashed = `https://cuttlely.com${mediaUrl('/media/products/testing.mp4')}`
        const dir = site({
            ...base,
            'docs/index.html': `<html><head>${head}</head><body><h2 id="build">Build</h2><a href="${hashed}">Watch</a></body></html>`
        })
        assert.equal(
            checkSite(dir)
                .problems.filter((p) => p.includes('media link'))
                .join('\n'),
            ''
        )
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
            ['2.5 times smaller', /ratio-style benchmark/],
            ['picks up where the last release', /retired successor copy/],
            ['the next generation of the visual builder', /retired successor copy/],
            ['with the production layer on top', /retired successor copy/]
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

    it('fails a sitemap that lists the /migrate/ alias', () => {
        const dir = site({
            ...base,
            'sitemap-0.xml': '<urlset><url><loc>https://cuttlely.com/migrate/</loc></url></urlset>'
        })
        assert.match(checkSite(dir).problems.join('\n'), /lists the \/migrate\/ alias/)
    })

    it('requires the Coming from Flowise home link to /flowise/', () => {
        const missingLink = home
            .replace('Coming from Flowise? Bring your flows', 'Bring your flows')
            .replace('href="/flowise/"', 'href="/docs/"')
        const dir = site({ ...base, 'index.html': missingLink })
        const problems = checkSite(dir).problems.join('\n')
        assert.match(problems, /missing href="\/flowise\/"/)
        assert.match(problems, /Coming from Flowise\?/)
    })

    it('requires the Integrations section on the home page', () => {
        const missing = home.replace('<section id="integrations"></section>', '')
        const dir = site({ ...base, 'index.html': missing })
        assert.match(checkSite(dir).problems.join('\n'), /missing the Integrations section/)
    })

    it('fails when the Integrations section names Flowise', () => {
        const named = home.replace('<section id="integrations"></section>', '<section id="integrations">Flowise</section>')
        const dir = site({ ...base, 'index.html': named })
        assert.match(checkSite(dir).problems.join('\n'), /the Integrations section names Flowise/)
    })

    it('fails waitlist copy and an unchanged-flows claim on the Flowise import page', () => {
        const waitlist = site({
            ...base,
            'flowise/index.html': `<html><head>${head}</head><body><h1>Bring your Flowise flows.</h1><p>Import a flow (2-min guide)</p><p>Star on GitHub</p><p>Join the waitlist</p><p>Not affiliated with FlowiseAI. Flowise names and trademarks remain with their owners.</p></body></html>`
        })
        assert.match(checkSite(waitlist).problems.join('\n'), /waitlist/)
        const unchanged = site({
            ...base,
            'flowise/index.html': `<html><head>${head}</head><body><h1>Bring your Flowise flows.</h1><p>Import a flow (2-min guide)</p><p>Star on GitHub</p><p>Cuttlely runs your flows unchanged</p><p>Not affiliated with FlowiseAI. Flowise names and trademarks remain with their owners.</p></body></html>`
        })
        assert.match(checkSite(unchanged).problems.join('\n'), /unchanged/)
        const draft = site({
            ...base,
            'flowise/index.html': `<html><head>${head}</head><body><h1>Bring your Flowise flows.</h1><p>Import a flow (2-min guide)</p><p>Star on GitHub</p><p>The import opens a draft of that flow.</p><p>Not affiliated with FlowiseAI. Flowise names and trademarks remain with their owners.</p></body></html>`
        })
        assert.match(checkSite(draft).problems.join('\n'), /opens a draft/)
    })

    it('skips social tags on a static redirect page', () => {
        const dir = site({
            ...base,
            'migrate/index.html': '<html><head><meta http-equiv="refresh" content="0;url=/flowise/"></head><body>Moved</body></html>'
        })
        assert.deepEqual(
            checkSite(dir).problems.filter((p) => p.includes('migrate')),
            []
        )
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
