import { dropAttachmentLinks, makeAttachmentLinkFilter } from './attachmentLinks'

const run = (tokens: string[]) => {
    const filter = makeAttachmentLinkFilter()
    const parts = tokens.map((t) => filter.push(t))
    parts.push(filter.flush())
    return parts.join('')
}

describe('makeAttachmentLinkFilter', () => {
    it('removes an attachment: link split across tokens and keeps the rest', () => {
        expect(run(['Here ', '![ch', 'art](atta', 'chment:chart.png', ') done'])).toBe('Here  done')
        expect(run(['See [file](ATTACHMENT:r.pdf).'])).toBe('See .')
    })

    it('passes real links, brackets and exclamation marks through unchanged', () => {
        const text = 'Wow! A [docs](https://x.example) link, an array [1, 2] and ![img](https://x.example/a.png)!'
        expect(run(text.split(''))).toBe(text)
        expect(run([text])).toBe(text)
        expect(run(['[a', ']b'])).toBe('[a]b')
    })

    it('matches the non-streaming filter and never holds more than a bounded amount', () => {
        const text = 'A ![x](attachment:x.png) B [y](attachment:y.pdf) C'
        expect(run(text.split(''))).toBe(dropAttachmentLinks(text))
        const filter = makeAttachmentLinkFilter()
        const out = filter.push('[' + 'a'.repeat(5000))
        expect(out.length).toBeGreaterThan(2000)
    })
})
