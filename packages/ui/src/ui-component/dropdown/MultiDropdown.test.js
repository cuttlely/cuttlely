/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
jest.mock('react-redux', () => ({ useSelector: (select) => select({ customization: { isDarkMode: false } }) }))

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'

import { MultiDropdown } from './MultiDropdown'

const options = [
    { label: 'Alpha', name: 'alpha' },
    { label: 'Beta', name: 'beta' }
]

describe('MultiDropdown saved value', () => {
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

    async function render(value) {
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => {
            root.render(createElement(MultiDropdown, { name: 'tools', value, options, onSelect: () => {} }))
        })
        return container
    }

    const chips = (container) => Array.from(container.querySelectorAll('.MuiChip-label')).map((chip) => chip.textContent)

    it.each([' ', '["alpha",', 'null'])('selects nothing for the saved value %p', async (value) => {
        const container = await render(value)
        expect(chips(container)).toEqual([])
    })

    it('selects the saved options from a valid JSON array', async () => {
        const container = await render('["beta","alpha"]')
        expect(chips(container)).toEqual(['Alpha', 'Beta'])
    })
})
