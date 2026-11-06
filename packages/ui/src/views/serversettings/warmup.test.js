/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import SettingField from './SettingField'

it('offers the three warm-up modes and saves the selected mode through the existing settings control', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onDraft = jest.fn()
    const setting = {
        key: 'CUTTLELY_WARM_HERMES',
        label: 'Warm-up mode',
        help: 'Choose the runtime warm-up behavior.',
        type: 'select',
        options: [
            { value: 'false', label: 'Off' },
            { value: 'probe', label: 'Probe periodically' },
            { value: 'true', label: 'Timed full warmup' }
        ],
        defaultValue: 'probe',
        defaultLabel: 'Probe periodically',
        value: '',
        effective: 'probe',
        locked: false
    }
    try {
        await act(async () =>
            root.render(
                createElement(ThemeProvider, { theme: createTheme() }, createElement(SettingField, { setting, drafts: {}, onDraft }))
            )
        )
        expect(container.textContent).toContain('Probe periodically')
        const select = container.querySelector('[role="combobox"]')
        await act(async () => select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })))
        const options = [...document.querySelectorAll('[role="option"]')]
        expect(options.map((option) => option.textContent)).toEqual(
            expect.arrayContaining(['Off', 'Probe periodically', 'Timed full warmup'])
        )
        await act(async () =>
            options.find((option) => option.textContent === 'Timed full warmup').dispatchEvent(new MouseEvent('click', { bubbles: true }))
        )
        expect(onDraft).toHaveBeenCalledWith('CUTTLELY_WARM_HERMES', 'true')
    } finally {
        await act(async () => root.unmount())
        container.remove()
    }
})
