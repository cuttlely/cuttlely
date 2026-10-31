import { invitationResults, submitInvitations } from './invitePayload'

describe('bulk invitation links', () => {
    it('submits new email invitations without names', async () => {
        const inviteAccount = jest
            .fn()
            .mockResolvedValueOnce({ data: { id: 'ada' } })
            .mockResolvedValueOnce({ data: { id: 'grace' } })
        const addWorkspaceUser = jest.fn()

        await expect(
            submitInvitations({
                selectedUsers: [
                    { isNewUser: true, email: 'ada@example.com' },
                    { isNewUser: true, email: 'grace@example.com' }
                ],
                currentUserId: 'owner-1',
                workspaceId: 'team-1',
                roleId: 'role-1',
                inviteAccount,
                addWorkspaceUser
            })
        ).resolves.toEqual([{ id: 'ada' }, { id: 'grace' }])
        expect(inviteAccount).toHaveBeenCalledTimes(2)
        expect(inviteAccount.mock.calls.map(([request]) => request)).toEqual([
            {
                user: { email: 'ada@example.com', createdBy: 'owner-1' },
                workspace: { id: 'team-1' },
                role: { id: 'role-1' }
            },
            {
                user: { email: 'grace@example.com', createdBy: 'owner-1' },
                workspace: { id: 'team-1' },
                role: { id: 'role-1' }
            }
        ])
        expect(addWorkspaceUser).not.toHaveBeenCalled()
    })

    it('keeps returned links paired with their email and leaves the dialog open', () => {
        const selected = [
            { isNewUser: true, email: 'ada@example.com' },
            { isNewUser: false, user: { email: 'grace@example.com' } },
            { isNewUser: true, email: 'lin@example.com' }
        ]
        const result = invitationResults(selected, [
            { link: 'https://example.test/ada' },
            { id: 'grace' },
            { link: 'https://example.test/lin' }
        ])

        expect(result).toEqual({
            keepOpen: true,
            links: [
                { email: 'ada@example.com', link: 'https://example.test/ada' },
                { email: 'lin@example.com', link: 'https://example.test/lin' }
            ]
        })
        expect(invitationResults(selected, [{ id: 'ada' }, { id: 'grace' }, { id: 'lin' }]).keepOpen).toBe(false)
    })

    it('closes normally when no response includes a link', () => {
        const selected = [
            { isNewUser: false, user: { email: 'ada@example.com' } },
            { isNewUser: false, user: { email: 'lin@example.com' } }
        ]

        expect(invitationResults(selected, [{ id: 'ada' }, { id: 'lin' }])).toEqual({ keepOpen: false, links: [] })
    })
})
