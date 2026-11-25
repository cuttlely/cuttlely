import { createDecipheriv, createHash } from 'crypto'
import { TextDecoder } from 'util'
import type { CredentialEnvelope, RecordContext } from './credentialEnvelope'
import { isCredentialEnvelope, openApplicationRecord } from './credentialEnvelope'

const LEGACY_PREFIX = Buffer.from('Salted__')
const LEGACY_ENCODING = /^U2FsdGVkX1[A-Za-z0-9+/]+={0,2}$/
const decoder = new TextDecoder('utf-8', { fatal: true })

/** Decode existing OpenSSL/CryptoJS passphrase data. This does not authenticate legacy CBC data. */
export function readLegacyCredential(ciphertext: unknown, passphrase: string): string {
    try {
        if (typeof ciphertext !== 'string' || !LEGACY_ENCODING.test(ciphertext)) throw new Error()
        const raw = Buffer.from(ciphertext, 'base64')
        if (
            raw.length < 32 ||
            raw.length % 16 !== 0 ||
            raw.toString('base64') !== ciphertext ||
            !raw.subarray(0, 8).equals(LEGACY_PREFIX)
        ) {
            throw new Error()
        }
        const salt = raw.subarray(8, 16)
        const password = Buffer.from(passphrase, 'utf8')
        const material = Buffer.alloc(48)
        let block: Buffer = Buffer.alloc(0)
        for (let offset = 0; offset < material.length; offset += 16) {
            block = createHash('md5').update(block).update(password).update(salt).digest()
            block.copy(material, offset)
        }
        try {
            const decipher = createDecipheriv('aes-256-cbc', material.subarray(0, 32), material.subarray(32))
            return decoder.decode(Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]))
        } finally {
            material.fill(0)
            password.fill(0)
            block.fill(0)
        }
    } catch {
        throw new Error('The legacy encrypted record could not be read.')
    }
}

export function readUnrotatedCredential(ciphertext: unknown, passphrase: string, context: RecordContext): string {
    if (typeof ciphertext === 'string' && isCredentialEnvelope(ciphertext))
        return openApplicationRecord(ciphertext, passphrase, context, {})
    return readLegacyCredential(ciphertext, passphrase)
}

/** Rewrap a validated record in memory and check the result before giving it to the staging writer. */
export function rewrapCredentialRecord(
    ciphertext: unknown,
    source: { passphrase: string } | { envelope: CredentialEnvelope },
    destination: CredentialEnvelope,
    context: RecordContext,
    validate: (plaintext: string) => void
): string {
    if (typeof ciphertext !== 'string') throw new Error('The encrypted record has an invalid format.')
    const plaintext =
        'passphrase' in source ? readUnrotatedCredential(ciphertext, source.passphrase, context) : source.envelope.open(ciphertext, context)
    validate(plaintext)
    const staged = destination.seal(plaintext, context)
    if (destination.open(staged, context) !== plaintext) throw new Error('The staged encrypted record could not be verified.')
    return staged
}
