import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(SITE, '..')

describe('FAQ page wiring', () => {
    it('is a repository page, and the header, footer and site config point at /faq/', () => {
        assert.equal(fs.existsSync(path.join(REPO, 'FAQ.md')), true)
        assert.match(fs.readFileSync(path.join(SITE, 'src/components/HeaderLinks.astro'), 'utf8'), /href: '\/faq\/'/)
        assert.match(fs.readFileSync(path.join(SITE, 'src/components/SiteFooter.astro'), 'utf8'), /href="\/faq\/"/)
        assert.match(fs.readFileSync(path.join(SITE, 'scripts/site-config.mjs'), 'utf8'), /'FAQ\.md': '\/faq\/'/)
    })

    it('keeps the six-advisory security answer and the internal-benchmarks sentence, and leaves Cloud, waitlist and product lineage out', () => {
        const faq = fs.readFileSync(path.join(REPO, 'FAQ.md'), 'utf8')
        assert.match(faq, /### What about the Flowise security advisories\?/)
        for (const id of [
            'GHSA-ppmg-4cx6-95hh',
            'GHSA-jvx3-mjpw-r4gh',
            'GHSA-27w2-26m5-x82c',
            'GHSA-rpcc-gw54-mfgx',
            'GHSA-cffm-583c-vffr',
            'GHSA-vf3j-89vf-r697',
            'GHSA-8vvx-qvq9-5948'
        ]) {
            assert.match(faq, new RegExp(id))
        }
        assert.match(faq, /lean context means fewer tokens in our \[internal benchmarks\]/)
        assert.doesNotMatch(faq, /Cuttlely Cloud/)
        assert.doesNotMatch(faq, /waitlist/)
        assert.doesNotMatch(faq, /Is Cuttlely a fork/)
    })
})
