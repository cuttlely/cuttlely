/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
import { createElement } from 'react'
import { act, Simulate } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import SettingField from './SettingField'
import ReviewDialog from './ReviewDialog'

const setting = {
    key: 'INBOUND_ACCESS_V2',
    label: 'Access-key enforcement',
    type: 'select',
    section: 'security',
    risk: 'high',
    runtime: true,
    defaultLabel: 'Off',
    defaultValue: 'off',
    options: ['off', 'shadow', 'on'].map((value) => ({ value, label: value })),
    effective: 'off',
    value: '',
    source: 'default',
    locked: false
}
let root
async function render(component, props) {
    if (!root) {
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    }
    await act(async () => root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(component, props))))
}
afterEach(async () => {
    if (root) await act(async () => root.unmount())
    root = null
    document.body.innerHTML = ''
})

it.each(['host', 'panel', 'default'])('displays effective mode and %s source, with host-locked control', async (source) => {
    const onDraft = jest.fn()
    await render(SettingField, {
        setting: { ...setting, source, effective: 'off', value: 'off', locked: source === 'host' },
        drafts: {},
        onDraft
    })
    const label = source === 'host' ? 'host env' : source === 'panel' ? 'admin setting' : 'default'
    expect(document.querySelector('[data-testid="rollout-effective"]').textContent).toContain(`In effect: off (${label})`)
    expect(document.body.textContent).toContain('saved across restarts')
    const select = document.querySelector('[role="combobox"]') || document.querySelector('[aria-haspopup="listbox"]')
    expect(select.getAttribute('aria-disabled') === 'true').toBe(source === 'host')
    if (source === 'host') expect(document.body.textContent).toContain('Set by the host')
    expect(onDraft).not.toHaveBeenCalled()
})

it.each([
    ['off', 'shadow'],
    ['shadow', 'on'],
    ['on', 'shadow'],
    ['shadow', 'off'],
    ['off', 'on'],
    ['on', 'off']
])('requires confirmation for %s to %s with all rollout consequences', async (from, to) => {
    const onSave = jest.fn()
    await render(ReviewDialog, {
        open: true,
        rows: [{ ...setting, from, to }],
        sections: [{ id: 'security', label: 'Security' }],
        saving: false,
        onClose: jest.fn(),
        onSave
    })
    const warning = document.querySelector('[data-testid="rollout-confirmation"]').textContent
    for (const text of [
        'every workspace',
        'compatibility',
        'ASSISTANT',
        '401',
        'Harness names',
        'RPM',
        'quotas',
        'origin',
        'IP',
        'CUTTLELY_API_KEY_INSTANCES=1',
        'returning to Off',
        'host environment is unchanged'
    ])
        expect(warning).toContain(text)
    expect(document.body.textContent).toContain('No restart is needed')
    const save = document.querySelector('[data-testid="review-save"]')
    expect(save.disabled).toBe(true)
    expect(onSave).not.toHaveBeenCalled()
    const input = document.querySelector('[data-testid="review-confirm"]')
    await act(async () => Simulate.change(input, { target: { value: 'APPLY' } }))
    expect(save.disabled).toBe(false)
    await act(async () => save.click())
    expect(onSave).toHaveBeenCalledTimes(1)
})
