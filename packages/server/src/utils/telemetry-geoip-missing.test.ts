import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'

jest.mock('geoip-lite', () => {
    const error = new Error("Cannot find module 'geoip-lite'")
    ;(error as NodeJS.ErrnoException).code = 'MODULE_NOT_FOUND'
    throw error
})
jest.mock('uuid', () => ({ v4: jest.fn() }))
jest.mock('posthog-node', () => ({ PostHog: jest.fn() }))

jest.mock('../../src/utils', () => ({
    getAppVersion: jest.fn()
}))

jest.mock('../../src/utils/ipValidation', () => ({
    isIPv4: jest.fn(),
    isIPv6: jest.fn(),
    isValidIPAddress: jest.fn()
}))

jest.mock('../../src/utils/logger', () => ({
    __esModule: true,
    default: {
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn()
    },
    auditLogger: {
        log: jest.fn()
    }
}))

import { emitEvent, TelemetryEventCategory, TelemetryEventResult } from '../../src/utils/telemetry'

const uuid = require('uuid')
const utils = require('../../src/utils')
const ipValidation = require('../../src/utils/ipValidation')
const loggerModule = require('../../src/utils/logger')

describe('getGeolocation when geoip-lite is not installed', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        uuid.v4.mockReturnValue('test-uuid-1')
        utils.getAppVersion.mockResolvedValue('3.0.13')
        ipValidation.isValidIPAddress.mockReturnValue(true)
        ipValidation.isIPv4.mockReturnValue(true)
        ipValidation.isIPv6.mockReturnValue(false)
    })

    afterEach(() => {
        jest.clearAllMocks()
    })

    it('returns an empty lookup, logs once at debug, and still writes the audit event', async () => {
        const input = {
            category: TelemetryEventCategory.AUDIT,
            eventType: 'sign-in',
            actionType: 'read',
            userId: 'user-1',
            orgId: 'org-1',
            ipAddress: '203.0.113.42',
            result: TelemetryEventResult.SUCCESS
        }

        await emitEvent(input)
        await emitEvent({ ...input, eventType: 'sign-in-again' })

        expect(loggerModule.default.debug).toHaveBeenCalledTimes(1)
        expect(loggerModule.default.error).not.toHaveBeenCalled()
        expect(loggerModule.auditLogger.log).toHaveBeenCalledTimes(2)

        for (const call of loggerModule.auditLogger.log.mock.calls) {
            expect(call[0].countryCode).toBeUndefined()
            expect(call[0].region).toBeUndefined()
            expect(call[0].ipAddress).toBe('203.0.113.xxx')
        }
    })
})
