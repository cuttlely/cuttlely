import { inviteLinkRequested, inviteMethodFromOptions, newUserInviteNote } from './inviteDialogState'

describe('new-user sign-in guidance', () => {
    it.each([
        [{ oidc: true, authKit: false }, 'OIDC', 'sign in with OIDC'],
        [{ oidc: false, authKit: true }, 'WorkOS', 'sign in with WorkOS'],
        [{ oidc: false, authKit: false, localUsers: true }, 'Local', 'set a Local password']
    ])('uses the active method for %#', (options, method, guidance) => {
        const selected = inviteMethodFromOptions(options)
        expect(selected).toBe(method)
        expect(newUserInviteNote(selected)).toContain(guidance)
        expect(inviteLinkRequested(selected)).toBe(method === 'Local')
    })
})
