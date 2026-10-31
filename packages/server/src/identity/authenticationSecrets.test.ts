/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { EPOCH_BINDING_LABEL, REAUTHENTICATION_STATE_LABEL, SCIM_BEARER_LABEL, deriveAuthenticationSecret } from './authenticationSecrets'

describe('authentication secret derivation', () => {
    it('uses distinct labels and stable independent outputs', () => {
        const base = 'test-instance-secret'
        const epoch = deriveAuthenticationSecret(base, EPOCH_BINDING_LABEL)
        const reauthentication = deriveAuthenticationSecret(base, REAUTHENTICATION_STATE_LABEL)
        const scim = deriveAuthenticationSecret(base, SCIM_BEARER_LABEL)
        expect(EPOCH_BINDING_LABEL).not.toBe(REAUTHENTICATION_STATE_LABEL)
        expect(epoch).not.toBe(reauthentication)
        expect(scim).not.toBe(epoch)
        expect(scim).not.toBe(reauthentication)
        expect(epoch).toBe(deriveAuthenticationSecret(base, EPOCH_BINDING_LABEL))
        expect(reauthentication).toBe(deriveAuthenticationSecret(base, REAUTHENTICATION_STATE_LABEL))
        expect(scim).toBe(deriveAuthenticationSecret(base, SCIM_BEARER_LABEL))
    })
})
