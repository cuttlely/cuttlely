/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
jest.mock('@/store/constant', () => ({ REDACTED_CREDENTIAL_VALUE: 'test-blank-placeholder' }))

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { readFileSync } from 'fs'
import { join } from 'path'

import { SensitiveInput } from './SensitiveInput'

describe('SensitiveInput without a reveal action', () => {
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

    async function render(props) {
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => {
            root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(SensitiveInput, props)))
        })
        return container
    }

    it('has no onReveal prop in the component or the credential dialog', () => {
        expect(SensitiveInput.propTypes).not.toHaveProperty('onReveal')
        for (const file of ['SensitiveInput.jsx', '../../views/credentials/CredentialInputHandler.jsx']) {
            expect(readFileSync(join(__dirname, file), 'utf8')).not.toMatch(/onReveal/)
        }
    })

    it('shows a masked URL as text with no reveal button', async () => {
        const value = 'redis://u:\u2022\u2022\u2022\u2022\u2022\u2022@h:6379'
        const container = await render({ inputParam: { name: 'url', type: 'url' }, value, onChange: () => undefined })
        const input = container.querySelector('input')
        expect(input.type).toBe('text')
        expect(input.value).toBe(value)
        expect(container.querySelector('button')).toBeNull()
    })

    it('shows a password as a password input with no reveal button', async () => {
        const container = await render({ inputParam: { name: 'key', type: 'password' }, value: 'x', onChange: () => undefined })
        expect(container.querySelector('input').type).toBe('password')
        expect(container.querySelector('button')).toBeNull()
    })
})
