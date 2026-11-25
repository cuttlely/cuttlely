import { AES } from 'crypto-js'
import { forCredentialGeneration, newCredentialGeneration } from './credentialEnvelope'
import { readLegacyCredential, rewrapCredentialRecord } from './credentialRewrap'

test('rewraps existing CryptoJS data and then rewraps an already authenticated generation', () => {
    const originalKey = 'original test key 🎉'
    const plaintext = JSON.stringify({ secret: 'fixture-only' })
    const legacy = AES.encrypt(plaintext, originalKey).toString()
    const context = ['credential', 'fixture-id'] as const
    const stage = forCredentialGeneration('replacement test key', newCredentialGeneration())
    const next = forCredentialGeneration('later test key', newCredentialGeneration())
    const validate = (raw: string) => {
        if (typeof JSON.parse(raw).secret !== 'string') throw new Error('Invalid record')
    }
    expect(readLegacyCredential(legacy, originalKey)).toBe(plaintext)
    const staged = rewrapCredentialRecord(legacy, { passphrase: originalKey }, stage, context, validate)
    const latest = rewrapCredentialRecord(staged, { envelope: stage }, next, context, validate)
    expect(next.open(latest, context)).toBe(plaintext)
    expect(() => stage.open(latest, context)).toThrow('Could not authenticate')
    expect(() => rewrapCredentialRecord(legacy, { passphrase: 'wrong key' }, stage, context, validate)).toThrow()
    const malformed = AES.encrypt('{"wrongShape":true}', originalKey).toString()
    expect(() => rewrapCredentialRecord(malformed, { passphrase: originalKey }, stage, context, validate)).toThrow('Invalid record')
    expect(() => readLegacyCredential(legacy.slice(0, -4), originalKey)).toThrow()
})
