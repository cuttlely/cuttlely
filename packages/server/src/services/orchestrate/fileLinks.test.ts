import { setFileLinkSecretForTests, verifyFileLink } from '../../utils/fileLinkSignature'
import {
    artifactLinks,
    dropAttachmentLinks,
    EXTERNAL_FILE_LINK_TTL_DEFAULT,
    EXTERNAL_FILE_LINK_TTL_MAX,
    EXTERNAL_FILE_LINK_TTL_MIN,
    externalFileLinkTtlSeconds,
    makeArtifactLinker,
    makeAttachmentLinkFilter,
    storedFileName,
    withArtifactLinks
} from './fileLinks'

const NOW = Date.UTC(2026, 9, 23, 12)
const ctx = { baseURL: 'https://navi.example', orgId: 'org-1', chatflowId: 'flow-1', chatId: 'chat-1', now: NOW, ttlSeconds: 3600 }
const urlOf = (markdown: string) => new URL(markdown.match(/\((https:[^)]+)\)$/)![1])

beforeEach(() => setFileLinkSecretForTests('file-links-unit-secret'))
afterEach(() => setFileLinkSecretForTests(undefined))

describe('externalFileLinkTtlSeconds', () => {
    it('defaults to one hour and clamps to [60, 86400]', () => {
        expect(EXTERNAL_FILE_LINK_TTL_DEFAULT).toBe(3600)
        expect(externalFileLinkTtlSeconds(undefined)).toBe(3600)
        expect(externalFileLinkTtlSeconds('')).toBe(3600)
        expect(externalFileLinkTtlSeconds('abc')).toBe(3600)
        expect(externalFileLinkTtlSeconds('-5')).toBe(3600)
        expect(externalFileLinkTtlSeconds('1.5')).toBe(3600)
        expect(externalFileLinkTtlSeconds('900')).toBe(900)
        expect(externalFileLinkTtlSeconds('1')).toBe(EXTERNAL_FILE_LINK_TTL_MIN)
        expect(externalFileLinkTtlSeconds('999999999')).toBe(EXTERNAL_FILE_LINK_TTL_MAX)
    })

    it('clamps a context TTL too', () => {
        const [link] = artifactLinks([{ type: 'png', data: 'FILE-STORAGE::a.png' }], { ...ctx, ttlSeconds: 10 ** 9 })
        expect(Number(urlOf(link.markdown).searchParams.get('expires'))).toBe(NOW / 1000 + EXTERNAL_FILE_LINK_TTL_MAX)
    })
})

describe('storedFileName', () => {
    it('accepts only plain FILE-STORAGE names', () => {
        expect(storedFileName({ data: 'FILE-STORAGE::chart_1.png' })).toBe('chart_1.png')
        expect(storedFileName({ data: 'FILE-STORAGE::quarterly report.pdf' })).toBe('quarterly report.pdf')
        expect(storedFileName({ data: 'FILE-STORAGE::résumé 2026.docx' })).toBe('résumé 2026.docx')
        for (const data of [
            'FILE-STORAGE::../x.png',
            'FILE-STORAGE::a/b.png',
            'FILE-STORAGE::a\\b.png',
            'FILE-STORAGE::..',
            'FILE-STORAGE::.hidden',
            'FILE-STORAGE::["a.png"]',
            'FILE-STORAGE::a%2f..png',
            'FILE-STORAGE::',
            'FILE-STORAGE:: lead.png',
            'FILE-STORAGE::a\u0000.png',
            'FILE-STORAGE::a\nb.png',
            'FILE-STORAGE::' + 'a'.repeat(256),
            '/var/data/a.png',
            'data:image/png;base64,AAAA'
        ]) {
            expect(storedFileName({ data })).toBeUndefined()
        }
        expect(storedFileName(null)).toBeUndefined()
        expect(storedFileName({ data: 5 })).toBeUndefined()
    })
})

