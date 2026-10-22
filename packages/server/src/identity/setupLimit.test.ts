/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {
    SETUP_ADDRESS_MAX_ENTRIES,
    SETUP_ADDRESS_WINDOW_MS,
    recordSetupFailure,
    resetSetupFailures,
    setupFailureAddressCount,
    setupFailureLimited
} from './setupLimit'

describe('setup failure list', () => {
    beforeEach(() => resetSetupFailures())
    afterAll(() => resetSetupFailures())

    it('drops an address once it has no failure inside the window', () => {
        const start = 1_000_000
        recordSetupFailure('198.51.100.1', start)
        recordSetupFailure('198.51.100.2', start)
        expect(setupFailureAddressCount()).toBe(2)
        recordSetupFailure('198.51.100.3', start + SETUP_ADDRESS_WINDOW_MS + 1)
        expect(setupFailureAddressCount()).toBe(1)
        expect(setupFailureLimited('198.51.100.1', start + SETUP_ADDRESS_WINDOW_MS + 1)).toBe(false)
    })

    it('keeps at most the cap of addresses and drops the oldest first', () => {
        const now = 2_000_000
        for (let i = 0; i < SETUP_ADDRESS_MAX_ENTRIES + 5; i++) {
            recordSetupFailure(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, now)
        }
        expect(setupFailureAddressCount()).toBe(SETUP_ADDRESS_MAX_ENTRIES)
    })

    it('still limits an address that keeps failing while the list is trimmed', () => {
        const now = 3_000_000
        for (let i = 0; i < 10; i++) recordSetupFailure('203.0.113.9', now + i)
        expect(setupFailureLimited('203.0.113.9', now + 10)).toBe(true)
    })
})
