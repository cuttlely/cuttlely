const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
    forCredentialGeneration,
    isCredentialEnvelope,
    newCredentialGeneration,
    openApplicationRecord,
    sealApplicationRecord
} = require('./credential-envelope.cjs')

test('binds plaintext to the selected key generation and the exact record', () => {
    const generation = newCredentialGeneration()
    const key = 'fixture encryption passphrase'
    const codec = forCredentialGeneration(key, generation)
    const context = ['credential', 'fixture-record']
    const text = '{"token":"test-only-🎉"}'
    const one = codec.seal(text, context)
    const two = codec.seal(text, context)
    assert.notEqual(one, two)
    assert.equal(isCredentialEnvelope(one), true)
    assert.equal(isCredentialEnvelope('cuttlely-key-v2:unknown'), true)
    assert.equal(isCredentialEnvelope('U2FsdGVkX1legacy'), false)
    assert.equal(codec.open(one, context), text)
    assert.equal(codec.open(two, context), text)
    assert.throws(() => codec.open(one, ['credential', 'other-record']), { code: 'CREDENTIAL_ENVELOPE_INVALID' })
    assert.throws(() => codec.open(one, ['webhook', 'fixture-record']), { code: 'CREDENTIAL_ENVELOPE_INVALID' })
    assert.throws(() => forCredentialGeneration('wrong key', generation).open(one, context), { code: 'CREDENTIAL_ENVELOPE_INVALID' })
    assert.throws(() => forCredentialGeneration(key, newCredentialGeneration()).open(one, context), { code: 'CREDENTIAL_ENVELOPE_INVALID' })
    assert.throws(() => codec.open(one.slice(0, -2), context), { code: 'CREDENTIAL_ENVELOPE_INVALID' })
    assert.throws(() => codec.open(one.replace('-v1:', '-v2:'), context), { code: 'CREDENTIAL_ENVELOPE_INVALID' })
    const [version, label, encoded] = one.split(':')
    const tampered = Buffer.from(encoded, 'base64url')
    tampered[tampered.length - 1] ^= 1
    assert.throws(() => codec.open([version, label, tampered.toString('base64url')].join(':'), context), {
        code: 'CREDENTIAL_ENVELOPE_INVALID'
    })
})

test('authenticates new application records without configuring a rotation', () => {
    const key = 'fixture key'
    const context = ['credential', 'one']
    const original = sealApplicationRecord('fixture', key, context, {})
    const nextEnv = { CUTTLELY_CREDENTIAL_GENERATION: newCredentialGeneration() }
    assert.equal(openApplicationRecord(original, key, context, {}), 'fixture')
    assert.throws(() => openApplicationRecord(original, key, ['credential', 'other'], {}))
    assert.throws(() => openApplicationRecord(original, key, context, nextEnv))
    const rotated = sealApplicationRecord('fixture', key, context, nextEnv)
    assert.equal(openApplicationRecord(rotated, key, context, nextEnv), 'fixture')
    assert.throws(() => openApplicationRecord(rotated, key, context, {}))
})
