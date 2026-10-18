/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
let mockEditorChange = () => {}
jest.mock('@/ui-component/editor/CodeEditor', () => ({
    CodeEditor: ({ value, onValueChange }) => {
        mockEditorChange = onValueChange
        return require('react').createElement('textarea', { 'data-testid': 'editor', value, readOnly: true })
    }
}))
jest.mock(
    'react-perfect-scrollbar',
    () =>
        ({ children }) =>
            children
)
jest.mock('@/ui-component/button/RBACButtons', () => ({ PermissionLoadingButton: () => null }))
jest.mock('@/ui-component/json/SelectVariable', () => () => null)
jest.mock('@/utils/genericHelper', () => ({ getAvailableNodesForVariable: () => [] }))
jest.mock('@/api/nodes', () => ({ __esModule: true, default: { executeCustomFunctionNode: jest.fn() } }))
jest.mock('@/hooks/useApi', () => () => ({ request: jest.fn(), loading: false, data: null, error: null }))
jest.mock('react-redux', () => ({ useDispatch: () => () => {}, useSelector: () => ({ isDarkMode: false }) }))

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import ExpandTextDialog from './ExpandTextDialog'

const rulesParam = { label: 'Rules', name: 'analystRules', type: 'string', rows: 6, maxLength: 2000 }

describe('Expand editor on a capped field', () => {
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

    async function render(dialogProps, onConfirm) {
        const portal = document.createElement('div')
        portal.id = 'portal'
        document.body.appendChild(portal)
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => {
            root.render(
                createElement(
                    ThemeProvider,
                    { theme: createTheme() },
                    createElement(ExpandTextDialog, {
                        show: true,
                        dialogProps: { cancelButtonName: 'Cancel', confirmButtonName: 'Save', ...dialogProps },
                        onCancel: () => {},
                        onConfirm
                    })
                )
            )
        })
    }

    const saveButton = () => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Save')
    const counter = () => document.querySelector('[data-testid="character-count"]')

    async function type(text) {
        await act(async () => {
            mockEditorChange(text)
        })
    }

    it('turns Save off while the text is over the cap and back on at the cap', async () => {
        const onConfirm = jest.fn()
        await render({ value: 'r'.repeat(2000), inputParam: rulesParam }, onConfirm)
        expect(counter().textContent).toBe('2,000 / 2,000')
        expect(saveButton().disabled).toBe(false)

        await type('r'.repeat(2001))
        expect(counter().textContent).toBe('2,001 / 2,000')
        expect(counter().classList.contains('Mui-error')).toBe(true)
        expect(saveButton().disabled).toBe(true)
        await act(async () => {
            saveButton().click()
        })
        expect(onConfirm).not.toHaveBeenCalled()

        await type('r'.repeat(1999))
        expect(saveButton().disabled).toBe(false)
        await act(async () => {
            saveButton().click()
        })
        expect(onConfirm).toHaveBeenCalledWith('r'.repeat(1999), 'analystRules')
    })

    it('opens a saved value over the cap with Save off', async () => {
        await render({ value: 'r'.repeat(2400), inputParam: rulesParam }, jest.fn())
        expect(counter().textContent).toBe('2,400 / 2,000')
        expect(saveButton().disabled).toBe(true)
    })

    it('keeps Save on and shows no counter for a field without a cap', async () => {
        await render({ value: 'x'.repeat(5000), inputParam: { label: 'Instructions', name: 'instructions', type: 'string' } }, jest.fn())
        expect(counter()).toBeNull()
        expect(saveButton().disabled).toBe(false)
    })
})
