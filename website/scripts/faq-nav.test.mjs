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

    it('keeps the 3.1.4 advisories, the older file-write advisory, the internal-benchmarks sentence, and the import headings, and leaves Cloud and waitlist out', () => {
        const faq = fs.readFileSync(path.join(REPO, 'FAQ.md'), 'utf8')
        assert.match(faq, /## Coming from Flowise/)
        assert.doesNotMatch(faq, /## Importing existing flows/)
        assert.doesNotMatch(faq, /picks up where|next generation|fork of Flowise/i)
        assert.match(faq, /### Is Cuttlely affiliated with FlowiseAI\?/)
        assert.match(faq, /No\. Cuttlely is its own project, open source under Apache-2\.0\./)
        assert.match(faq, /### Can I bring my Flowise flows\?/)
        assert.doesNotMatch(faq, /### Can I bring my existing flows\?/)
        assert.match(faq, /### What about the Flowise security advisories\?/)
        assert.match(faq, /the six advisories on Flowise 3\.1\.4 that list no patched release/)
        assert.match(faq, /an older file-write advisory, \[GHSA-8vvx-qvq9-5948\]/)
        assert.match(faq, /for Flowise 2\.2\.7 and earlier/)
        for (const id of [...SIX_314, OLDER_FILE_WRITE]) {
            assert.equal(faq.includes(`[${id}](${FLOWISE_ADVISORY}${id})`), true, `${id} must link to ${FLOWISE_ADVISORY}${id}`)
        }
        assert.doesNotMatch(faq, /github\.com\/advisories\//)
        assert.match(faq, /Cuttlely is open source under Apache-2\.0\. The bundled agent runtime is Hermes \(MIT\)/)
        assert.match(faq, /lean context means fewer tokens in our \[internal benchmarks\]/)
        assert.doesNotMatch(faq, /Cuttlely Cloud/)
        assert.doesNotMatch(faq, /waitlist/)
        assert.doesNotMatch(faq, /Everything stays open source under Apache-2\.0/)
    })
})
