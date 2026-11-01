/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */

import { oidcLinkFailureMessage } from './link'

describe('OIDC link refusal messages', () => {
    it.each([
        ['unknown', 'This identity cannot sign in.'],
        ['invite_required', 'You have a pending invite. Open the invite link from your email to join.'],
        ['invite_invalid', 'This invite link is not valid. Ask for a new invite.']
    ])('maps %s to its sign-in message', (reason, message) => {
        expect(oidcLinkFailureMessage(reason)).toBe(message)
    })
})
