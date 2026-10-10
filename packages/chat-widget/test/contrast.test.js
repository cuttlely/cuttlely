import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { styles } from '../src/styles.js'

function themeVars(selector) {
    const start = styles.indexOf(`${selector} {`)
    const block = styles.slice(start, styles.indexOf('}', start))
    const vars = {}
    for (const m of block.matchAll(/(--dc-[a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) vars[m[1]] = m[2]
    return vars
}

function luminance(hex) {
    const [r, g, b] = [1, 3, 5]
        .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
}

describe('WCAG AA contrast', () => {
    const light = themeVars('.dc')
    const dark = { ...light, ...themeVars('.dc.dark') }
    const pairs = [
        ['--dc-fg', '--dc-bg'],
        ['--dc-fg', '--dc-surface'],
        ['--dc-fg', '--dc-surface-2'],
        ['--dc-muted', '--dc-bg'],
        ['--dc-muted', '--dc-surface'],
        ['--dc-accent-fg', '--dc-accent'],
        ['--dc-fg', '--dc-accent-soft'],
        ['--dc-fg', '--dc-danger-soft'],
        ['--dc-code-fg', '--dc-code-bg']
    ]
    for (const [name, vars] of [
        ['light', light],
        ['dark', dark]
    ]) {
        for (const [fg, bg] of pairs) {
            it(`${name}: ${fg} on ${bg} is at least 4.5:1`, () => {
                assert.ok(vars[fg] && vars[bg], `missing ${fg} or ${bg}`)
                const r = ratio(vars[fg], vars[bg])
                assert.ok(r >= 4.5, `${vars[fg]} on ${vars[bg]} is ${r.toFixed(2)}:1`)
            })
        }
    }
})
