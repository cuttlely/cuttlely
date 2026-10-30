/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import SettingField from './SettingField'

const bounded = {
    key: 'CUTTLELY_CHECK_COUNT_DEFAULT',
    label: 'Questions by default',
    help: 'How many past questions a check asks when the caller does not choose.',
    type: 'number',
    unit: 'count',
    min: 1,
    max: 1,
    defaultLabel: '4',
    defaultValue: '4',
    value: '1',
    effective: '1',
    source: 'bounded',
    boundedBy: 'CUTTLELY_CHECK_COUNT_MAX',
    locked: false
}

function expectOneHistoryKeep(text) {
    const nodes = document.querySelectorAll('[data-testid="history-keep-source"]')
    expect(nodes).toHaveLength(1)
    expect(nodes[0].textContent).toBe(text)
    expect(document.body.textContent.match(/In effect/g)).toEqual(['In effect'])
}

describe('SettingField', () => {
    let root

    afterEach(async () => {
        if (root) {
            await act(async () => {
                root.unmount()
            })
        }
        root = null
        document.body.innerHTML = ''
    })

    it('shows which host limit bounded the value, and leaves the field editable', async () => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => {
            root.render(
                createElement(
                    ThemeProvider,
                    { theme: createTheme() },
                    createElement(SettingField, { setting: bounded, drafts: {}, onDraft: () => {} })
                )
            )
        })
        expect(document.body.textContent).toContain('Limited by CUTTLELY_CHECK_COUNT_MAX')
        expect(document.body.textContent).not.toContain('Locked')
        const input = document.querySelector('[data-testid="setting-CUTTLELY_CHECK_COUNT_DEFAULT"] input')
        expect(input).toBeTruthy()
        expect(input.disabled).toBe(false)
        expect(input.value).toBe('1')
    })

    it('shows the history cap in effect and whether it came from the panel, the environment, or the default', async () => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        const setting = {
            key: 'CUTTLELY_HISTORY_KEEP',
            label: 'Settings changes to keep',
            help: 'How many settings changes to keep.',
            type: 'number',
            unit: 'count',
            min: 100,
            max: 10000,
            defaultLabel: '1000',
            defaultValue: '1000',
            value: '250',
            effective: '250',
            source: 'panel',
            locked: false,
            runtime: true,
            section: 'security',
            group: 'History'
        }
        await act(async () => {
            root.render(
                createElement(
                    ThemeProvider,
                    { theme: createTheme() },
                    createElement(SettingField, { setting, drafts: {}, onDraft: () => {} })
                )
            )
        })
        expectOneHistoryKeep('In effect: 250 (panel)')
        expect(document.querySelector('[data-testid="setting-CUTTLELY_HISTORY_KEEP"] input').disabled).toBe(false)
        setting.source = 'host'
        setting.effective = '2000'
        setting.value = '2000'
        await act(async () => {
            root.render(
                createElement(
                    ThemeProvider,
                    { theme: createTheme() },
                    createElement(SettingField, { setting, drafts: {}, onDraft: () => {} })
                )
            )
        })
        expectOneHistoryKeep('In effect: 2000 (env)')
        setting.source = 'default'
        setting.effective = '1000'
        setting.value = ''
        await act(async () => {
            root.render(
                createElement(
                    ThemeProvider,
                    { theme: createTheme() },
                    createElement(SettingField, { setting, drafts: {}, onDraft: () => {} })
                )
            )
        })
        expectOneHistoryKeep('In effect: 1000 (default)')
    })

    it('uses the live range for the number input, so a host cap of 1 sets max to 1', async () => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        const setting = {
            ...bounded,
            min: 1,
            max: 500,
            range: { min: 1, max: 1 },
            runtime: true
        }
        await act(async () => {
            root.render(
                createElement(
                    ThemeProvider,
                    { theme: createTheme() },
                    createElement(SettingField, { setting, drafts: {}, onDraft: () => {} })
                )
            )
        })
        const input = document.querySelector('[data-testid="setting-CUTTLELY_CHECK_COUNT_DEFAULT"] input')
        expect(input.max).toBe('1')
        expect(input.min).toBe('1')
        await act(async () => {
            root.render(
                createElement(
                    ThemeProvider,
                    { theme: createTheme() },
                    createElement(SettingField, {
                        setting: { ...setting, range: undefined, min: 1, max: 500 },
                        drafts: {},
                        onDraft: () => {}
                    })
                )
            )
        })
        const fallback = document.querySelector('[data-testid="setting-CUTTLELY_CHECK_COUNT_DEFAULT"] input')
        expect(fallback.max).toBe('500')
        expect(fallback.min).toBe('1')
    })

    it('shows a lock and Set by the host on a testing limit the host set', async () => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        const setting = {
            ...bounded,
            section: 'testing',
            unit: 'seconds',
            runtime: true,
            locked: true,
            range: { min: 10, max: 1800 },
            value: '90',
            effective: '90'
        }
        await act(async () => {
            root.render(
                createElement(
                    ThemeProvider,
                    { theme: createTheme() },
                    createElement(SettingField, { setting, drafts: {}, onDraft: () => {} })
                )
            )
        })
        expect(document.body.textContent).toContain('Set by the host')
        expect(document.querySelector('[data-testid="lock-CUTTLELY_CHECK_COUNT_DEFAULT"]')).toBeTruthy()
        expect(document.body.textContent).toContain('Range: 10 to 1800 seconds')
        const input = document.querySelector('[data-testid="setting-CUTTLELY_CHECK_COUNT_DEFAULT"] input')
        expect(input.disabled).toBe(true)
    })

    it('offers No limit and a typed limit for trace text, and shows the server refusal', async () => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        const setting = {
            key: 'CUTTLELY_OTEL_TRACES_CONTENT_MAX',
            label: 'Prompt and tool text limit',
            help: 'Sensitive. No limit (stored as 0) sends the full question and answer text to your collector.',
            type: 'select',
            options: [{ value: '0', label: 'No limit' }],
            custom: { label: 'Another limit', placeholder: '20000' },
            defaultLabel: '4,000 characters',
            defaultValue: '4000',
            value: '',
            effective: '4000',
            locked: false
        }
        const onDraft = jest.fn()
        const render = async (drafts, error) => {
            await act(async () => {
                root.render(
                    createElement(ThemeProvider, { theme: createTheme() }, createElement(SettingField, { setting, drafts, onDraft, error }))
                )
            })
        }

        await render({ CUTTLELY_OTEL_TRACES_CONTENT_MAX: '0' })
        const field = () => document.querySelector('[data-testid="setting-CUTTLELY_OTEL_TRACES_CONTENT_MAX"]')
        expect(field().textContent).toContain('No limit')
        expect(document.querySelector('input[aria-label="Prompt and tool text limit, Another limit"]')).toBeNull()

        await act(async () => {
            root.unmount()
        })
        root = createRoot(container)
        await render({ CUTTLELY_OTEL_TRACES_CONTENT_MAX: '20000' })
        const typed = document.querySelector('input[aria-label="Prompt and tool text limit, Another limit"]')
        expect(typed.value).toBe('20000')
        expect(typed.placeholder).toBe('20000')

        await render({ CUTTLELY_OTEL_TRACES_CONTENT_MAX: '4000' })
        expect(typed.value).toBe('4000')

        const refusal = 'Prompt and tool text limit: enter a whole number of characters greater than 0, or choose No limit.'
        await render({ CUTTLELY_OTEL_TRACES_CONTENT_MAX: 'lots' }, refusal)
        expect(field().textContent).toContain(refusal)
    })

    it('shows a saved trace text limit of 4000 as the Default item, not as Another limit', async () => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        const setting = {
            key: 'CUTTLELY_OTEL_TRACES_CONTENT_MAX',
            label: 'Prompt and tool text limit',
            help: 'Sensitive.',
            type: 'select',
            options: [{ value: '0', label: 'No limit' }],
            custom: { label: 'Another limit', placeholder: '20000' },
            defaultLabel: '4,000 characters',
            defaultValue: '4000',
            value: '4000',
            effective: '4000',
            source: 'panel',
            locked: false
        }
        await act(async () => {
            root.render(
                createElement(
                    ThemeProvider,
                    { theme: createTheme() },
                    createElement(SettingField, { setting, drafts: {}, onDraft: () => {} })
                )
            )
        })
        const field = document.querySelector('[data-testid="setting-CUTTLELY_OTEL_TRACES_CONTENT_MAX"]')
        expect(field.textContent).toContain('Default (4,000 characters)')
        expect(field.textContent).not.toContain('Another limit')
        expect(document.querySelector('input[aria-label="Prompt and tool text limit, Another limit"]')).toBeNull()
    })

    it('labels 0 as Unlimited with a strong warning, warns above 25, and says nothing at 10', async () => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        const setting = {
            key: 'CUTTLELY_HERMES_MAX_CONCURRENT_RUNS',
            label: 'Maximum concurrent agent runs',
            help: 'How many agent runs at once.',
            type: 'number',
            integer: true,
            min: 0,
            max: 50,
            defaultLabel: '10',
            defaultValue: '10',
            zeroLabel: 'Unlimited',
            warnings: {
                zero: 'Unlimited can use all the memory and CPU.',
                above: { value: 25, message: 'More than 25 uses more memory and CPU.' }
            },
            value: '',
            effective: '10',
            source: 'default',
            locked: false,
            changed: false,
            section: 'runtime',
            group: 'Limits'
        }
        const show = async (drafts) => {
            await act(async () => {
                root.render(
                    createElement(
                        ThemeProvider,
                        { theme: createTheme() },
                        createElement(SettingField, { setting, drafts, onDraft: () => {} })
                    )
                )
            })
        }
        const warn = () => document.querySelector('[data-testid="warn-CUTTLELY_HERMES_MAX_CONCURRENT_RUNS"]')
        const zero = () => document.querySelector('[data-testid="zero-CUTTLELY_HERMES_MAX_CONCURRENT_RUNS"]')
        await show({})
        expect(warn()).toBeNull()
        expect(zero()).toBeNull()
        await show({ CUTTLELY_HERMES_MAX_CONCURRENT_RUNS: '0' })
        expect(zero().textContent).toBe('0 = Unlimited')
        expect(warn().textContent).toContain('Unlimited can use all the memory and CPU.')
        expect(warn().getAttribute('data-strong')).toBe('true')
        expect(warn().className).toMatch(/Error/)
        await show({ CUTTLELY_HERMES_MAX_CONCURRENT_RUNS: '26' })
        expect(zero()).toBeNull()
        expect(warn().textContent).toContain('More than 25 uses more memory and CPU.')
        expect(warn().getAttribute('data-strong')).toBe('false')
        await show({ CUTTLELY_HERMES_MAX_CONCURRENT_RUNS: '25' })
        expect(warn()).toBeNull()
    })
})
