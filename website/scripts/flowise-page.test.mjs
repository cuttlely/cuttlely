import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(...parts) {
    return fs.readFileSync(path.join(SITE, ...parts), 'utf8')
}

describe('Flowise import page wiring', () => {
    it('is a site page, and the header, footer and home hero point at /flowise/', () => {
        assert.equal(fs.existsSync(path.join(SITE, 'src/pages/flowise.astro')), true)
        assert.match(read('src/components/HeaderLinks.astro'), /href: '\/flowise\/'/)
        assert.match(read('src/components/PageTitle.astro'), /pathname\.startsWith\('\/flowise\/'\)/)
        assert.match(read('src/components/SiteFooter.astro'), /href="\/flowise\/"/)
        const hero = read('src/components/Hero.astro')
        assert.match(hero, /href="\/flowise\/"/)
        assert.match(hero, /Coming from Flowise\?/)
    })

    it('keeps the approved title, lineage, pillars, buttons, quickstart, paths, disclaimer, and issue link, and leaves waitlist, unchanged-flows, sequential-agent, and whole-install claims out', () => {
        const page = read('src/pages/flowise.astro')
        assert.match(page, /Bring your Flowise flows: import, no rebuild \| Cuttlely/)
        assert.match(page, /The visual agent builder, ready for production\./)
        assert.match(page, /Bring your Flowise flows\./)
        assert.match(page, /Drag-and-drop agents with real governance and lean context\. Open source, Apache-2\.0\./)
        assert.match(
            page,
            /Cuttlely picks up where Flowise left off\.\.\. the next generation of the visual builder\. Import opens your flows node for node\./
        )
        assert.match(page, /Ship changes safely\./)
        assert.match(page, /Keep context small\./)
        assert.match(page, /Bring your flows\./)
        assert.match(page, /Import a flow \(2-min guide\)/)
        assert.match(page, /href="\/docs\/bring-your-flows\/"/)
        assert.match(page, /Star on GitHub/)
        assert.match(page, /npx cuttlely start/)
        assert.match(page, /git clone https:\/\/github\.com\/cuttlely\/cuttlely && cd cuttlely && docker compose up -d/)
        assert.match(page, /id="cl-flowise-npx"/)
        assert.match(page, /id="cl-flowise-compose"/)
        assert.doesNotMatch(page, /id="cl-flowise-start"/)
        assert.match(page, /localhost:43117/)
        assert.match(page, /Import Flowise JSON/)
        assert.match(page, /data-clip-slot/)
        assert.match(page, /data-src-webm=""/)
        assert.match(page, /data-src-mp4=""/)
        assert.match(page, /One flow at a time/)
        assert.match(page, /Just the API/)
        assert.match(page, /POST \/api\/v1\/prediction\/:id/)
        assert.match(page, /cf_bakery_helper_7a2c/)
        assert.match(page, /About 300 nodes/)
        assert.match(page, /FLOWISE_\*/)
        assert.match(page, /CUTTLELY_\*/)
        assert.match(page, /Not affiliated with FlowiseAI\. Flowise names and trademarks remain with their owners\./)
        assert.match(page, /Send me a flow that breaks\./)
        assert.match(page, /issues\/new\?template=bug_report\.yml/)
        assert.match(page, /href="\/docs\/flowise-migration-wizard\/"/)
        assert.match(page, /The first Save publishes the flow/)
        assert.doesNotMatch(page, /opens a draft/)
        assert.doesNotMatch(page, /waitlist/i)
        assert.doesNotMatch(page, /runs your flows unchanged/i)
        assert.doesNotMatch(page, /sequential/i)
        assert.doesNotMatch(page, /multi-agent/i)
        assert.doesNotMatch(page, /whole[- ]install/i)
        assert.doesNotMatch(page, /~\.?\/\.flowise/)
    })

    it('redirects /migrate and /migrate/ to /flowise/ in Astro and on Render, and keeps the whitepaper redirects', () => {
        const astro = read('astro.config.mjs')
        assert.match(astro, /'\/migrate\/': '\/flowise\/'/)
        assert.doesNotMatch(astro, /'\/migrate': '\/flowise\/'/)
        const blueprint = read('render.yaml')
        assert.match(blueprint, /source: \/migrate\n\s+destination: \/flowise\//)
        assert.match(blueprint, /source: \/migrate\/\n\s+destination: \/flowise\//)
        assert.match(blueprint, /source: \/whitepaper/)
        assert.match(blueprint, /source: \/whitepaper\/\*/)
        assert.match(blueprint, /buildFilter:/)
    })
})
