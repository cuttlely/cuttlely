import componentStyleOverrides, {
    DARK_ALERT,
    DARK_DISABLED_FILL,
    DARK_DISABLED_LABEL,
    DARK_TOGGLE_LABEL,
    LIGHT_DISABLED_FILL,
    LIGHT_DISABLED_LABEL
} from './compStyleOverride'
import themePalette from './palette'
import { readFileSync } from 'fs'
import path from 'path'

const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
}
const buttonRoot = (isDarkMode) => componentStyleOverrides({ customization: { isDarkMode }, colors: {} }).MuiButton.styleOverrides.root

describe('disabled buttons', () => {
    test('dark theme: the label reads at 4.5:1 or better on the disabled fill and on the dark paper', () => {
        expect(contrast(DARK_DISABLED_LABEL, DARK_DISABLED_FILL)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(DARK_DISABLED_LABEL, '#191b1f')).toBeGreaterThanOrEqual(4.5)
    })

    test('light theme: the label reads at 4.5:1 or better on the disabled fill and on the light page backgrounds', () => {
        expect(contrast(LIGHT_DISABLED_LABEL, LIGHT_DISABLED_FILL)).toBeGreaterThanOrEqual(4.5)
        for (const page of ['#ffffff', '#fafafa', '#efeafe']) {
            expect(contrast(LIGHT_DISABLED_LABEL, page)).toBeGreaterThanOrEqual(4.5)
        }
    })

    test('each theme uses its own disabled colors', () => {
        const dark = buttonRoot(true)
        const light = buttonRoot(false)
        expect(dark['&.Mui-disabled']).toEqual({ color: DARK_DISABLED_LABEL })
        expect(dark['&.MuiButton-contained.Mui-disabled']).toEqual({ backgroundColor: DARK_DISABLED_FILL })
        expect(light['&.Mui-disabled']).toEqual({ color: LIGHT_DISABLED_LABEL })
        expect(light['&.MuiButton-contained.Mui-disabled']).toEqual({ backgroundColor: LIGHT_DISABLED_FILL })
    })
})

describe('Cuttle Violet primary', () => {
    const LIGHT_MAIN = '#6a3df2'
    const DARK_MAIN = '#a78bfa'
    const DARK_HOVER = '#9470f7'
    const INK = '#0a0d1e'

    test('light theme: violet text and links on white and the light pages, and white on violet buttons, pass AA', () => {
        for (const page of ['#ffffff', '#fafafa', '#f5f8fe', '#efeafe']) {
            expect(contrast(LIGHT_MAIN, page)).toBeGreaterThanOrEqual(4.5)
        }
        expect(contrast('#ffffff', LIGHT_MAIN)).toBeGreaterThanOrEqual(4.5)
        expect(contrast('#ffffff', '#4c26ce')).toBeGreaterThanOrEqual(4.5)
    })

    test('dark theme: the lighter violet passes AA on the dark surfaces, and Ink labels pass AA on it and on its hover', () => {
        for (const surface of ['#191b1f', '#23262c', '#32353b']) {
            expect(contrast(DARK_MAIN, surface)).toBeGreaterThanOrEqual(4.5)
        }
        expect(contrast(INK, DARK_MAIN)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(INK, DARK_HOVER)).toBeGreaterThanOrEqual(5)
        expect(contrast('#ffffff', '#352a66')).toBeGreaterThanOrEqual(4.5)
    })

    test('dark theme: filled violet buttons hover to the theme variable that the Ink check above uses', () => {
        const scss = readFileSync(path.join(__dirname, '../assets/scss/_themes-vars.module.scss'), 'utf8')
        expect(scss).toMatch(new RegExp(`^\\$darkPrimaryAccentHover: ${DARK_HOVER};`, 'm'))
        const dark = componentStyleOverrides({ customization: { isDarkMode: true }, colors: { darkPrimaryAccentHover: DARK_HOVER } })
        expect(dark.MuiButton.styleOverrides.containedPrimary['&:hover'].backgroundColor).toBe(DARK_HOVER)
    })

    test('the palette uses Cuttle Violet on light and the lighter violet with Ink labels on dark', () => {
        const colors = { primaryMain: LIGHT_MAIN, darkPrimaryAccent: DARK_MAIN, darkPrimaryContrast: INK, paper: '#ffffff' }
        const light = themePalette({ customization: { isDarkMode: false }, colors })
        const dark = themePalette({ customization: { isDarkMode: true }, colors })
        expect(light.primary.main).toBe(LIGHT_MAIN)
        expect(light.primary.contrastText).toBe('#ffffff')
        expect(dark.primary.main).toBe(DARK_MAIN)
        expect(dark.primary.contrastText).toBe(INK)
    })
})

