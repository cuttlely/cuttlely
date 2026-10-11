jest.mock('dompurify', () => ({ __esModule: true, default: { sanitize: jest.fn((html) => `clean:${html}`) } }))

import DOMPurify from 'dompurify'
import { markdownToHtml } from './markdownToHtml'

const html = (markdown) => markdownToHtml(markdown).replace(/^clean:/, '')

describe('markdownToHtml', () => {
    it('renders headings, emphasis, lists and code', () => {
        const out = html('# Role\n\nYou are **helpful**.\n\n- one\n- two\n\n`code`')
        expect(out).toContain('<h1>Role</h1>')
        expect(out).toContain('<strong>helpful</strong>')
        expect(out).toContain('<li>one</li>')
        expect(out).toContain('<code>code</code>')
    })

    it('keeps the GitHub extensions the generated instructions use', () => {
        const out = html('| a | b |\n| - | - |\n| 1 | 2 |\n\n~~old~~\n\n- [x] done\n\nSee https://cuttlely.com')
        expect(out).toContain('<table>')
        expect(out).toContain('<del>old</del>')
        expect(out).toContain('type="checkbox"')
        expect(out).toContain('<a href="https://cuttlely.com">https://cuttlely.com</a>')
    })

    it('always passes the HTML through DOMPurify', () => {
        DOMPurify.sanitize.mockClear()
        expect(markdownToHtml('<img src=x onerror=alert(1)>')).toMatch(/^clean:/)
        expect(DOMPurify.sanitize).toHaveBeenCalledTimes(1)
    })

    it('treats empty input as an empty string', () => {
        expect(html(undefined)).toBe('')
        expect(html(null)).toBe('')
    })
})
