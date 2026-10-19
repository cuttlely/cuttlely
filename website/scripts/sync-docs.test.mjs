import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    docOutPath,
    docRoute,
    filterChangelogForSite,
    plainText,
    readmeSection,
    rewriteLinks,
    rewriteTarget,
    sidebarFromIndex,
    SIDEBAR_OMIT,
    splitPage
} from './sync-docs.mjs'

const REPO = 'https://github.com/cuttlely/cuttlely'

describe('sync-docs', () => {
    it('maps docs files to site routes and output paths', () => {
        assert.equal(docRoute('docs/README.md'), '/docs/')
        assert.equal(docRoute('docs/how-to/docker.md'), '/docs/how-to/docker/')
        assert.equal(docOutPath('docs/README.md'), 'docs/index.md')
        assert.equal(docOutPath('docs/api.md'), 'docs/api.md')
    })

    it('rewrites repository links to site routes or GitHub', () => {
        const from = 'docs/how-to/render.md'
        assert.equal(rewriteTarget('./docker.md#volumes', from).url, '/docs/how-to/docker/#volumes')
        assert.equal(rewriteTarget('../api.md', from).url, '/docs/api/')
        assert.equal(rewriteTarget('../../README.md#your-first-10-minutes', from).url, '/quickstart/')
        assert.equal(rewriteTarget('../../README.md#use-a-team-from-your-app', from).url, '/#use-a-team-from-your-app')
        assert.equal(rewriteTarget('../../SECURITY.md#report-a-vulnerability', from).url, '/security/#report-a-vulnerability')
        assert.equal(rewriteTarget('../../FAQ.md', from).url, '/faq/')
        assert.equal(rewriteTarget('../../NOTICE', from).url, '/credits/#notice')
        assert.equal(rewriteTarget('../../render.yaml', from, () => 'file').url, `${REPO}/blob/main/render.yaml`)
        assert.equal(rewriteTarget('../../examples/web-app', from, () => 'dir').url, `${REPO}/tree/main/examples/web-app`)
        assert.equal(rewriteTarget('https://render.com', from), null)
        assert.equal(rewriteTarget('https://cuttlely.com/media/products/testing.mp4?v=d1873063', from), null)
        assert.equal(rewriteTarget('#database', from), null)
    })

    it('leaves a poster image link and an absolute media link unchanged', () => {
        const md = [
            '[![Poster](../images/evaluations/testing-video-poster.png)](https://cuttlely.com/media/products/testing.mp4?v=d1873063)',
            '',
            '[Watch the testing run (56 seconds, sound on)](https://cuttlely.com/media/products/testing.mp4?v=d1873063)'
        ].join('\n')
        assert.equal(rewriteLinks(md, 'docs/how-to/tests-from-answers.md'), md)
    })

    it('leaves images, code blocks and inline code alone, and handles code in link text', () => {
        const md = [
            '![Shot](../images/a.png) and [Docker](./docker.md)',
            '[`examples/web-app`](../../examples/web-app)',
            'Run `[x](./y.md)` literally.',
            '```md',
            '[Docker](./docker.md)',
            '```'
        ].join('\n')
        const out = rewriteLinks(md, 'docs/how-to/render.md', () => 'dir').split('\n')
        assert.equal(out[0], '![Shot](../images/a.png) and [Docker](/docs/how-to/docker/)')
        assert.equal(out[1], `[\`examples/web-app\`](${REPO}/tree/main/examples/web-app)`)
        assert.equal(out[2], 'Run `[x](./y.md)` literally.')
        assert.equal(out[4], '[Docker](./docker.md)')
    })

    it('reports links to files that do not exist', () => {
        const problems = []
        rewriteLinks('[Gone](./gone.md)', 'docs/api.md', () => false, problems)
        assert.deepEqual(problems, ['docs/api.md: link to missing docs/gone.md'])
    })

    it('takes the title and description and drops the logo banner', () => {
        const page = splitPage('<p align="center">\n<img src="x.svg">\n</p>\n\n# Docs\n\nFirst **line** of [text](./a.md).\n\n## Next\n')
        assert.equal(page.title, 'Docs')
        assert.equal(page.description, 'First line of text.')
        assert.ok(!page.body.includes('<img'))
        assert.ok(page.body.startsWith('First'))
    })

    it('leaves no tag in a description, nested or not', () => {
        assert.equal(plainText('A <b>bold</b> <<script>script>x</script> word'), 'A bold script>x word')
        assert.equal(plainText('Keep a < b and c > d'), 'Keep a d')
    })

    it('cuts one README section', () => {
        const md = '# T\n\n## A\n\none\n\n```sh\n## not a heading\n```\n\n## B\n\ntwo\n'
        assert.equal(readmeSection(md, 'A'), 'one\n\n```sh\n## not a heading\n```')
        assert.throws(() => readmeSection(md, 'C'))
    })

    it('builds the sidebar from the docs index groups', () => {
        const index =
            '# Docs\n\n## Build\n\n-   [Harnesses](./how-to/harnesses.md). Teams.\n-   [Analyst](./how-to/analyst.md), see [this](./how-to/render.md#analyst-database).\n\n## Reference\n\n-   [Changelog](../CHANGELOG.md)\n'
        assert.deepEqual(sidebarFromIndex(index, {}), [
            {
                label: 'Build',
                items: [
                    { label: 'Harnesses', link: '/docs/how-to/harnesses/' },
                    { label: 'Analyst', link: '/docs/how-to/analyst/' }
                ]
            },
            { label: 'Reference', items: [{ label: 'Changelog', link: '/changelog/' }] }
        ])
    })

    it('keeps the Langflow import page off the generated sidebar', () => {
        assert.equal(SIDEBAR_OMIT.has('/docs/langflow-import/'), true)
    })

    it('drops the whitepaper changelog line for the site copy', () => {
        const md = [
            '## [1.3.0] - 2026-10-18',
            '',
            '### Added',
            '',
            '-   Keep this.',
            '-   The benchmark whitepaper is on the website at `/whitepaper/`, as a web page and a PDF.',
            '-   Also keep this.'
        ].join('\n')
        const out = filterChangelogForSite(md)
        assert.equal(out.includes('whitepaper'), false)
        assert.ok(out.includes('-   Keep this.'))
        assert.ok(out.includes('-   Also keep this.'))
    })
})
