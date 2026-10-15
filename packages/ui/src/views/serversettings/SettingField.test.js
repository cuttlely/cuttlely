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
        expect(document.body.textContent).toContain('In effect: 250 (panel)')
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
        expect(document.body.textContent).toContain('In effect: 2000 (env)')
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
        expect(document.body.textContent).toContain('In effect: 1000 (default)')
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
})
