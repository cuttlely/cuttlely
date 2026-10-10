// Proof that a test sign-in with AuthKit passed for one exact set of AuthKit values. Password sign-in can be turned
// off only while the AuthKit values match a passed test. The file holds a keyed fingerprint, never the values.
import { createHmac, timingSafeEqual } from 'crypto'
import fs from 'fs'
import path from 'path'
import { writeFileAtomic } from './store'

export const AUTHKIT_PROOF_FILE = 'authkit-test.json'
export const AUTHKIT_KEYS = ['WORKOS_API_KEY', 'WORKOS_CLIENT_ID', 'WORKOS_REDIRECT_URI', 'WORKOS_COOKIE_PASSWORD'] as const

type Values = Record<string, string | undefined>

export interface AuthKitProof {
    fingerprint: string
    passedAt: string
    by: string
    environment: 'staging' | 'production' | 'unknown'
}

export function authKitFingerprint(values: Values, key: string): string {
    const text = AUTHKIT_KEYS.map((name) => String(values[name] ?? '').trim()).join('\n')
    return createHmac('sha256', `Cuttlely authkit test\n${key}`).update(text).digest('hex')
}

export function authKitComplete(values: Values): boolean {
    return AUTHKIT_KEYS.every((name) => String(values[name] ?? '').trim() !== '')
}

export function authKitEnvironment(apiKey: string | undefined): AuthKitProof['environment'] {
    const value = String(apiKey ?? '').trim()
    if (value.startsWith('sk_test_')) return 'staging'
    if (value.startsWith('sk_live_')) return 'production'
    return 'unknown'
}

export function readAuthKitProof(dir: string): AuthKitProof | null {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, AUTHKIT_PROOF_FILE), 'utf8'))
        if (data && typeof data.fingerprint === 'string' && typeof data.passedAt === 'string') return data as AuthKitProof
    } catch {
        // No proof yet, or a damaged file: treat as untested.
    }
    return null
}

export function writeAuthKitProof(dir: string, proof: AuthKitProof): void {
    writeFileAtomic(dir, AUTHKIT_PROOF_FILE, `${JSON.stringify(proof, null, 2)}\n`)
}

/** True when these AuthKit values passed a test sign-in on this server. */
export function authKitTested(dir: string, values: Values, key: string): boolean {
    const proof = readAuthKitProof(dir)
    if (!proof || !authKitComplete(values)) return false
    const expected = Buffer.from(authKitFingerprint(values, key), 'hex')
    const stored = Buffer.from(proof.fingerprint, 'hex')
    return expected.length === stored.length && timingSafeEqual(expected, stored)
}
