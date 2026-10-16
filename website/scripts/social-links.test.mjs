import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const componentPath = path.join(root, 'src/components/SocialLinks.astro')
const component = fs.readFileSync(componentPath, 'utf8')

const EXPECTED = [
    { name: 'GitHub', href: 'https://github.com/cuttlely/cuttlely', me: true },
    { name: 'X', href: 'https://x.com/cuttlely', me: false },
    { name: 'Bluesky', href: 'https://bsky.app/profile/cuttlely.bsky.social', me: false },
    { name: 'Mastodon', href: 'https://mastodon.social/@cuttlely', me: true },
    { name: 'LinkedIn', href: 'https://www.linkedin.com/company/cuttlely/', me: false },
    { name: 'DEV', href: 'https://dev.to/cuttlely', me: false },
    { name: 'Reddit', href: 'https://www.reddit.com/user/cuttlely', me: false }
]

test('the social links list all seven profiles in order, with rel="me" on GitHub and Mastodon', () => {
    const entries = [...component.matchAll(/name: '([^']+)',\s*href: '([^']+)',(\s*me: true,)?/g)].map((m) => ({
        name: m[1],
        href: m[2],
        me: Boolean(m[3])
    }))
    assert.deepEqual(entries, EXPECTED)
})

test('each social link is an icon with an accessible label and a title, opening in a new tab', () => {
    assert.match(component, /aria-label=\{`Cuttlely on \$\{name\}`\}/)
    assert.match(component, /title=\{`Cuttlely on \$\{name\}`\}/)
    assert.match(component, /target="_blank"/)
    assert.match(component, /rel=\{me \? 'me noopener noreferrer' : 'noopener noreferrer'\}/)
    assert.match(component, /<svg [^>]*fill="currentColor"[^>]*aria-hidden="true"/)
    assert.doesNotMatch(component, /<img|<script|src=/)
})

test('the home page shows the social links right under the sign-off line', () => {
    const footer = fs.readFileSync(path.join(root, 'src/components/Footer.astro'), 'utf8')
    assert.ok(footer.indexOf('cl-signoff') < footer.indexOf('{isHome && <SocialLinks />}'))
})

test('the built home page has the seven links, hrefs and labels', (t) => {
    const htmlPath = path.join(root, 'dist', 'index.html')
    if (!fs.existsSync(htmlPath) || fs.statSync(htmlPath).mtimeMs < fs.statSync(componentPath).mtimeMs) {
        t.skip('no fresh build in dist/')
        return
    }
    const html = fs.readFileSync(htmlPath, 'utf8')
    const list = html.match(/<ul class="cl-social[^"]*"[^>]*>([\s\S]*?)<\/ul>/)
    assert.ok(list, 'the social list is on the home page')
    const anchors = [...list[1].matchAll(/<a ([^>]+)>/g)].map((m) => m[1])
    assert.equal(anchors.length, EXPECTED.length)
    EXPECTED.forEach(({ name, href, me }, i) => {
        const attrs = anchors[i]
        assert.ok(attrs.includes(`href="${href}"`), `${name} href`)
        assert.ok(attrs.includes(`aria-label="Cuttlely on ${name}"`), `${name} aria-label`)
        assert.ok(attrs.includes(`title="Cuttlely on ${name}"`), `${name} title`)
        assert.ok(attrs.includes('target="_blank"'), `${name} target`)
        assert.ok(attrs.includes(`rel="${me ? 'me ' : ''}noopener noreferrer"`), `${name} rel`)
    })
})
