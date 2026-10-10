import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import AppHero from './AppHero'
import { t } from '@/i18n'
import en from '@/i18n/en'

const html = (mode, props = {}) =>
    renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme({ palette: { mode } }) }, createElement(AppHero, props)))

describe('UI strings', () => {
    test('returns the English string for a key, English for a missing locale and the key when unknown', () => {
        expect(t('hero.headline')).toBe('Your applications deserve agents.')
        expect(t('hero.tagline')).toBe('The open-source agent platform for applications.')
        expect(t('hero.headline', 'xx')).toBe(en['hero.headline'])
        expect(t('no.such.key')).toBe('no.such.key')
        expect(t('demo.needsKey')).toBe('Add a model key first')
    })
})

describe('AppHero', () => {
    test('shows the headline, the tagline and a decorative mascot of at least 96px in light and dark', () => {
        for (const mode of ['light', 'dark']) {
            const out = html(mode)
            expect(out).toContain('data-testid="app-hero"')
            expect(out).toContain('<h2')
            expect(out).toContain('Your applications deserve agents.')
            expect(out).toContain('The open-source agent platform for applications.')
            expect(out).toContain('alt=""')
            expect(out).toContain('aria-hidden="true"')
            const width = Number(out.match(/<img[^>]*width="(\d+)"/)[1])
            expect(width).toBeGreaterThanOrEqual(96)
        }
    })

    test('takes the heading element it is given', () => {
        expect(html('light', { component: 'h1', align: 'center' })).toContain('<h1')
    })
})
