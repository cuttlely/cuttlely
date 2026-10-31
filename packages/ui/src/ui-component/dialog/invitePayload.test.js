import { invitationPayload } from './invitePayload'

describe('user invitation dialog requests', () => {
    it('asks for the Local invitation link shown by the create-user dialog', () => {
        const request = invitationPayload({
            name: 'Ada Lovelace',
            email: 'ada@example.com',
            createdBy: 'owner-1',
            workspaceId: 'team-1',
            roleId: 'role-1',
            link: true
        })

        expect(request).toEqual({
            user: { name: 'Ada Lovelace', email: 'ada@example.com', createdBy: 'owner-1' },
            workspace: { id: 'team-1' },
            role: { id: 'role-1' },
            link: true
        })
    })

    it('lets the multi-user dialog use the active-method delivery default', () => {
        const request = invitationPayload({
            email: 'grace@example.com',
            createdBy: 'owner-1',
            workspaceId: 'team-1',
            roleId: 'role-1'
        })

        expect(request).toEqual({
            user: { email: 'grace@example.com', createdBy: 'owner-1' },
            workspace: { id: 'team-1' },
            role: { id: 'role-1' }
        })
        expect(request).not.toHaveProperty('link')
    })
})
