import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { containsLaTeX, preprocessLatex, remarkPluginsFor } from './math.mjs'

// rehype-mathjax only typesets the math nodes remark-math makes, so the remark output decides what is math.
const render = (text) =>
    renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: remarkPluginsFor(true) }, preprocessLatex(text)))

test('dollar amounts stay text', () => {
    const cases = [
        ['Offer a store credit of $10 as a goodwill gesture and refund shipping ($5.99).', '$10', '($5.99)'],
        ['The order was $1,200 and the refund is $300.', '$1,200', '$300'],
        ['Prices: $10, $5.99, $1,200 and $x^2$ dollars.', '$10, $5.99, $1,200', '$x^2$']
    ]
    for (const [text, ...kept] of cases) {
        const html = render(text)
        assert.doesNotMatch(html, /class="math/, text)
        for (const part of kept) assert.ok(html.includes(part), `${part} missing from ${html}`)
    }
})

test('dollar amounts do not switch math on', () => {
    assert.equal(containsLaTeX('A credit of $10 and shipping of $5.99_off'), false)
    assert.equal(containsLaTeX('Prices from $1,200 to $2,000'), false)
})

test('$$...$$ inline and on its own lines is math', () => {
    assert.match(render('The area is $$\\pi r^2$$ for a $10 rug.'), /<span class="math math-inline">\\pi r\^2<\/span> for a \$10 rug/)
    assert.match(render('Total:\n\n$$\nx^2 + y^2\n$$'), /<div class="math math-display">x\^2 \+ y\^2<\/div>/)
})

test('\\(...\\) and \\[...\\] are math', () => {
    assert.ok(containsLaTeX('so \\(a+b\\) holds'))
    assert.match(render('so \\(a+b\\) holds, at $5 each'), /so <span class="math math-inline">a\+b<\/span> holds, at \$5 each/)
    assert.match(render('Solve:\n\\[\nx = 1\n\\]\n'), /<div class="math math-display">x = 1<\/div>/)
})
