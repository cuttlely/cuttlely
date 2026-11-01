/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
// The viewer is replaced by a stand-in that shows the object it was given and keeps its edit handler.
const mockViewer = { props: null }
jest.mock('flowise-react-json-view', () => {
    const { createElement } = require('react')
    return function MockJsonView(props) {
        mockViewer.props = props
        return createElement('pre', { 'data-testid': 'json-src' }, JSON.stringify(mockViewer.props.src))
    }
})
jest.mock('@/ui-component/json/SelectVariable', () => () => null)
jest.mock('@/utils/genericHelper', () => ({ getAvailableNodesForVariable: () => [] }))

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'

import { JsonEditorInput } from './JsonEditor'

describe('JsonEditorInput', () => {
    let root

    afterEach(async () => {
        if (root) {
            await act(async () => {
                root.unmount()
            })
        }
        root = null
        mockViewer.props = null
        document.body.innerHTML = ''
    })

    async function render(props) {
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => {
            root.render(createElement(JsonEditorInput, props))
        })
        return container
    }

    it.each([
        ['undefined', undefined],
        ['an empty string', ''],
        ['a space', ' '],
        ['truncated JSON', '{"a":']
    ])('opens %s as an empty object without writing it back', async (_label, value) => {
        const onChange = jest.fn()
        const container = await render({ value, onChange })
        expect(container.querySelector('[data-testid="json-src"]').textContent).toBe('{}')
        expect(mockViewer.props.src).toEqual({})
        expect(onChange).not.toHaveBeenCalled()
    })

    it('shows the same fallback when read-only', async () => {
        const container = await render({ value: ' ', onChange: jest.fn(), disabled: true })
        expect(container.querySelector('[data-testid="json-src"]').textContent).toBe('{}')
    })

    it('shows valid JSON unchanged and returns the same text after an edit that keeps the value', async () => {
        const value = '{"a":1,"b":{"c":[1,"two",null,true]}}'
        const onChange = jest.fn()
        const container = await render({ value, onChange })
        expect(mockViewer.props.src).toEqual(JSON.parse(value))
        expect(container.querySelector('[data-testid="json-src"]').textContent).toBe(value)
        expect(onChange).not.toHaveBeenCalled()

        await act(async () => {
            mockViewer.props.onEdit({ updated_src: JSON.parse(value) })
        })
        expect(onChange).toHaveBeenCalledWith(value)
    })

    it('writes the edited object after a user edit on a value that opened empty', async () => {
        const onChange = jest.fn()
        await render({ value: '{"a":', onChange })
        await act(async () => {
            mockViewer.props.onEdit({ updated_src: { a: 2 } })
        })
        expect(onChange).toHaveBeenCalledWith('{"a":2}')
        expect(mockViewer.props.src).toEqual({ a: 2 })
    })
})
