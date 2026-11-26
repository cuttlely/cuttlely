/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import type { Response } from 'node-fetch'

import { oidcConfigurationFingerprint, OidcConfiguration } from './oidcStore'

describe('OIDC discovery through a private issuer host', () => {
    it('uses a listed shared-address host for discovery and signing material', async () => {
        const issuer = 'https://100.64.0.1'
        const guardedFetch = jest.fn<Promise<Response>, [string, any, number, any]>(async (url) => {
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
            async function* bodyIterable() {
                yield Buffer.from(JSON.stringify(value))
            }
            return {
                status: 200,
                ok: true,
                body: bodyIterable(),
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

        let check!: typeof import('./oidcProvider').checkOidcConfiguration
        jest.isolateModules(() => {
            // Built and source-only server test runs can resolve different module IDs.
            // Register the physical entry when present as well as the source-only virtual package.
            const transport = () => ({ secureFetch: guardedFetch })
            try {
                jest.doMock('@cuttlely/components', transport)
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
            }
            jest.doMock('@cuttlely/components', transport, { virtual: true })
            check = require('./oidcProvider').checkOidcConfiguration
        })
        await expect(check(config)).resolves.toMatchObject({ issuer })
        expect(guardedFetch).toHaveBeenCalledTimes(2)
        for (const call of guardedFetch.mock.calls) {
            expect(call[3]).toEqual(expect.objectContaining({ allowedPrivateHostnames: ['100.64.0.1'] }))
        }
    })
})
