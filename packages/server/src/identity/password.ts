/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'crypto'
import { promisify } from 'util'
import bcrypt from 'bcryptjs'

const scryptAsync = promisify(scrypt)
const PREFIX = 'scrypt'
const BCRYPT_REGEX = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/
const BCRYPT_MIN_COST = 4
const BCRYPT_MAX_COST = 12

/**
 * Well-formed scrypt string used when the account cannot be checked.
 * verifyPassword still runs scrypt, so unknown, empty, disabled, and wrong-password failures take the same work.
 * 16-byte salt, 32-byte key. Not a password anyone can sign in with.
 */
export const DUMMY_PASSWORD_HASH = 'scrypt$AAECAwQFBgcICQoLDA0ODw==$AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA='

/**
 * Well-formed bcrypt string at cost 10. Used to pad a failed or dummy scrypt compare
 * while any accepted bcrypt hash is still stored. Not a password anyone can sign in with.
 */
export const DUMMY_BCRYPT_HASH = '$2a$10$izJQJlD9yogrwzhiB6CQA.X0TmTi5UTGyQsoXeQpetpnyAGhVJWJO'

function isScryptHash(stored: string): boolean {
    return stored.startsWith(`${PREFIX}$`)
}

/** Parsed bcrypt cost when the string matches the tight form; otherwise null. */
export function bcryptCost(stored: string): number | null {
    const match = BCRYPT_REGEX.exec(stored)
    if (!match) return null
    return Number(match[1])
}

/**
 * Real hash only when this account may sign in.
 * A miss always uses the scrypt dummy. When any accepted bcrypt hash is still stored,
 * verifyPassword then pads dummy bcrypt, so unknown, disabled, and a wrong scrypt password
 * do the same work. Scrypt-only installs stay on the scrypt dummy.
 */
export function hashForLoginCompare(eligible: boolean, credential: string | null, _bcryptPresent = false): string {
    if (eligible && credential && (isScryptHash(credential) || isBcryptHash(credential))) return credential
    return DUMMY_PASSWORD_HASH
}

/** Same rules as the UI password schema. Used for the break-glass account, local user passwords, and `pnpm user`. */
export function passwordErrors(password: string): string[] {
    const errors: string[] = []
    if (password.length < 8) errors.push('Password must be at least 8 characters')
    if (password.length > 128) errors.push('Password must not be more than 128 characters')
    if (!/[a-z]/.test(password)) errors.push('Password must contain at least one lowercase letter')
    if (!/[A-Z]/.test(password)) errors.push('Password must contain at least one uppercase letter')
    if (!/\d/.test(password)) errors.push('Password must contain at least one digit')
    if (!/[^a-zA-Z0-9]/.test(password)) errors.push('Password must contain at least one special character')
    return errors
}

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16).toString('base64')
    const key = (await scryptAsync(password, salt, 32)) as Buffer
    return `${PREFIX}$${salt}$${key.toString('base64')}`
}

async function compareScrypt(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$')
    if (parts.length !== 3) return false
    const salt = parts[1]
    const expected = Buffer.from(parts[2], 'base64')
    const actual = (await scryptAsync(password, salt, expected.length)) as Buffer
    if (actual.length !== expected.length) return false
    return timingSafeEqual(actual, expected)
}

async function compareBcrypt(password: string, stored: string): Promise<boolean> {
    try {
        return await bcrypt.compare(password, stored)
    } catch {
        return false
    }
}

/**
 * When `bcryptPresent` is set, a failed compare also runs the other dummy so unknown,
 * disabled, and wrong-password paths pay both scrypt and bcrypt work.
 */
export async function verifyPassword(password: string, stored: string | null, bcryptPresent = false): Promise<boolean> {
    if (stored && isScryptHash(stored)) {
        const ok = await compareScrypt(password, stored)
        if (!ok && bcryptPresent) await compareBcrypt(password, DUMMY_BCRYPT_HASH)
        return ok
    }
    if (stored && isBcryptHash(stored)) {
        const ok = await compareBcrypt(password, stored)
        if (!ok && bcryptPresent) await compareScrypt(password, DUMMY_PASSWORD_HASH)
        return ok
    }
    if (bcryptPresent) {
        await compareScrypt(password, DUMMY_PASSWORD_HASH)
        await compareBcrypt(password, DUMMY_BCRYPT_HASH)
    }
    return false
}

/** True only for `$2a$` / `$2b$` / `$2y$` with 53 hash chars and a cost of 4 to 12. */
export function isBcryptHash(stored: string): boolean {
    const cost = bcryptCost(stored)
    return cost !== null && cost >= BCRYPT_MIN_COST && cost <= BCRYPT_MAX_COST
}

/** True when local sign-in can check a password against this stored value. */
export function isUsablePasswordHash(stored: string | null | undefined): boolean {
    if (!stored) return false
    return (isScryptHash(stored) && stored.split('$').length === 3) || isBcryptHash(stored)
}

export function tokensEqual(left: string, right: string): boolean {
    const a = Buffer.from(left)
    const b = Buffer.from(right)
    if (a.length !== b.length) {
        timingSafeEqual(a, a)
        return false
    }
    return timingSafeEqual(a, b)
}

export function randomToken(): string {
    return randomBytes(32).toString('base64url')
}

/** Break-glass cookie tokens are stored as sha256 hex, never as the raw cookie value. */
export function hashSessionToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
}
