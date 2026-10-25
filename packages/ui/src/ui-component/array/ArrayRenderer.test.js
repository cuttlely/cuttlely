/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
jest.mock('@/views/canvas/NodeInputHandler', () => {
    const React = require('react')
    const PropTypes = require('prop-types')
    function MockNodeInput({ inputParam, onCustomDataChange }) {
        return React.createElement(
            'button',
            {
                type: 'button',
                'data-testid': `field-${inputParam.name}`,
                onClick: () => onCustomDataChange({ inputParam, newValue: 'harness' })
            },
            inputParam.name
        )
    }
    MockNodeInput.propTypes = {
        inputParam: PropTypes.object,
        onCustomDataChange: PropTypes.func
    }
    return MockNodeInput
})
jest.mock('@/views/docstore/DocStoreInputHandler', () => () => null)
jest.mock('react-redux', () => ({
    useDispatch: () => global.__arrayDispatch,
    useSelector: (selector) => selector({ customization: { isDarkMode: false } })
}))

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import { SET_DIRTY } from '@/store/actions'
import { ArrayRenderer } from './ArrayRenderer'

const toolParam = {
    label: 'Tools',
    name: 'agentTools',
    type: 'array',
    array: [{ label: 'Tool', name: 'agentSelectedTool', type: 'asyncOptions' }]
}

describe('ArrayRenderer harness row ids', () => {
    let root

    beforeEach(() => {
        global.__arrayDispatch = jest.fn()
    })

    afterEach(async () => {
        if (root) {
            await act(async () => {
                root.unmount()
            })
        }
        root = null
        document.body.innerHTML = ''
    })

    async function render(data) {
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => {
            root.render(
                createElement(ThemeProvider, { theme: createTheme() }, createElement(ArrayRenderer, { inputParam: toolParam, data }))
            )
        })
        return container
    }

    it('writes a stored id when a harness tool is selected in the row', async () => {
        const data = { id: 'agent_0', name: 'agentAgentflow', inputs: { agentTools: [{}] }, inputParams: [] }
        const container = await render(data)
        const field = container.querySelector('[data-testid="field-agentSelectedTool"]')
        await act(async () => {
            field.click()
        })
        expect(data.inputs.agentTools[0].agentSelectedTool).toBe('harness')
        expect(data.inputs.agentTools[0].id).toBe('harness_tool_0')
        expect(global.__arrayDispatch).toHaveBeenCalledWith({ type: SET_DIRTY })
    })
})
