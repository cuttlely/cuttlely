/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import {
    IdentityFailureRateLimit,
    OIDC_ADMIN_WRITE_LIMIT,
    OIDC_CALLBACK_LIMIT,
    OIDC_FAILURE_LIMIT,
    OIDC_LOGIN_START_LIMIT,
    OIDC_TEST_START_LIMIT
} from './rateLimit'

describe('OIDC route limits', () => {
    it('keeps high shared-address ceilings for successful starts and callbacks', () => {
        expect(OIDC_LOGIN_START_LIMIT).toBeGreaterThanOrEqual(500)
        expect(OIDC_CALLBACK_LIMIT).toBeGreaterThanOrEqual(1000)
        expect(OIDC_ADMIN_WRITE_LIMIT).toBeLessThanOrEqual(10)
        expect(OIDC_TEST_START_LIMIT).toBeLessThanOrEqual(10)
    })

    it('counts only recorded failures and expires the tight failure window', () => {
        const limit = new IdentityFailureRateLimit(OIDC_FAILURE_LIMIT, 1_000)
        const address = '192.0.2.10'
        for (let index = 0; index < OIDC_CALLBACK_LIMIT; index += 1) expect(limit.blocked(address, 100)).toBe(false)
        for (let index = 0; index < OIDC_FAILURE_LIMIT; index += 1) limit.recordFailure(address, 100 + index)
        expect(limit.blocked(address, 200)).toBe(true)
        expect(limit.blocked(address, 2_000)).toBe(false)
    })
})
