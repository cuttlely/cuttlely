/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import {
    IdentityFailureRateLimit,
    OIDC_ADMIN_WRITE_LIMIT,
    OIDC_CALLBACK_LIMIT,
    OIDC_FAILURE_ADDRESS_CAP,
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

    it('sweeps expired address buckets while checking another address', () => {
        const limit = new IdentityFailureRateLimit(2, 1_000, 4)
        limit.recordFailure('192.0.2.1', 100)
        limit.recordFailure('192.0.2.2', 900)

        expect(limit.addressBuckets(1_099)).toBe(2)
        expect(limit.blocked('192.0.2.3', 1_100)).toBe(false)
        expect(limit.addressBuckets(1_100)).toBe(1)
        expect(limit.retained('192.0.2.2', 1_100)).toBe(1)
    })

    it('caps address buckets and evicts the least recently failed address', () => {
        const limit = new IdentityFailureRateLimit(2, 10_000, 2)
        limit.recordFailure('192.0.2.1', 100)
        limit.recordFailure('192.0.2.2', 200)
        limit.recordFailure('192.0.2.1', 300)
        limit.recordFailure('192.0.2.3', 400)

        expect(limit.addressBuckets(400)).toBe(2)
        expect(limit.retained('192.0.2.1', 400)).toBe(2)
        expect(limit.blocked('192.0.2.1', 400)).toBe(true)
        expect(limit.retained('192.0.2.2', 400)).toBe(0)
        expect(limit.retained('192.0.2.3', 400)).toBe(1)
        expect(OIDC_FAILURE_ADDRESS_CAP).toBeGreaterThanOrEqual(1_000)
    })
})