describe('artifactLinks', () => {
    it('writes image Markdown for images and a download link for other files', () => {
        const links = artifactLinks(
            [
                { type: 'png', data: 'FILE-STORAGE::chart.png' },
                { type: 'jpeg', data: 'FILE-STORAGE::photo.jpg', name: 'photo [1].jpg' },
                { type: 'pdf', data: 'FILE-STORAGE::h_deck.pdf', name: '/srv/out/deck.pdf' },
                { type: 'csv', data: 'FILE-STORAGE::rows.csv' }
            ],
            ctx
        )
        expect(links.map((l) => l.markdown.replace(/\(https:[^)]+\)$/, '(URL)'))).toEqual([
            '![Image: chart.png](URL)',
            '![Image: photo 1 .jpg](URL)',
            '[Download deck.pdf](URL)',
            '[Download rows.csv](URL)'
        ])
        expect(links.map((l) => l.markdown).join('')).not.toContain('/srv/')
        // Images render inline; only other files are served as downloads.
        expect(urlOf(links[0].markdown).searchParams.has('download')).toBe(false)
        expect(urlOf(links[2].markdown).searchParams.get('download')).toBe('true')
        const img = urlOf(links[0].markdown)
        const target = { orgId: 'org-1', chatflowId: 'flow-1', chatId: 'chat-1', fileName: 'chart.png' }
        expect(verifyFileLink(target, img.searchParams.get('expires'), img.searchParams.get('signature'), NOW)).toBe('valid')
    })

    it('signs for exactly this chat: valid now, expired after the TTL, invalid for another chat, flow, org or file', () => {
        const [link] = artifactLinks([{ type: 'pdf', data: 'FILE-STORAGE::deck.pdf' }], ctx)
        const url = urlOf(link.markdown)
        expect(url.origin + url.pathname).toBe('https://navi.example/api/v1/get-upload-file')
        expect(url.searchParams.get('chatflowId')).toBe('flow-1')
        expect(url.searchParams.get('chatId')).toBe('chat-1')
        expect(url.searchParams.get('fileName')).toBe('deck.pdf')
        expect(url.search).not.toContain('org-1')
        const expires = url.searchParams.get('expires')
        const signature = url.searchParams.get('signature')
        const target = { orgId: 'org-1', chatflowId: 'flow-1', chatId: 'chat-1', fileName: 'deck.pdf' }
        expect(Number(expires)).toBe(NOW / 1000 + 3600)
        expect(verifyFileLink(target, expires, signature, NOW + 1000)).toBe('valid')
        expect(verifyFileLink(target, expires, signature, NOW + 3600 * 1000)).toBe('expired')
        expect(verifyFileLink({ ...target, chatId: 'chat-2' }, expires, signature, NOW)).toBe('invalid')
        expect(verifyFileLink({ ...target, chatflowId: 'flow-2' }, expires, signature, NOW)).toBe('invalid')
        expect(verifyFileLink({ ...target, orgId: 'org-2' }, expires, signature, NOW)).toBe('invalid')
        expect(verifyFileLink({ ...target, fileName: 'other.pdf' }, expires, signature, NOW)).toBe('invalid')
        expect(verifyFileLink(target, String(Number(expires) + 3600), signature, NOW)).toBe('invalid')
    })

    it('leaves files out when the server cannot sign, or when the context is incomplete', () => {
        setFileLinkSecretForTests(undefined)
        const prev = { secret: process.env.TOKEN_HASH_SECRET, path: process.env.SECRETKEY_PATH }
        delete process.env.TOKEN_HASH_SECRET
        process.env.SECRETKEY_PATH = '/nonexistent-cuttlely-test'
        try {
            expect(artifactLinks([{ type: 'png', data: 'FILE-STORAGE::a.png' }], ctx)).toEqual([])
        } finally {
            if (prev.secret !== undefined) process.env.TOKEN_HASH_SECRET = prev.secret
            if (prev.path !== undefined) process.env.SECRETKEY_PATH = prev.path
            else delete process.env.SECRETKEY_PATH
        }
        setFileLinkSecretForTests('file-links-unit-secret')
        expect(artifactLinks([{ type: 'png', data: 'FILE-STORAGE::a.png' }], { ...ctx, chatId: '' })).toEqual([])
        expect(artifactLinks('nope', ctx)).toEqual([])
    })
})

