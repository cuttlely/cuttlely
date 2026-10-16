jest.mock('@/api/flowDrafts', () => ({
    __esModule: true,
    default: { getCheckSetup: jest.fn(), startCheck: jest.fn(), getCheck: jest.fn(), stopCheck: jest.fn() }
}))
jest.mock('@/api/dataset', () => ({ __esModule: true, default: { getAllDatasets: jest.fn() } }))
jest.mock('@/api/evaluators', () => ({ __esModule: true, default: { getAllEvaluators: jest.fn() } }))
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPermission: () => false }) }))
// The theme reads its color tokens from the scss `:export` block, which Jest maps to an empty object.
jest.mock('@/assets/scss/_themes-vars.module.scss', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../../assets/scss/_themes-vars.module.scss'), 'utf8')
    const vars = Object.fromEntries([...source.matchAll(/^\$([\w-]+):\s*([^;]+);/gm)].map(([, name, value]) => [name, value.trim()]))
    const exported = source.slice(source.indexOf(':export'))
    return Object.fromEntries([...exported.matchAll(/^\s*([\w-]+):\s*\$([\w-]+);/gm)].map(([, key, name]) => [key, vars[name]]))
})

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider } from '@mui/material/styles'
import { parseDocument, DomUtils } from 'htmlparser2'
import { is, selectOne } from 'css-select'

import { PublishCheckView } from './PublishCheck'
import appTheme from '@/themes'
import { DARK_ALERT } from '@/themes/compStyleOverride'
import { initialPicks } from '@/utils/publishCheck'

const limits = { maxQuestions: 10, maxQuestionChars: 2000, maxTokens: 100000, maxSeconds: 180 }
const noop = () => {}

const render = (isDarkMode) =>
    renderToStaticMarkup(
        createElement(
            ThemeProvider,
            { theme: appTheme({ isDarkMode, borderRadius: 12, navType: 'light' }) },
            createElement(PublishCheckView, {
                setup: { unavailable: null, questions: [], riskySteps: [{ id: 'p', label: 'Post-processing code' }], limits, check: null },
                loading: false,
                loadError: '',
                list: initialPicks([{ text: 'Hi' }]),
                newQuestion: '',
                addError: '',
                runAnyway: false,
                check: null,
                starting: false,
                error: '',
                onToggle: noop,
                onNewQuestion: noop,
                onAdd: noop,
                onRunAnyway: noop,
                onRun: noop,
                onStop: noop
            })
        )
    )

// Emotion writes each rule as `selector{decls}`; at-rules are skipped because none of these colors sit in one.
const cssRules = (doc) => {
    const text = DomUtils.findAll((node) => node.name === 'style', doc.children)
        .map((node) => DomUtils.textContent(node))
        .join('')
        .replace(/@[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
    const rules = []
    for (const [, selectors, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const color = body
            .split(';')
            .map((decl) => decl.split(':'))
            .filter(([prop]) => prop.trim() === 'color')
            .pop()
        if (color) rules.push({ selectors: selectors.split(','), color: color.slice(1).join(':').trim(), order: rules.length })
    }
    return rules
}

const specificity = (selector) => {
    const plain = selector.replace(/::[\w-]+/g, '')
    return [(plain.match(/#[\w-]+/g) || []).length, (plain.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) || []).length]
}
const beats = (a, b) => a.spec[0] - b.spec[0] || a.spec[1] - b.spec[1] || a.order - b.order

// The color the browser would compute for the element: the winning rule by specificity, then source order,
// and the parent's color when nothing sets it or the winner is `inherit`.
const computedColor = (element, rules) => {
    let winner = null
    for (const rule of rules) {
        for (const selector of rule.selectors) {
            if (/::|:(hover|focus|active|focus-visible|focus-within)\b|:-[\w-]+/.test(selector)) continue
            if (!is(element, selector.trim())) continue
            const candidate = { color: rule.color, spec: specificity(selector), order: rule.order }
            if (!winner || beats(candidate, winner) > 0) winner = candidate
        }
    }
    if (winner && winner.color !== 'inherit') return winner.color
    return element.parent && element.parent.type === 'tag' ? computedColor(element.parent, rules) : null
}

const colorsFor = (isDarkMode) => {
    const doc = parseDocument(render(isDarkMode))
    const rules = cssRules(doc)
    const at = (selector) => computedColor(selectOne(selector, doc), rules)
    return {
        alert: at('[data-testid="check-risky"]'),
        icon: at('[data-testid="check-risky"] .MuiAlert-icon svg'),
        checkbox: at('[data-testid="check-risky"] .MuiCheckbox-root svg')
    }
}

describe('risky-step warning colors', () => {
    test('dark theme: the warning icon is amber and the checkbox uses the warning text color, not white', () => {
        const dark = colorsFor(true)
        expect(dark.icon).toBe(DARK_ALERT.warning.icon)
        expect(dark.checkbox).toBe(DARK_ALERT.warning.text)
        expect(dark.alert).toBe(DARK_ALERT.warning.text)
    })

    test('light theme: the dark Alert colors are not used', () => {
        const light = colorsFor(false)
        expect(light.icon).not.toBe(DARK_ALERT.warning.icon)
        expect(light.alert).not.toBe(DARK_ALERT.warning.text)
    })
})
