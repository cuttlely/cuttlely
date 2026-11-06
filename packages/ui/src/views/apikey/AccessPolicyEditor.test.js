/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import PropTypes from 'prop-types'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import AccessPolicyEditor, { newAccessPolicy } from './AccessPolicyEditor'

function Editor({ privileged = false } = {}) {
    const [policy, setPolicy] = useState(newAccessPolicy)
    const [resources, setResources] = useState([])
    const [expiresAt, setExpiresAt] = useState('2027-02-01T00:00:00.000Z')
    const [confirmed, setConfirmed] = useState(false)
    return (
        <AccessPolicyEditor
            {...{ policy, setPolicy, resources, setResources, expiresAt, setExpiresAt, confirmed, setConfirmed }}
            options={{
                rollout: 'on',
                canGrantAll: privileged,
                scopes: ['predict', 'stream'],
                resources: [{ resourceType: 'CHATFLOW', resourceId: 'fixture', name: 'Bakery' }]
            }}
        />
    )
}
Editor.propTypes = { privileged: PropTypes.bool }
it('starts without resource grants or operations, then previews the explicit choices', () => {
    render(<Editor />)
    expect(screen.getByRole('checkbox', { name: 'predict' }).checked).toBe(false)
    expect(screen.getByRole('checkbox', { name: 'Bakery' }).checked).toBe(false)
    expect(screen.getByText(/This key cannot execute requests yet/)).toBeTruthy()
    expect(screen.queryByLabelText(/All resources in this workspace/)).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'predict' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bakery' }))
    expect(screen.getByText(/Policy preview: 1 operations; 1 selected resources/)).toBeTruthy()
})
it('requires separate confirmation for a privileged all-resources selection', () => {
    render(<Editor privileged />)
    fireEvent.click(screen.getByRole('checkbox', { name: /All resources in this workspace/ }))
    const confirm = screen.getByRole('checkbox', { name: /I confirm this privileged workspace-wide/ })
    expect(confirm.checked).toBe(false)
    fireEvent.click(confirm)
    expect(confirm.checked).toBe(true)
})
it('defaults missing Origin to denial when a website allowlist is added and permits an explicit override', () => {
    render(<Editor />)
    fireEvent.change(screen.getByLabelText(/Allowed origins/), { target: { value: 'https://app.example' } })
    const noOrigin = screen.getByRole('checkbox', { name: /Allow server callers without an Origin/ })
    expect(noOrigin.checked).toBe(false)
    fireEvent.click(noOrigin)
    expect(noOrigin.checked).toBe(true)
})
