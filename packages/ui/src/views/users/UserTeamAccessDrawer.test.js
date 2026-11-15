/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import { act, fireEvent, render, screen } from '@testing-library/react'
import UserTeamAccessDrawer from './UserTeamAccessDrawer'

const memberships = [
    { workspaceId: 'team-b', workspace: { name: 'Team B' }, role: { name: 'viewer' }, status: 'invited', lastLogin: null },
    { workspaceId: 'team-a', workspace: { name: 'Team A' }, role: { name: 'builder' }, status: 'active', lastLogin: '2026-11-01T12:00:00Z' }
]
const props = (loadAccess) => ({
    userId: 'member-1',
    userName: 'Member',
    organizationId: 'org-1',
    currentTeamId: 'team-a',
    allTeams: true,
    loadAccess,
    onClose: jest.fn()
})

it('shows each team, role, effective status, last login and current-team marker', async () => {
    const load = jest.fn().mockResolvedValue({ data: memberships })
    render(<UserTeamAccessDrawer {...props(load)} />)
    await screen.findByText('Team B')
    expect(load).toHaveBeenCalledWith('org-1', 'member-1')
    for (const text of ['Team A', 'Builder', 'Viewer', 'ACTIVE', 'INVITED', 'Never', 'Current team'])
        expect(screen.getByText(text)).toBeTruthy()
    expect(screen.getByText(/All of this person/)).toBeTruthy()
})

it('guides an owner to switch teams when the target is outside the current team', async () => {
    const load = jest.fn().mockResolvedValue({ data: memberships })
    render(<UserTeamAccessDrawer {...props(load)} currentTeamId='team-c' />)
    await screen.findByText(/switch to one of their teams/)
    expect(screen.queryByText('Current team')).toBeNull()
})

it('discards late results after the viewed user changes', async () => {
    let first
    const load = jest
        .fn()
        .mockReturnValueOnce(
            new Promise((resolve) => {
                first = resolve
            })
        )
        .mockResolvedValue({ data: [memberships[1]] })
    const view = render(<UserTeamAccessDrawer {...props(load)} />)
    await act(async () => {})
    view.rerender(<UserTeamAccessDrawer {...props(load)} userId='member-2' userName='Second member' />)
    await screen.findByText('Team A')
    await act(async () => first({ data: [memberships[0]] }))
    expect(screen.queryByText('Team B')).toBeNull()
    expect(screen.getByText('Second member')).toBeTruthy()
})

it('shows the permitted scope and a retryable error instead of an empty access list', async () => {
    const load = jest
        .fn()
        .mockRejectedValueOnce({ response: { data: { message: 'Could not read memberships.' } } })
        .mockResolvedValue({ data: [] })
    render(<UserTeamAccessDrawer {...props(load)} allTeams={false} />)
    await screen.findByText('Could not read memberships.')
    expect(screen.queryByText('No team assignments in this view.')).toBeNull()
    expect(screen.getByText(/Current team only/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('No team assignments in this view.')
})

it('reloads access after a role edit and protects owner rows from edit actions', async () => {
    const load = jest.fn().mockResolvedValue({ data: [{ ...memberships[1], isOrgOwner: true }] })
    const action = jest.fn(() => <button>Change role</button>)
    const p = props(load)
    const view = render(<UserTeamAccessDrawer {...p} renderRoleAction={action} refreshKey={0} />)
    await screen.findByText('Team A')
    expect(action).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Change role' })).toBeNull()
    load.mockResolvedValue({ data: [{ ...memberships[1], role: { name: 'viewer' } }] })
    view.rerender(<UserTeamAccessDrawer {...p} renderRoleAction={action} refreshKey={1} />)
    await screen.findByText('Viewer')
    expect(action).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(p.onClose).toHaveBeenCalledTimes(1)
})
