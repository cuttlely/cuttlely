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

const scryptAsync = promisify(scrypt)
const PREFIX = 'scrypt'

/** Same rules as the UI password schema. Used only for the break-glass account and `pnpm user`. */
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

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
    if (!stored || !stored.startsWith(`${PREFIX}$`)) return false
    const parts = stored.split('$')
    if (parts.length !== 3) return false
    const salt = parts[1]
    const expected = Buffer.from(parts[2], 'base64')
    const actual = (await scryptAsync(password, salt, expected.length)) as Buffer
    if (actual.length !== expected.length) return false
    return timingSafeEqual(actual, expected)
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
