/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { workosConfigurationFingerprint, stableWorkosProviderKey } from './authenticationState'
import { workosProvider } from './provider'
import { WorkosPort } from './types'

describe('authentication provider foundation', () => {
    it('fingerprints issuer and client id without including the API key', () => {
        const first = workosConfigurationFingerprint({ WORKOS_CLIENT_ID: 'client-a', WORKOS_API_KEY: 'secret-a' })
        const second = workosConfigurationFingerprint({ WORKOS_CLIENT_ID: 'client-a', WORKOS_API_KEY: 'secret-b' })
        expect(first).toBe(second)
        expect(first).toMatch(/^[a-f0-9]{64}$/)
        expect(workosConfigurationFingerprint({ WORKOS_API_KEY: 'secret-a' })).toBeNull()
    })

    it('scopes the stable provider key to the database installation', () => {
        const fingerprint = workosConfigurationFingerprint({ WORKOS_CLIENT_ID: 'client-a' }) as string
        expect(stableWorkosProviderKey('installation-a', fingerprint)).not.toBe(stableWorkosProviderKey('installation-b', fingerprint))
    })

    it('keeps the existing WorkosPort object as the compatibility adapter', () => {
        const port = {} as WorkosPort
        const provider = workosProvider(port, () => true)
        expect(provider.kind).toBe('workos')
        expect(provider.configurationStatus()).toEqual({ configured: true })
        expect(provider.compatibility).toBe(port)
    })
})