describe('answer text', () => {
    it('drops made-up attachment: links and appends the real ones', () => {
        expect(dropAttachmentLinks('See ![c](attachment:c.png) and [file](ATTACHMENT:report.pdf).')).toBe('See  and .')
        expect(dropAttachmentLinks('Keep [docs](https://x.example)')).toBe('Keep [docs](https://x.example)')
        expect(withArtifactLinks('Answer', [{ fileName: 'a.png', markdown: '![a.png](u)' }])).toBe('Answer\n\n![a.png](u)')
        expect(withArtifactLinks('', [{ fileName: 'a.png', markdown: '![a.png](u)' }])).toBe('![a.png](u)')
        expect(withArtifactLinks('Answer', [])).toBe('Answer')
    })

    it('drops a download label with no link and the `[label][attachment:...]` form, and keeps real links', () => {
        expect(dropAttachmentLinks('[Download the deck: **d.pptx**]\n\nText')).toBe('\n\nText')
        expect(dropAttachmentLinks('A [Download d.pptx][attachment:d.pptx] B')).toBe('A  B')
        expect(dropAttachmentLinks('![d.png][ attachment:d.png] B')).toBe(' B')
        for (const keep of [
            '[Download d](https://x.example/d)',
            '- [x] done',
            '[1] cite',
            '[Download d][1]',
            '[Download d]: https://x.example',
            '![Download d](https://x)'
        ]) {
            expect(dropAttachmentLinks(keep)).toBe(keep)
        }
        expect(withArtifactLinks('\n\n\nAnswer', [])).toBe('Answer')
    })

    it('streams the same text as the non-streaming filter for dangling labels, split at every point', () => {
        const texts = [
            'Hi [Download d.pptx] and [Download e](https://x.example/e) and [d][attachment:d.pptx] ok [Download f]',
            '[Download deck][\nattachment:deck.pptx] and [x][ \tattachment:x.png] and ![i][attachment:i.png]'
        ]
        expect(dropAttachmentLinks(texts[0])).toBe('Hi  and [Download e](https://x.example/e) and  ok ')
        expect(dropAttachmentLinks(texts[1])).toBe('[Download deck][\nattachment:deck.pptx] and  and ')
        for (const text of texts) {
            const want = dropAttachmentLinks(text)
            for (let cut = 1; cut < text.length; cut++) {
                const filter = makeAttachmentLinkFilter()
                expect(filter.push(text.slice(0, cut)) + filter.push(text.slice(cut)) + filter.flush()).toBe(want)
            }
        }
    })

    it('labels images with a capital word and the name the file was written under', () => {
        const [png] = artifactLinks([{ type: 'png', data: 'FILE-STORAGE::harness_python_1792792110729_0_zz-test-blue-square.png' }], ctx)
        expect(png.markdown).toMatch(/^!\[Image: zz-test-blue-square\.png\]\(https:/)
        const [plain] = artifactLinks([{ type: 'png', data: 'FILE-STORAGE::harness_notes.png' }], ctx)
        expect(plain.markdown).toMatch(/^!\[Image: harness_notes\.png\]\(https:/)
    })

    it('links each file once across stream and final body', () => {
        const linker = makeArtifactLinker(ctx)
        const a = { type: 'png', data: 'FILE-STORAGE::a.png' }
        const b = { type: 'pdf', data: 'FILE-STORAGE::b.pdf' }
        expect(linker.take([a])).toMatch(/^!\[Image: a\.png\]/)
        expect(linker.take([a])).toBe('')
        expect(linker.links([a, b]).map((l) => l.fileName)).toEqual(['b.pdf'])
        expect(linker.all([a, b]).map((l) => l.fileName)).toEqual(['a.png', 'b.pdf'])
        expect(makeArtifactLinker(undefined).take([a])).toBe('')
    })

    it('links collected stream artifacts with the final ones, once each', () => {
        const linker = makeArtifactLinker(ctx)
        const a = { type: 'png', data: 'FILE-STORAGE::a.png' }
        const b = { type: 'pdf', data: 'FILE-STORAGE::b.pdf' }
        linker.collect([a])
        linker.collect('not a list')
        expect(linker.links([a, b]).map((l) => l.fileName)).toEqual(['a.png', 'b.pdf'])
        linker.collect([a])
        expect(linker.take([])).toBe('')
    })
})
