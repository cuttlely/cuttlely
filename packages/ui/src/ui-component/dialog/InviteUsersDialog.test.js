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
                link: true,
                inviteAccount,
                addWorkspaceUser
            })
        ).resolves.toEqual([
            { status: 'fulfilled', value: { id: 'ada' } },
            { status: 'fulfilled', value: { id: 'grace' } }
        ])
        expect(inviteAccount).toHaveBeenCalledTimes(2)
        expect(inviteAccount.mock.calls.map(([request]) => request)).toEqual([
            {
                user: { email: 'ada@example.com', createdBy: 'owner-1' },
                workspace: { id: 'team-1' },
                role: { id: 'role-1' },
                link: true
            },
            {
                user: { email: 'grace@example.com', createdBy: 'owner-1' },
                workspace: { id: 'team-1' },
                role: { id: 'role-1' },
                link: true
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
            { status: 'fulfilled', value: { link: 'https://example.test/ada' } },
            { status: 'fulfilled', value: { id: 'grace' } },
            { status: 'fulfilled', value: { link: 'https://example.test/lin' } }
        ])

        expect(result).toEqual({
            keepOpen: true,
            links: [
                { email: 'ada@example.com', link: 'https://example.test/ada' },
                { email: 'lin@example.com', link: 'https://example.test/lin' }
            ],
            failures: [],
            successCount: 3
        })
        expect(
            invitationResults(selected, [
                { status: 'fulfilled', value: { id: 'ada' } },
                { status: 'fulfilled', value: { id: 'grace' } },
                { status: 'fulfilled', value: { id: 'lin' } }
            ]).keepOpen
        ).toBe(false)
    })

    it('closes normally when no response includes a link', () => {
        const selected = [
            { isNewUser: false, user: { email: 'ada@example.com' } },
            { isNewUser: false, user: { email: 'lin@example.com' } }
        ]

        expect(
            invitationResults(selected, [
                { status: 'fulfilled', value: { id: 'ada' } },
                { status: 'fulfilled', value: { id: 'lin' } }
            ])
        ).toEqual({ keepOpen: false, links: [], failures: [], successCount: 2 })
    })

    it('keeps successful links with item-specific failures', async () => {
        const failed = Object.assign(new Error('Already invited'), { response: { data: { message: 'Account already exists' } } })
        const inviteAccount = jest
            .fn()
            .mockResolvedValueOnce({ data: { link: 'https://example.test/ada' } })
            .mockRejectedValueOnce(failed)
        const selected = [
            { isNewUser: true, email: 'ada@example.com' },
            { isNewUser: true, email: 'grace@example.com' }
        ]
        const responses = await submitInvitations({
            selectedUsers: selected,
            currentUserId: 'owner-1',
            workspaceId: 'team-1',
            roleId: 'role-1',
            link: true,
            inviteAccount,
            addWorkspaceUser: jest.fn()
        })

        expect(invitationResults(selected, responses)).toEqual({
            keepOpen: true,
            successCount: 1,
            links: [{ email: 'ada@example.com', link: 'https://example.test/ada' }],
            failures: [{ email: 'grace@example.com', message: 'Account already exists' }]
        })
    })
})
