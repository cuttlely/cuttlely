'use strict'

const { createCipheriv, createDecipheriv, randomBytes, scryptSync } = require('node:crypto')
const { TextDecoder } = require('node:util')

const VERSION = 'cuttlely-key-v1'
const NONCE_BYTES = 12
const TAG_BYTES = 16
const GENERATION_BYTES = 16
const MAX_PLAINTEXT_BYTES = 16 * 1024 * 1024
const decoder = new TextDecoder('utf-8', { fatal: true })

function invalidEnvelope() {
    return Object.assign(new Error('Could not authenticate the encrypted record.'), { code: 'CREDENTIAL_ENVELOPE_INVALID' })
}

function newCredentialGeneration() {
    return randomBytes(GENERATION_BYTES).toString('hex')
}

function validGeneration(generation) {
    return typeof generation === 'string' && /^[a-f0-9]{32}$/.test(generation)
}

function contextBytes(generation, context) {
    if (!Array.isArray(context) || context.length < 2 || context.some((field) => typeof field !== 'string' || !field)) {
        throw invalidEnvelope()
    }
    return Buffer.from(JSON.stringify([VERSION, generation, ...context]))
}

function forCredentialGeneration(passphrase, generation) {
    if (typeof passphrase !== 'string' || !passphrase.trim() || !validGeneration(generation)) throw invalidEnvelope()
    const salt = Buffer.concat([Buffer.from(VERSION), Buffer.from(generation, 'hex')])
    const key = scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
    return {
        seal(plaintext, context) {
            if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > MAX_PLAINTEXT_BYTES) throw invalidEnvelope()
            const nonce = randomBytes(NONCE_BYTES)
            const cipher = createCipheriv('aes-256-gcm', key, nonce).setAAD(contextBytes(generation, context))
            const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
            return `${VERSION}:${generation}:${Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url')}`
        },
        open(envelope, context) {
            try {
                const prefix = `${VERSION}:${generation}:`
                if (typeof envelope !== 'string' || !envelope.startsWith(prefix)) throw invalidEnvelope()
                const encoded = envelope.slice(prefix.length)
                if (
                    !/^[A-Za-z0-9_-]+$/.test(encoded) ||
                    encoded.length > Math.ceil(((MAX_PLAINTEXT_BYTES + NONCE_BYTES + TAG_BYTES) * 4) / 3)
                ) {
                    throw invalidEnvelope()
                }
                const payload = Buffer.from(encoded, 'base64url')
                if (payload.length < NONCE_BYTES + TAG_BYTES || payload.toString('base64url') !== encoded) throw invalidEnvelope()
                const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, NONCE_BYTES))
                decipher.setAAD(contextBytes(generation, context)).setAuthTag(payload.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES))
                return decoder.decode(Buffer.concat([decipher.update(payload.subarray(NONCE_BYTES + TAG_BYTES)), decipher.final()]))
            } catch {
                throw invalidEnvelope()
            }
        }
    }
}

function isCredentialEnvelope(value) {
    return typeof value === 'string' && value.startsWith('cuttlely-key-')
}

function credentialEnvelopeGeneration(value) {
    if (typeof value !== 'string') throw invalidEnvelope()
    const [version, generation] = value.split(':', 2)
    if (version !== VERSION || !validGeneration(generation)) throw invalidEnvelope()
    return generation
}

module.exports = { forCredentialGeneration, isCredentialEnvelope, newCredentialGeneration, credentialEnvelopeGeneration }
