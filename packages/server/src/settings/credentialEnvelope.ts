export type RecordContext = readonly [string, string, ...string[]]

export type CredentialEnvelope = {
    seal(plaintext: string, context: RecordContext): string
    open(ciphertext: string, context: RecordContext): string
}

export const {
    forCredentialGeneration,
    isCredentialEnvelope,
    newCredentialGeneration,
    credentialEnvelopeGeneration,
    sealWithActiveGeneration,
    openWithActiveGeneration,
    parseAuthenticatedCredential
} = require('../../../../scripts/credential-envelope.cjs') as {
    forCredentialGeneration(passphrase: string, generation: string): CredentialEnvelope
    isCredentialEnvelope(value: unknown): boolean
    newCredentialGeneration(): string
    credentialEnvelopeGeneration(value: unknown): string
    sealWithActiveGeneration(plaintext: string, passphrase: string, context?: RecordContext): string | undefined
    openWithActiveGeneration(ciphertext: string, passphrase: string, context?: RecordContext): string | undefined
    parseAuthenticatedCredential(plaintext: string | undefined): Record<string, unknown>
}
