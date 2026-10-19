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
})
