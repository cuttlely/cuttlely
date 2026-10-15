import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { escapeHtml, renderMarkdown, safeUrl } from '../src/markdown.js'

describe('renderMarkdown safety', () => {
    const vectors = [
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        '<a href="javascript:alert(1)">x</a>',
        '[click](javascript:alert(1))',
        '[click](JaVaScRiPt:alert(1))',
        '[click](java\tscript:alert(1))',
        '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
        '![x](javascript:alert(1))',
        '![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)',
        '[x](https://ok.example/" onmouseover="alert(1))',
        '<svg onload=alert(1)>',
        '`<b>` and <iframe src="https://evil.example"></iframe>',
        '| a | b |\n|---|---|\n| <img src=x onerror=1> | ok |',
        '```html\n<script>alert(1)</script>\n```'
    ]
    for (const input of vectors) {
        it(`neutralizes ${JSON.stringify(input).slice(0, 60)}`, () => {
            const html = renderMarkdown(input)
            assert.doesNotMatch(html, /<script/i)
            assert.doesNotMatch(html, /<iframe/i)
            assert.doesNotMatch(html, /<svg/i)
            assert.doesNotMatch(html, /<[a-z][^>]*\son[a-z]+=/i, 'no event handler attributes')
            assert.doesNotMatch(html, /<a [^>]*href="\s*(javascript|data|vbscript):/i)
            assert.doesNotMatch(html, /src="\s*(javascript|data:image\/svg)/i)
        })
    }

    it('escapes every special character', () => {
        assert.equal(escapeHtml(`<a href="x" class='y'>&`), '&lt;a href=&quot;x&quot; class=&#39;y&#39;&gt;&amp;')
    })

    it('keeps quotes inside URLs from breaking out of the attribute', () => {
        const html = renderMarkdown('[x](https://ok.example/a"b)')
        assert.match(html, /href="https:\/\/ok\.example\/a&quot;b"/)
    })

    it('allows only safe URL schemes', () => {
        assert.equal(safeUrl('https://a.example/x'), 'https://a.example/x')
        assert.equal(safeUrl('mailto:hi@a.example'), 'mailto:hi@a.example')
        assert.equal(safeUrl('/api/v1/x', { base: 'https://d.example/' }), 'https://d.example/api/v1/x')
        assert.equal(safeUrl('//evil.example/x'), null)
        assert.equal(safeUrl('javascript:alert(1)'), null)
        assert.equal(safeUrl('mailto:x', { image: true }), null)
        assert.equal(safeUrl('data:image/png;base64,iVBORw0KGgo=', { image: true }), 'data:image/png;base64,iVBORw0KGgo=')
        assert.equal(safeUrl('data:image/png;base64,iVBORw0KGgo='), null)
    })
})

describe('renderMarkdown formatting', () => {
    it('renders emphasis, code and links', () => {
        const html = renderMarkdown('Fresh **sourdough** and *rye*, see `menu.csv` at https://bakery.example/menu.')
        assert.match(html, /<strong>sourdough<\/strong>/)
        assert.match(html, /<em>rye<\/em>/)
        assert.match(html, /<code>menu\.csv<\/code>/)
        assert.match(html, /<a href="https:\/\/bakery\.example\/menu"[^>]*>https:\/\/bakery\.example\/menu<\/a>\./)
    })

    it('leaves snake_case words alone', () => {
        assert.equal(renderMarkdown('use daily_bread_count here'), '<p>use daily_bread_count here</p>')
    })

    it('renders a fenced code block with its language and a copy button', () => {
        const html = renderMarkdown('```sql\nSELECT * FROM loaves;\n```')
        assert.match(html, /<span>sql<\/span>/)
        assert.match(html, /data-copy-code/)
        assert.match(html, /<pre><code>SELECT \* FROM loaves;<\/code><\/pre>/)
    })

    it('renders an unfinished code fence while the answer is still streaming', () => {
        assert.match(renderMarkdown('Here:\n```js\nconst a = 1'), /<pre><code>const a = 1<\/code><\/pre>/)
    })

    it('renders a table with alignment', () => {
        const html = renderMarkdown('| Item | Sold |\n|:--|--:|\n| Croissant | 42 |\n| Baguette | 17 |')
        assert.match(
            html,
            /<div class="md-table"><table><thead><tr><th style="text-align:left">Item<\/th><th style="text-align:right">Sold<\/th>/
        )
        assert.match(html, /<td style="text-align:right">42<\/td>/)
    })

    it('renders headings, quotes, rules and lists', () => {
        const html = renderMarkdown('## Today\n\n> Fresh at 7am\n\n---\n\n1. Mix\n2. Proof\n   - 2 hours\n3. Bake\n\n- [x] Order flour')
        assert.match(html, /<h2>Today<\/h2>/)
        assert.match(html, /<blockquote><p>Fresh at 7am<\/p><\/blockquote>/)
        assert.match(html, /<hr>/)
        assert.match(html, /<ol><li>Mix<\/li><li>Proof<ul><li>2 hours<\/li><\/ul><\/li><li>Bake<\/li><\/ol>/)
        assert.match(html, /md-task/)
    })

    it('keeps line breaks inside a paragraph', () => {
        assert.equal(renderMarkdown('one\ntwo'), '<p>one<br>two</p>')
    })

    it('renders images from https and the Cuttlely server', () => {
        const html = renderMarkdown('![chart](/api/v1/get-upload-file?x=1)', { base: 'https://d.example' })
        assert.match(html, /<img src="https:\/\/d\.example\/api\/v1\/get-upload-file\?x=1" alt="chart" loading="lazy">/)
    })

    it('keeps dollar amounts as text', () => {
        assert.equal(
            renderMarkdown('Offer a store credit of $10 as a goodwill gesture and refund shipping ($5.99).'),
            '<p>Offer a store credit of $10 as a goodwill gesture and refund shipping ($5.99).</p>'
        )
        assert.equal(renderMarkdown('The order was $1,200 and the refund is $300.'), '<p>The order was $1,200 and the refund is $300.</p>')
    })

    it('shows math source as text', () => {
        assert.equal(renderMarkdown('The area is $$\\pi r^2$$ for a $10 rug.'), '<p>The area is $$\\pi r^2$$ for a $10 rug.</p>')
    })
})
