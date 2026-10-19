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

import bcrypt from 'bcryptjs'
import {
    DUMMY_BCRYPT_HASH,
    DUMMY_PASSWORD_HASH,
    bcryptCost,
    hashForLoginCompare,
    hashPassword,
    isBcryptHash,
    verifyPassword
} from './password'

const GOOD = 'Sup3r-Secret!'
const OTHER = 'An0ther-Secret!'
const BCRYPT_TAIL = 'A'.repeat(53)

describe('isBcryptHash', () => {
    it('accepts $2a$, $2b$, and $2y$ with cost 4 to 12 and 53 hash characters', () => {
        expect(isBcryptHash(`$2a$10$${BCRYPT_TAIL}`)).toBe(true)
        expect(isBcryptHash(`$2b$10$${BCRYPT_TAIL}`)).toBe(true)
        expect(isBcryptHash(`$2y$12$${BCRYPT_TAIL}`)).toBe(true)
        expect(isBcryptHash(`$2a$04$${BCRYPT_TAIL}`)).toBe(true)
        expect(bcryptCost(`$2a$10$${BCRYPT_TAIL}`)).toBe(10)
    })

    it('rejects a cost outside 4-12, a short or long payload, $2x$, and an empty string', () => {
        const costly = `$2a$31$${BCRYPT_TAIL}`
        expect(isBcryptHash(costly)).toBe(false)
        expect(bcryptCost(costly)).toBe(31)
        expect(isBcryptHash(`$2a$03$${BCRYPT_TAIL}`)).toBe(false)
        expect(isBcryptHash(`$2a$13$${BCRYPT_TAIL}`)).toBe(false)
        expect(isBcryptHash('$2a$10$abc')).toBe(false)
        expect(isBcryptHash(`$2a$10$${BCRYPT_TAIL}x`)).toBe(false)
        expect(isBcryptHash(`$2x$10$${BCRYPT_TAIL}`)).toBe(false)
        expect(isBcryptHash('')).toBe(false)
        expect(bcryptCost('$2a$10$abc')).toBeNull()
    })
})

describe('hashForLoginCompare', () => {
    it('returns the real hash when eligible and the scrypt dummy on every miss', () => {
        const scrypt = 'scrypt$salt$key'
        const bcryptHash = `$2a$10$${BCRYPT_TAIL}`
        expect(hashForLoginCompare(true, scrypt)).toBe(scrypt)
        expect(hashForLoginCompare(true, bcryptHash)).toBe(bcryptHash)
        expect(hashForLoginCompare(false, bcryptHash)).toBe(DUMMY_PASSWORD_HASH)
        expect(hashForLoginCompare(false, scrypt)).toBe(DUMMY_PASSWORD_HASH)
        expect(hashForLoginCompare(true, `$2a$31$${BCRYPT_TAIL}`)).toBe(DUMMY_PASSWORD_HASH)
        expect(hashForLoginCompare(false, null)).toBe(DUMMY_PASSWORD_HASH)
    })

    it('keeps the scrypt dummy for a null or ineligible miss while any bcrypt hash is still stored', () => {
        const scrypt = 'scrypt$salt$key'
        expect(hashForLoginCompare(false, null, true)).toBe(DUMMY_PASSWORD_HASH)
        expect(hashForLoginCompare(false, scrypt, true)).toBe(DUMMY_PASSWORD_HASH)
        expect(hashForLoginCompare(false, '', true)).toBe(DUMMY_PASSWORD_HASH)
        expect(hashForLoginCompare(true, scrypt, true)).toBe(scrypt)
        expect(hashForLoginCompare(false, null, false)).toBe(DUMMY_PASSWORD_HASH)
    })
})

