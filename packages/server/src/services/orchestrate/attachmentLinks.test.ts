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

    it('stays linear on long runs of unmatched brackets', () => {
        for (const text of ['['.repeat(40000), '![a](b'.repeat(8000), '[a](attachment:'.repeat(3000)]) {
            const started = Date.now()
            expect(run([text])).toBe(dropAttachmentLinks(text))
            expect(run(text.match(/[\s\S]{1,500}/g) as string[])).toBe(dropAttachmentLinks(text))
            expect(Date.now() - started).toBeLessThan(500)
        }
    })

    it('removes angle-bracket targets, parentheses in the target and a line break before it, streamed or not', () => {
        for (const text of [
            'A [file](<attachment:report.pdf>) B',
            'A [file](attachment:report(1).pdf) B',
            'A [file](\nattachment:report.pdf) B',
            'A ![c]( attachment:c.png ) B'
        ]) {
            expect(dropAttachmentLinks(text)).toBe('A  B')
            expect(run(text.split(''))).toBe('A  B')
            expect(run([text])).toBe('A  B')
        }
        const kept = 'See [x](https://x.example/a(1)) and [y](attachment:a>b) and (attachment:z)'
        expect(run(kept.split(''))).toBe(dropAttachmentLinks(kept))
    })
})