describe('dark Alerts', () => {
    const blend = (rgba, under) => {
        const [r, g, b, a] = rgba.match(/[\d.]+/g).map(Number)
        const base = [1, 3, 5].map((i) => parseInt(under.slice(i, i + 2), 16))
        return (
            '#' +
            [r, g, b]
                .map((c, i) =>
                    Math.round(c * a + base[i] * (1 - a))
                        .toString(16)
                        .padStart(2, '0')
                )
                .join('')
        )
    }

    test('error, warning, info and success each get their own text, fill, border and icon color on dark only', () => {
        const dark = componentStyleOverrides({ customization: { isDarkMode: true }, colors: {} }).MuiAlert.styleOverrides
        const light = componentStyleOverrides({ customization: { isDarkMode: false }, colors: {} }).MuiAlert.styleOverrides
        for (const severity of ['error', 'warning', 'info', 'success']) {
            const key = `standard${severity[0].toUpperCase()}${severity.slice(1)}`
            expect(dark[key]).toEqual({
                color: DARK_ALERT[severity].text,
                backgroundColor: DARK_ALERT[severity].fill,
                border: `1px solid ${DARK_ALERT[severity].border}`,
                '& .MuiAlert-icon': { color: DARK_ALERT[severity].icon }
            })
            expect(light[key]).toBeUndefined()
        }
    })

    test('dark Alert text reads at 4.5:1 or better on its fill over the dark surfaces', () => {
        for (const { text, fill } of Object.values(DARK_ALERT)) {
            for (const surface of ['#191b1f', '#23262c']) {
                expect(contrast(text, blend(fill, surface))).toBeGreaterThanOrEqual(4.5)
            }
        }
    })

    test('dark theme: an icon inside an Alert does not keep the white SvgIcon color', () => {
        const root = componentStyleOverrides({ customization: { isDarkMode: true }, colors: { paper: '#ffffff' } }).MuiSvgIcon
            .styleOverrides.root
        expect(root.color).toBe('#ffffff')
        expect(root['.MuiAlert-standardWarning .MuiAlert-icon &']).toEqual({ color: DARK_ALERT.warning.icon })
        expect(root['.MuiAlert-standardError .MuiAlert-icon &']).toEqual({ color: DARK_ALERT.error.icon })
        expect(root['.MuiAlert-standardInfo .MuiAlert-icon &']).toEqual({ color: DARK_ALERT.info.icon })
        expect(root['.MuiAlert-standardWarning .MuiCheckbox-root &']).toEqual({ color: DARK_ALERT.warning.text })
    })
})

describe('toggle buttons', () => {
    const toggleRoot = (isDarkMode) =>
        componentStyleOverrides({ customization: { isDarkMode }, colors: { primaryMain: '#6a3df2', darkPrimaryAccent: '#a78bfa' } })
            .MuiToggleButton.styleOverrides.root

    test('dark theme: an unselected label reads at 4.5:1 or better on the dark page and on its hover fill', () => {
        expect(toggleRoot(true).color).toBe(DARK_TOGGLE_LABEL)
        for (const surface of ['#191b1f', '#222428', '#23262c']) {
            expect(contrast(DARK_TOGGLE_LABEL, surface)).toBeGreaterThanOrEqual(4.5)
        }
    })

    test('light theme keeps the MUI label color', () => {
        expect(toggleRoot(false).color).toBeUndefined()
    })

    test('keyboard focus draws a violet outline in each theme', () => {
        expect(toggleRoot(true)['&.Mui-focusVisible'].outline).toBe('2px solid #a78bfa')
        expect(toggleRoot(false)['&.Mui-focusVisible'].outline).toBe('2px solid #6a3df2')
    })
})