describe('verifyPassword', () => {
    it('accepts a matching scrypt or bcrypt hash and rejects a wrong password', async () => {
        const scrypt = await hashPassword(GOOD)
        const bcryptHash = bcrypt.hashSync(GOOD, 10)
        expect(await verifyPassword(GOOD, scrypt)).toBe(true)
        expect(await verifyPassword(OTHER, scrypt)).toBe(false)
        expect(await verifyPassword(GOOD, bcryptHash)).toBe(true)
        expect(await verifyPassword(OTHER, bcryptHash)).toBe(false)
    })

    it('accepts $2b$ and $2y$ prefixes of a valid hash', async () => {
        const hashed = bcrypt.hashSync(GOOD, 10)
        const body = hashed.replace(/^\$2[aby]\$/, '')
        expect(await verifyPassword(GOOD, `$2b$${body}`)).toBe(true)
        expect(await verifyPassword(GOOD, `$2y$${body}`)).toBe(true)
    })

    it('rejects $2a$31$ plus 53 valid characters quickly without bcrypt.compare', async () => {
        const costly = `$2a$31$${BCRYPT_TAIL}`
        const compare = jest.spyOn(bcrypt, 'compare')
        const started = Date.now()
        expect(await verifyPassword(GOOD, costly)).toBe(false)
        const elapsed = Date.now() - started
        expect(compare).not.toHaveBeenCalled()
        expect(elapsed).toBeLessThan(50)
        compare.mockRestore()
    })

    it('rejects a malformed, empty, or missing hash without bcrypt.compare', async () => {
        const compare = jest.spyOn(bcrypt, 'compare')
        expect(await verifyPassword(GOOD, '$2a$10$abc')).toBe(false)
        expect(await verifyPassword(GOOD, `$2a$10$${BCRYPT_TAIL}x`)).toBe(false)
        expect(await verifyPassword(GOOD, '')).toBe(false)
        expect(await verifyPassword(GOOD, null)).toBe(false)
        expect(compare).not.toHaveBeenCalled()
        compare.mockRestore()
    })

    it('treats a thrown bcrypt.compare as a miss', async () => {
        const hashed = bcrypt.hashSync(GOOD, 10)
        const compare = jest.spyOn(bcrypt, 'compare').mockImplementationOnce(() => Promise.reject(new Error('bcrypt failed')))
        expect(await verifyPassword(GOOD, hashed)).toBe(false)
        compare.mockRestore()
    })

    it('runs dummy bcrypt after a failed scrypt compare while any bcrypt hash remains', async () => {
        const scrypt = await hashPassword(GOOD)
        const compare = jest.spyOn(bcrypt, 'compare')
        expect(await verifyPassword(OTHER, scrypt, true)).toBe(false)
        expect(compare).toHaveBeenCalledTimes(1)
        expect(compare.mock.calls[0][1]).toBe(DUMMY_BCRYPT_HASH)
        compare.mockRestore()
    })

    it('runs the same dummy bcrypt pad for a miss hash as for a failed eligible scrypt compare', async () => {
        const scrypt = await hashPassword(GOOD)
        const miss = hashForLoginCompare(false, null, true)
        expect(miss).toBe(DUMMY_PASSWORD_HASH)
        const compare = jest.spyOn(bcrypt, 'compare')
        expect(await verifyPassword(OTHER, miss, true)).toBe(false)
        expect(await verifyPassword(OTHER, scrypt, true)).toBe(false)
        expect(compare).toHaveBeenCalledTimes(2)
        expect(compare.mock.calls.every((call) => call[1] === DUMMY_BCRYPT_HASH)).toBe(true)
        compare.mockRestore()
    })

    it('does not run dummy bcrypt after a matching scrypt compare, or when no bcrypt hash remains', async () => {
        const scrypt = await hashPassword(GOOD)
        const compare = jest.spyOn(bcrypt, 'compare')
        expect(await verifyPassword(GOOD, scrypt, true)).toBe(true)
        expect(await verifyPassword(OTHER, scrypt, false)).toBe(false)
        expect(compare).not.toHaveBeenCalled()
        compare.mockRestore()
    })
})
