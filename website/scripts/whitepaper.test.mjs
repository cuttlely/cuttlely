import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { WHITEPAPER_DIR, WHITEPAPER_HTML, WHITEPAPER_PDF, whitepaperHtml, whitepaperPage, whitepaperPdf } from './whitepaper.mjs'

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const source = fs.readFileSync(path.join(WHITEPAPER_DIR, WHITEPAPER_HTML), 'utf8')
const body = (html) => html.slice(html.indexOf('<body'))

describe('whitepaper', () => {
    it('adds the canonical link and the preview image to the head and leaves the body as written', () => {
        const page = whitepaperPage()
        assert.match(
            page,
            /<link rel="canonical" href="https:\/\/cuttlely\.com\/whitepaper\/cuttlely-benchmark-whitepaper\.html">\s*<meta property="og:image"[^>]*>\s*<\/head>/
        )
        assert.equal(body(page), body(source))
        assert.equal(page.length - source.length, whitepaperHtml('<head></head>').length - '<head></head>'.length)
    })

    it('refuses a source with no head', () => {
        assert.throws(() => whitepaperHtml('<body>no head</body>'), /no <\/head>/)
    })

    it('serves the PDF as committed', () => {
        const pdf = whitepaperPdf()
        assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
        assert.ok(pdf.equals(fs.readFileSync(path.join(WHITEPAPER_DIR, WHITEPAPER_PDF))))
    })

    it(
        'is built into dist with the page, the web version and the PDF',
        { skip: !fs.existsSync(path.join(DIST, 'index.html')) && 'no website build (npm run build)' },
        () => {
            const page = fs.readFileSync(path.join(DIST, 'whitepaper', 'index.html'), 'utf8')
            assert.match(page, /href="\/whitepaper\/cuttlely-benchmark-whitepaper\.html"/)
            assert.match(page, /href="\/whitepaper\/cuttlely-benchmark-whitepaper\.pdf" download/)
            assert.equal(fs.readFileSync(path.join(DIST, 'whitepaper', WHITEPAPER_HTML), 'utf8'), whitepaperPage())
            assert.ok(fs.readFileSync(path.join(DIST, 'whitepaper', WHITEPAPER_PDF)).equals(whitepaperPdf()))
            assert.match(fs.readFileSync(path.join(DIST, 'index.html'), 'utf8'), /href="\/whitepaper\/"/)
        }
    )
})
