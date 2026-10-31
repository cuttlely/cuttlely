/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { EPOCH_BINDING_LABEL, deriveAuthenticationSecret } from './authenticationSecrets'

describe('authentication secret derivation', () => {
    it('uses a stable context-specific output', () => {
        const base = 'test-instance-secret'
        const epoch = deriveAuthenticationSecret(base, EPOCH_BINDING_LABEL)
        expect(epoch).not.toBe(deriveAuthenticationSecret(base, 'cuttlely/authentication/another-use/v1'))
        expect(epoch).toBe(deriveAuthenticationSecret(base, EPOCH_BINDING_LABEL))
    })
})
