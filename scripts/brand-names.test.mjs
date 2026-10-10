import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { oldNameInCaptions, oldNameInImageNames, scan } from './brand-names.mjs'

const OLD = ['den', 'flow'].join('')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('brand names in images and captions', () => {
    it('flags image file names with the old name, and skips vendored folders', () => {
        const found = oldNameInImageNames([
            `docs/images/${OLD}-home.png`,
            'docs/images/home.png',
            `hermes/assets/${OLD}.png`,
            `docs/${OLD}.md`
        ])
        assert.deepEqual(
            found.map((f) => f.file),
            [`docs/images/${OLD}-home.png`]
        )
    })

    it('flags alt text, titles and captions, not ordinary prose', () => {
        const md = [
            `![The ${OLD} home page](images/home.png)`,
            `![Home](images/home.png "${OLD} home")`,
            `<img src="a.png" alt="${OLD} logo">`,
            '![Home](images/home.png)',
            `*The ${OLD} home page*`,
            `<figure><img src="b.png" alt="x"><figcaption>${OLD} canvas</figcaption></figure>`,
            '![Cuttlely home](images/home.png)'
        ].join('\n')
        const why = oldNameInCaptions('doc.md', md).map((f) => `${f.file} ${f.why}`)
        assert.deepEqual(why, [
            'doc.md:1 image alt text',
            'doc.md:2 image title',
            'doc.md:3 image alt text',
            'doc.md:5 image caption',
            'doc.md:6 image caption'
        ])
        assert.deepEqual(oldNameInCaptions('doc.md', `Run ${OLD} with one command.`), [])
    })

    it('the repository has no image name or caption with the old name', () => {
        const found = scan(ROOT)
        assert.deepEqual(found, [], found.map((f) => `${f.file} (${f.why})`).join('\n'))
    })
})
