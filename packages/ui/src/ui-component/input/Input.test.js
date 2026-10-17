/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
jest.mock('@/ui-component/json/SelectVariable', () => () => null)
jest.mock('@/utils/genericHelper', () => ({ getAvailableNodesForVariable: () => [] }))

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import { Input } from './Input'

const rulesParam = { label: 'Rules', name: 'analystRules', type: 'string', rows: 6, maxLength: 2000 }

describe('Input character counter', () => {
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
            root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(Input, { onChange: () => {}, ...props })))
        })
        return container
    }

    it('shows the length against the cap and stops typing at the cap', async () => {
        const container = await render({ inputParam: rulesParam, value: 'Use monthly_sales for sales by month.' })
        expect(container.querySelector('[data-testid="character-count"]').textContent).toBe('37 / 2,000')
        const field = container.querySelector('textarea[name="analystRules"]')
        expect(field.getAttribute('maxlength')).toBe('2000')
    })

    it('marks a saved value over the cap as an error', async () => {
        const container = await render({ inputParam: rulesParam, value: 'r'.repeat(2001) })
        const counter = container.querySelector('[data-testid="character-count"]')
        expect(counter.textContent).toBe('2,001 / 2,000')
        expect(counter.classList.contains('Mui-error')).toBe(true)
    })

    it('shows no counter on a field without a cap', async () => {
        const container = await render({ inputParam: { label: 'Name', name: 'name', type: 'string' }, value: 'x' })
        expect(container.querySelector('[data-testid="character-count"]')).toBeNull()
        expect(container.querySelector('input[name="name"]').getAttribute('maxlength')).toBeNull()
    })
})
