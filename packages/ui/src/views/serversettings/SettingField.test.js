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
})
