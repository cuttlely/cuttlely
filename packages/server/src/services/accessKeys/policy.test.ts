import { callerPolicyAllows, expiry, parseGrants, parsePolicy } from './policy'
import { credentialActive, principalActive } from './credentials'
import { ApiKey } from '../../database/entities/ApiKey'
import { ApiKeyCredential } from '../../database/entities/ApiKeyCredential'
import { utcWindows } from './limiter'

describe('access key policy', () => {
    it('starts with no operations or resource grants and cannot accept invented capabilities', () => {
        expect(parsePolicy(undefined).scopes).toEqual([])
        expect(parsePolicy(undefined).allResources).toBe(false)
        expect(parseGrants(undefined)).toEqual([])
        expect(() => parsePolicy({ scopes: ['/api/v1/admin'] })).toThrow()
        expect(() => parseGrants([{ resourceType: 'ADMIN', resourceId: 'one' }])).toThrow()
        expect(parsePolicy({ legacy: true }).legacy).toBeUndefined()
    })
    it('normalizes origins exactly and treats missing Origin explicitly', () => {
        const p = parsePolicy({ origins: ['https://EXAMPLE.com:443'], allowNoOrigin: false })
        expect(callerPolicyAllows(p, 'https://example.com', '127.0.0.1')).toBe(true)
        for (const origin of [undefined, 'https://sub.example.com', 'https://example.com.evil.test', 'null', 'https://example.com/path'])
            expect(callerPolicyAllows(p, origin, '127.0.0.1')).toBe(false)
        expect(() => parsePolicy({ origins: ['https://*.example.com'] })).toThrow()
        expect(callerPolicyAllows(parsePolicy({ origins: ['https://example.com'] }), undefined, '127.0.0.1')).toBe(false)
        expect(callerPolicyAllows(parsePolicy({ origins: ['https://example.com'], allowNoOrigin: true }), undefined, '127.0.0.1')).toBe(
            true
        )
        expect(callerPolicyAllows({ ...parsePolicy({}), ips: ['broken/cidr'] }, undefined, '127.0.0.1')).toBe(false)
    })
    it('accepts IPv4, IPv6 and CIDRs using only the supplied trusted client IP', () => {
        const p = parsePolicy({ ips: ['192.0.2.0/24', '2001:db8::/32'] })
        for (const ip of ['192.0.2.4', '::ffff:192.0.2.4', '2001:db8::1']) expect(callerPolicyAllows(p, undefined, ip)).toBe(true)
        for (const ip of ['198.51.100.1', '2001:db9::1', 'invalid']) expect(callerPolicyAllows(p, undefined, ip)).toBe(false)
        expect(() => parsePolicy({ ips: ['0.0.0.0/33'] })).toThrow()
        expect(() => parsePolicy({ ips: ['127.0.0.1,evil'] })).toThrow()
    })
    it('checks absolute expiry and revocation at the time boundary', () => {
        const at = Date.parse('2026-11-07T00:00:00Z')
        const key = { expiresAt: new Date(at) } as ApiKey
        const credential = { expiresAt: new Date(at), revokedAt: null } as ApiKeyCredential
        expect(principalActive(key, at - 1)).toBe(true)
        expect(principalActive(key, at)).toBe(false)
        expect(credentialActive(credential, at - 1)).toBe(true)
        expect(credentialActive(credential, at)).toBe(false)
        expect(principalActive({ disabledAt: new Date() } as ApiKey)).toBe(false)
        expect(credentialActive({ revokedAt: new Date() } as ApiKeyCredential)).toBe(false)
        expect(expiry(null)).toBeNull()
        expect(() => expiry('2020-01-01T00:00:00Z')).toThrow()
        expect(() => expiry('2030-01-01T00:00:00')).toThrow()
    })
    it('uses UTC calendar boundaries through month and leap-year rollovers', () => {
        const w = utcWindows(Date.parse('2028-02-29T23:59:59.999Z'))
        expect(w.day).toBe('2028-02-29')
        expect(w.month).toBe('2028-02')
        expect(w.dayReset).toBe(Date.parse('2028-03-01T00:00:00Z'))
        expect(w.monthReset).toBe(w.dayReset)
    })
})
