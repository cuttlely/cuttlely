import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(SITE, '..')

const FLOWISE_ADVISORY = 'https://github.com/FlowiseAI/Flowise/security/advisories/'
const SIX_314 = [
    'GHSA-ppmg-4cx6-95hh',
    'GHSA-jvx3-mjpw-r4gh',
    'GHSA-27w2-26m5-x82c',
    'GHSA-rpcc-gw54-mfgx',
    'GHSA-cffm-583c-vffr',
    'GHSA-vf3j-89vf-r697'
]
const OLDER_FILE_WRITE = 'GHSA-8vvx-qvq9-5948'

describe('FAQ page wiring', () => {
    it('is a repository page, and the header, footer and site config point at /faq/', () => {
        assert.equal(fs.existsSync(path.join(REPO, 'FAQ.md')), true)
        assert.match(fs.readFileSync(path.join(SITE, 'src/components/HeaderLinks.astro'), 'utf8'), /href: '\/faq\/'/)
        assert.match(fs.readFileSync(path.join(SITE, 'src/components/SiteFooter.astro'), 'utf8'), /href="\/faq\/"/)
        assert.match(fs.readFileSync(path.join(SITE, 'scripts/site-config.mjs'), 'utf8'), /'FAQ\.md': '\/faq\/'/)
    })

    it('keeps the internal-benchmarks sentence and the import headings, leaves the import format and its advisories to /flowise/, and leaves Cloud and waitlist out', () => {
        const faq = fs.readFileSync(path.join(REPO, 'FAQ.md'), 'utf8')
        assert.match(faq, /## Bringing your flows/)
        assert.doesNotMatch(faq, /flowise/i)
        assert.doesNotMatch(faq, /picks up where|next generation/i)
        assert.match(faq, /### Where does the code come from\?/)
        assert.match(faq, /### Can I bring flows I already built\?/)
        assert.doesNotMatch(faq, /GHSA-ppmg-4cx6-95hh/)
        assert.doesNotMatch(faq, /github\.com\/advisories\//)
        assert.match(faq, /Cuttlely is open source under Apache-2\.0\. The bundled agent runtime is Hermes \(MIT\)/)
        assert.match(faq, /lean context means fewer tokens in our \[internal benchmarks\]/)
        assert.doesNotMatch(faq, /Cuttlely Cloud/)
        assert.doesNotMatch(faq, /waitlist/)
        assert.doesNotMatch(faq, /Everything stays open source under Apache-2\.0/)
    })
})
