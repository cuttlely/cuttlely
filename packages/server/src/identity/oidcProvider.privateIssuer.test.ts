/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
const mockSecureFetch = jest.fn()
jest.mock('@cuttlely/components', () => ({
    ...jest.requireActual('../../../components/src/httpSecurity'),
    secureFetch: (...args: unknown[]) => mockSecureFetch(...args)
}))

import { Readable } from 'stream'
import type { Response } from 'node-fetch'
import { checkOidcConfiguration, clearOidcCachesForTest } from './oidcProvider'
import { oidcConfigurationFingerprint, OidcConfiguration } from './oidcStore'

describe('OIDC discovery through a private issuer host', () => {
    beforeEach(() => {
        clearOidcCachesForTest()
        mockSecureFetch.mockReset()
    })

    it('uses a listed shared-address host for discovery and signing material', async () => {
        const issuer = 'https://100.64.0.1'
        const guardedFetch = mockSecureFetch.mockImplementation(async (url) => {
            const value = String(url).endsWith('/jwks')
                ? { keys: [{ kty: 'RSA', kid: 'shared-address-test' }] }
                : {
                      issuer,
                      authorization_endpoint: `${issuer}/authorize`,
                      token_endpoint: `${issuer}/token`,
                      jwks_uri: `${issuer}/jwks`,
                      response_types_supported: ['code'],
                      id_token_signing_alg_values_supported: ['RS256']
                  }
            return {
                status: 200,
                ok: true,
                body: Readable.from([Buffer.from(JSON.stringify(value))]),
                headers: { get: () => null }
            } as unknown as Response
        })
        const safe = {
            issuer,
            clientId: 'shared-address-client',
            clientSecretEnvVar: 'CUTTLELY_TEST_OIDC_CLIENT_SECRET',
            trustMissingEmailVerification: false,
            privateIssuerHosts: ['100.64.0.1']
        }
        const config: OidcConfiguration = {
            slot: 'active',
            ...safe,
            fingerprint: oidcConfigurationFingerprint(safe),
            discovery: null,
            health: 'ready',
            healthError: null,
            checkedAt: null,
            testedFingerprint: null,
            testedAt: null,
            testResult: null,
            version: 1
        }

        const result = await checkOidcConfiguration(config).catch((error: unknown) => error)
        expect(guardedFetch).toHaveBeenCalledTimes(2)
        expect(result).not.toBeInstanceOf(Error)
        expect(result).toMatchObject({ issuer })
        for (const call of guardedFetch.mock.calls) {
            expect(call[3]).toEqual(expect.objectContaining({ allowedPrivateHostnames: ['100.64.0.1'] }))
        }
    })
})
