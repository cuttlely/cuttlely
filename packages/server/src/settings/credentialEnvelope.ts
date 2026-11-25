export type RecordContext = readonly [string, string, ...string[]]

export type CredentialEnvelope = {
    seal(plaintext: string, context: RecordContext): string
    open(ciphertext: string, context: RecordContext): string
}

export const { forCredentialGeneration, isCredentialEnvelope, newCredentialGeneration, credentialEnvelopeGeneration } =
    require('../../../../scripts/credential-envelope.cjs') as {
        forCredentialGeneration(passphrase: string, generation: string): CredentialEnvelope
        isCredentialEnvelope(value: unknown): value is string
        newCredentialGeneration(): string
        credentialEnvelopeGeneration(value: unknown): string
    }
