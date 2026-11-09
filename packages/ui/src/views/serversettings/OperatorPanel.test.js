/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import OperatorPanel from './OperatorPanel'
import serverSettingsApi from '@/api/serverSettings'

jest.mock('@/api/serverSettings', () => ({ __esModule: true, default: { getOperator: jest.fn(), operatorAction: jest.fn() } }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root, container
async function render(status) {
    serverSettingsApi.getOperator.mockResolvedValue({ data: status })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(createElement(OperatorPanel, { onChanged: jest.fn() })))
}
afterEach(async () => {
    if (root) await act(async () => root.unmount())
    document.body.innerHTML = ''
    jest.clearAllMocks()
})

test('ordinary owners with no proof capability never mount management controls', async () => {
    await render({ state: 'Active', proofPurpose: null })
    expect(container.textContent).toBe('')
    expect(container.querySelector('button')).toBeNull()
})
test('Unclaimed asks for host-log proof with explicit typed confirmation and no secret from the response', async () => {
    await render({ state: 'Unclaimed', proofPurpose: 'claim' })
    const request = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Request host-log code')
    expect(request.disabled).toBe(true)
    const input = container.querySelector('input')
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'CLAIM')
        input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    serverSettingsApi.operatorAction.mockResolvedValue({ data: { requested: true, message: 'Read the code from the host log.' } })
    await act(async () => request.click())
    expect(serverSettingsApi.operatorAction).toHaveBeenCalledWith(
        'request',
        expect.objectContaining({ purpose: 'claim', confirm: 'CLAIM', code: '' })
    )
    expect(container.textContent).toContain('Read the code from the host log.')
    expect(container.querySelector('input[type="password"]').value).toBe('')
    expect(container.textContent).not.toContain('Transfer to another active owner')
})
test('Disabled requires RECOVER and never offers an ordinary claim', async () => {
    await render({ state: 'Disabled', proofPurpose: 'recover', proofPending: true })
    expect(container.textContent).toContain('Type RECOVER')
    expect(container.textContent).not.toContain('Type CLAIM')
    expect(container.querySelector('input[type="password"]')).not.toBeNull()
})
test('operator sees source and management; env source is immutable', async () => {
    await render({ operator: { userId: 'owner', source: 'host environment' }, mutable: false, owners: [] })
    expect(container.textContent).toContain('Current operator: owner. Source: host environment.')
    expect(container.textContent).toContain('Panel changes are disabled')
    expect(container.textContent).not.toContain('Operator action')
})
