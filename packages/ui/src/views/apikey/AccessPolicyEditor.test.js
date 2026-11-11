/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import PropTypes from 'prop-types'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import AccessPolicyEditor, { newAccessPolicy } from './AccessPolicyEditor'

function Editor({ privileged = false, initialResources = [] } = {}) {
    const [policy, setPolicy] = useState(newAccessPolicy)
    const [resources, setResources] = useState(initialResources)
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
Editor.propTypes = { privileged: PropTypes.bool, initialResources: PropTypes.array }
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
it('shows an unavailable grant as remove-only and matches resource type as well as ID', () => {
    render(
        <Editor
            initialResources={[
                { resourceType: 'AGENTFLOW', resourceId: 'fixture' },
                { resourceType: 'CHATFLOW', resourceId: 'fixture' }
            ]}
        />
    )
    expect(screen.getByRole('checkbox', { name: 'Bakery' }).checked).toBe(true)
    expect(screen.getByText(/Unavailable resource: AGENTFLOW fixture/)).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: /AGENTFLOW fixture/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove unavailable AGENTFLOW fixture' }))
    expect(screen.queryByRole('button', { name: /Remove unavailable/ })).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'Bakery' }).checked).toBe(true)
    expect(screen.getByText(/1 selected resources/)).toBeTruthy()
})

it('retains duration choices and shows Custom after a manual expiry edit', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-09T12:00:00.000Z'))
    try {
        render(<Editor />)
        const duration = screen.getByLabelText('Duration preset')
        const expiry = screen.getByLabelText('Expires at (UTC)')
        expect(duration.textContent).toBe('Custom')
        for (const days of [30, 90]) {
            fireEvent.mouseDown(duration)
            fireEvent.click(screen.getByRole('option', { name: `${days} days` }))
            expect(duration.textContent).toBe(`${days} days`)
            expect(expiry.value).toBe(new Date(Date.now() + days * 86400000).toISOString())
        }
        fireEvent.change(expiry, { target: { value: '2027-06-01T00:00:00.000Z' } })
        expect(duration.textContent).toBe('Custom')
        expect(expiry.value).toBe('2027-06-01T00:00:00.000Z')
        fireEvent.mouseDown(duration)
        fireEvent.click(screen.getByRole('option', { name: 'No expiry' }))
        expect(duration.textContent).toBe('No expiry')
        expect(expiry.value).toBe('')
        fireEvent.change(expiry, { target: { value: '2027-06-02T00:00:00.000Z' } })
        expect(duration.textContent).toBe('Custom')
        fireEvent.change(expiry, { target: { value: '' } })
        expect(duration.textContent).toBe('No expiry')
    } finally {
        jest.useRealTimers()
    }
})
