import { canChangeRole } from '@/utils/roleLabel'
import {
    canRemoveOrganizationUser,
    canChangeUserAccess,
    isUserDisabled,
    accessConfirmation,
    isPendingOwnerInvite,
    isPendingInvite,
    organizationOwnerLabel,
    removalConfirmation,
    removeOrganizationUser
} from './userActions'
import userApi from '@/api/user'
import client from '@/api/client'

jest.mock('@/api/client', () => ({ delete: jest.fn() }))

const pending = {
    organizationId: 'org-1',
    userId: 'invited-owner',
    isOrgOwner: true,
    status: 'INVITED',
    user: { id: 'invited-owner', name: 'Pending', email: 'pending@example.com', status: 'invited' }
}

describe('local user access actions', () => {
    const active = { ...pending, userId: 'member', isOrgOwner: false, status: 'active', user: { ...pending.user, status: 'active' } }
    it('protects self, owner and pending accounts while allowing active local members', () => {
        expect(canChangeUserAccess(active, 'owner')).toBe(true)
        expect(canChangeUserAccess(active, 'member')).toBe(false)
        expect(canChangeUserAccess({ ...active, isOrgOwner: true }, 'owner')).toBe(false)
        expect(canChangeUserAccess({ ...active, status: 'invited', user: { status: 'invited' } }, 'owner')).toBe(false)
        expect(canChangeUserAccess(null, 'owner')).toBe(false)
        expect(accessConfirmation(active).confirmButtonName).toBe('Disable user')
    })
    it.each(['disable', 'disabled', 'inactive'])(
        'allows reactivation for status %s and keeps its warning about revoked access',
        (status) => {
            const row = { ...active, status }
            expect(isUserDisabled(row)).toBe(true)
            expect(canChangeUserAccess(row, 'owner')).toBe(true)
            expect(accessConfirmation(row)).toMatchObject({
                confirmButtonName: 'Reactivate user',
                description: expect.stringContaining('not restored')
            })
        }
    )
})

describe('User Management owner invitation actions', () => {
    it('allows another pending owner invitation to be canceled without opening Change role', () => {
        expect(isPendingOwnerInvite(pending)).toBe(true)
        expect(canRemoveOrganizationUser(pending, 'owner-1')).toBe(true)
        expect(canChangeRole(pending, 'owner-1')).toBe(false)
        expect(organizationOwnerLabel(pending, true)).toBe('Owner invitation pending')
        expect(organizationOwnerLabel(pending, false)).toBe('Owner invitation pending')
    })

    it.each(['active', 'inactive', 'disable', 'pending', '', undefined])('hides trash and Change role for owner status %s', (status) => {
        const row = { ...pending, status, user: { ...pending.user, status } }
        expect(canRemoveOrganizationUser(row, 'owner-1')).toBe(false)
        expect(canChangeRole(row, 'owner-1')).toBe(false)
    })

    it('keeps only active OSS owners labeled Super User, read-only', () => {
        const active = { ...pending, status: 'active', user: { ...pending.user, status: 'active' } }
        expect(organizationOwnerLabel(active, true)).toBe('Super User, read-only')
        expect(organizationOwnerLabel(active, false)).toBe('ORGANIZATION OWNER')
        expect(organizationOwnerLabel({ ...active, user: { status: 'disable' } }, true)).toBe('ORGANIZATION OWNER')
        // Pending is decided from user.status (the column invitationOnly checks), not org-row status alone.
        expect(organizationOwnerLabel({ ...pending, status: undefined }, true)).toBe('Owner invitation pending')
        expect(isPendingOwnerInvite({ ...pending, status: 'ACTIVE', user: { ...pending.user, status: 'invited' } })).toBe(true)
        expect(isPendingOwnerInvite({ ...pending, status: 'INVITED', user: { ...pending.user, status: 'active' } })).toBe(false)
    })

    it('hides trash for self, including an invited row, and missing ids', () => {
        expect(canRemoveOrganizationUser(pending, pending.userId)).toBe(false)
        expect(canRemoveOrganizationUser({ ...pending, isOrgOwner: false }, pending.userId)).toBe(false)
        expect(canRemoveOrganizationUser({ ...pending, userId: '' }, 'owner-1')).toBe(false)
        expect(canRemoveOrganizationUser(null, 'owner-1')).toBe(false)
    })

    it('names the pending invitation, email and link revocation in its confirmation', () => {
        expect(removalConfirmation(pending)).toEqual({
            title: 'Cancel pending owner invitation',
            description: 'Cancel the pending owner invitation for pending@example.com? This revokes their invite links.',
            confirmButtonName: 'Cancel invitation',
            cancelButtonName: 'Keep invitation'
        })
    })

    it('keeps ordinary member deletion and role editing unchanged', () => {
        const row = { ...pending, isOrgOwner: false, status: 'active', user: { ...pending.user, status: 'active' } }
        expect(canRemoveOrganizationUser(row, 'owner-1')).toBe(true)
        expect(canChangeRole(row, 'owner-1')).toBe(true)
        expect(removalConfirmation(row)).toMatchObject({ title: 'Delete', confirmButtonName: 'Delete' })
    })

    it('sends a conditional invitation cancellation for the selected organization and user ids', () => {
        userApi.deleteOrganizationUser(pending.organizationId, pending.userId, true)
        expect(client.delete).toHaveBeenLastCalledWith('/organizationuser?organizationId=org-1&userId=invited-owner&invitationOnly=true')
        userApi.deleteOrganizationUser('org-1', 'member-1')
        expect(client.delete).toHaveBeenLastCalledWith('/organizationuser?organizationId=org-1&userId=member-1')
    })
})

it('refreshes a stale pending invitation before returning a definitive conflict to the UI', async () => {
    const conflict = { response: { status: 409, data: { message: 'This invitation is no longer pending.' } } }
    client.delete.mockRejectedValueOnce(conflict)
    const refresh = jest.fn()
    await expect(removeOrganizationUser(pending, refresh, userApi.deleteOrganizationUser)).rejects.toBe(conflict)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(client.delete).toHaveBeenLastCalledWith('/organizationuser?organizationId=org-1&userId=invited-owner&invitationOnly=true')
})

it('cancels an ordinary pending invitation with the same acceptance-race guard as an owner invite', async () => {
    const row = { ...pending, isOrgOwner: false }
    expect(isPendingInvite(row)).toBe(true)
    expect(removalConfirmation(row)).toMatchObject({ title: 'Cancel invitation' })
    const remove = jest.fn().mockResolvedValue({ data: { id: row.userId } })
    await removeOrganizationUser(row, jest.fn(), remove)
    expect(remove).toHaveBeenCalledWith(row.organizationId, row.userId, true)
})
