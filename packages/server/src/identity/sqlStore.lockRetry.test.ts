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
import type { DataSource } from 'typeorm'
import { SetupCodeRow } from './setupCode'
import {
    SETUP_LOCK_RETRY_ATTEMPTS,
    SETUP_LOCK_RETRY_BASE_MS,
    SETUP_LOCK_RETRY_CAP_MS,
    SqlSetupCodeStore,
    setupLockDelayMs
} from './sqlStore'

const ROW: SetupCodeRow = {
    codeHmac: 'ab'.repeat(32),
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_003_600_000,
    consumedAt: null
}

function lockError(shape: 'coded' | 'wait' | 'errno' | 'wait-errno' | 'wrapped'): Error {
    if (shape === 'wrapped') {
        return Object.assign(new Error('lock conflict'), {
            driverError: { code: 'ER_LOCK_DEADLOCK', errno: 1213 }
        })
    }
    if (shape === 'wait') return Object.assign(new Error('lock conflict'), { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 })
    if (shape === 'errno') return Object.assign(new Error('lock conflict'), { errno: 1213 })
    if (shape === 'wait-errno') return Object.assign(new Error('lock conflict'), { errno: 1205 })
    return Object.assign(new Error('lock conflict'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 })
}

function fakeMysql(failures: number, error: () => unknown): { source: DataSource; runners: () => number } {
    let created = 0
    const source = {
        options: { type: 'mysql' as const },
        createQueryRunner() {
            created += 1
            const attempt = created
            return {
                connection: { options: { type: 'mysql' as const } },
                async connect() {
                    if (attempt <= failures) throw error()
                },
                async startTransaction() {
                    return undefined
                },
                async commitTransaction() {
                    return undefined
                },
                async rollbackTransaction() {
                    return undefined
                },
                async release() {
                    return undefined
                },
                async query(sql: string) {
                    if (sql.startsWith('INSERT')) return { affectedRows: 1 }
                    if (sql.startsWith('UPDATE')) return { affectedRows: 0 }
                    return [
                        {
                            codeHmac: ROW.codeHmac,
                            issuedAt: ROW.issuedAt,
                            expiresAt: ROW.expiresAt,
                            consumedAt: ROW.consumedAt
                        }
                    ]
                }
            }
        }
    }
    return { source: source as unknown as DataSource, runners: () => created }
}

describe('setup code lock retry', () => {
    it('uses a short base, a 250 ms cap, and six tries', () => {
        expect(SETUP_LOCK_RETRY_BASE_MS).toBe(20)
        expect(SETUP_LOCK_RETRY_CAP_MS).toBe(250)
        expect(SETUP_LOCK_RETRY_ATTEMPTS).toBe(6)
        expect(setupLockDelayMs(0, () => 1)).toBe(20)
        expect(setupLockDelayMs(1, () => 0.5)).toBe(20)
        expect(setupLockDelayMs(1, () => 0.5)).toBeLessThan(setupLockDelayMs(1, () => 1))
        expect(setupLockDelayMs(4, () => 1)).toBe(250)
        expect(setupLockDelayMs(5, () => 1)).toBe(250)
    })

    it('returns the write after lock conflicts, waiting with growing jittered delays', async () => {
        const shapes = ['coded', 'wait', 'errno', 'wait-errno', 'wrapped'] as const
        let shape = 0
        const sleeps: number[] = []
        const fake = fakeMysql(shapes.length, () => lockError(shapes[shape++]))
        const store = new SqlSetupCodeStore(fake.source, {
            sleep: async (ms) => {
                sleeps.push(ms)
            },
            random: () => 0.8
        })
        await expect(store.save(ROW, null)).resolves.toBe('inserted')
        expect(fake.runners()).toBe(shapes.length + 1)
        // 0.8 of 20, 40, 80, 160, then 0.8 of the 250 ms cap (20 * 16 would be 320).
        expect(sleeps).toEqual([16, 32, 64, 128, 200])
        expect(sleeps.every((ms) => ms <= SETUP_LOCK_RETRY_CAP_MS)).toBe(true)
        for (let i = 1; i < sleeps.length; i++) expect(sleeps[i]).toBeGreaterThan(sleeps[i - 1])
        expect(sleeps[0]).toBeLessThan(SETUP_LOCK_RETRY_BASE_MS)
        expect(sleeps[4]).toBeLessThan(Math.round(0.8 * SETUP_LOCK_RETRY_BASE_MS * 2 ** 4))
    })

    it('throws a non-lock error on the first try', async () => {
        const error = Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY', errno: 1062 })
        const sleeps: number[] = []
        const fake = fakeMysql(4, () => error)
        const store = new SqlSetupCodeStore(fake.source, {
            sleep: async (ms) => {
                sleeps.push(ms)
            },
            random: () => 1
        })
        await expect(store.save(ROW, null)).rejects.toBe(error)
        expect(fake.runners()).toBe(1)
        expect(sleeps).toEqual([])
    })

    it('rethrows the lock conflict once the tries are used', async () => {
        const error = lockError('wait')
        const sleeps: number[] = []
        const fake = fakeMysql(SETUP_LOCK_RETRY_ATTEMPTS + 2, () => error)
        const store = new SqlSetupCodeStore(fake.source, {
            sleep: async (ms) => {
                sleeps.push(ms)
            },
            random: () => 1
        })
        await expect(store.save(ROW, null)).rejects.toBe(error)
        expect(fake.runners()).toBe(SETUP_LOCK_RETRY_ATTEMPTS)
        expect(sleeps).toEqual([20, 40, 80, 160, 250])
        expect(Math.max(...sleeps)).toBe(SETUP_LOCK_RETRY_CAP_MS)
    })
})
