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

import { createHash } from 'crypto'
import { LOGIN_FAILURE_LIMIT, LOGIN_FAILURE_WINDOW_MS } from './constants'

/**
 * 10 failed sign-ins per client IP and per account per 15 minutes.
 * A success does not clear the window. The account key is a hash of the normalized email,
 * kept in a capped map so unknown emails lock out the same way without an unbounded store.
 */
export interface LoginLimiter {
    blocked(ip: string, account: string, now: number): Promise<boolean>
    recordFailure(ip: string, account: string, now: number): Promise<void>
}

type FailureRow = { scope: 'ip'; key: string; at: number }

/** How many distinct email hashes to remember. Older ones are dropped first. */
export const ACCOUNT_LOCK_CAP = 1024

export function accountLockKey(email: string): string {
    return createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}

/**
 * Failed attempts keyed by a hash of the email. Expired attempts are dropped.
 * When the map is over its cap, the least recently used email is dropped.
 */
export class BoundedAccountFailures {
    private entries = new Map<string, number[]>()

    constructor(private readonly cap = ACCOUNT_LOCK_CAP) {}

    blocked(account: string, now: number, limit: number, windowMs: number): boolean {
        const key = this.key(account)
        if (!key) return false
        return this.fresh(key, now, windowMs).length >= limit
    }

    record(account: string, now: number, windowMs: number): void {
        const key = this.key(account)
        if (!key) return
        const times = this.fresh(key, now, windowMs)
        times.push(now)
        this.entries.delete(key)
        this.entries.set(key, times)
        while (this.entries.size > this.cap) {
            const oldest = this.entries.keys().next().value
            if (oldest === undefined) break
            this.entries.delete(oldest)
        }
    }

    size(): number {
        return this.entries.size
    }

    private key(account: string): string {
        const email = account.trim().toLowerCase()
        if (!email) return ''
        return accountLockKey(email)
    }

    private fresh(key: string, now: number, windowMs: number): number[] {
        const times = (this.entries.get(key) || []).filter((at) => now - at < windowMs)
        this.entries.delete(key)
        if (times.length) this.entries.set(key, times)
        return times
    }
}

export class LoginRateLimit implements LoginLimiter {
    private rows: FailureRow[] = []
    private readonly accounts: BoundedAccountFailures

    constructor(
        private readonly limit = LOGIN_FAILURE_LIMIT,
        private readonly windowMs = LOGIN_FAILURE_WINDOW_MS,
        accountCap = ACCOUNT_LOCK_CAP
    ) {
        this.accounts = new BoundedAccountFailures(accountCap)
    }

    async blocked(ip: string, account: string, now: number): Promise<boolean> {
        this.prune(now)
        if (this.count(ip, now) >= this.limit) return true
        return this.accounts.blocked(account, now, this.limit, this.windowMs)
    }

    async recordFailure(ip: string, account: string, now: number): Promise<void> {
        this.prune(now)
        this.rows.push({ scope: 'ip', key: ip, at: now })
        this.accounts.record(account, now, this.windowMs)
    }

    retained(): number {
        return this.rows.length
    }

    accountBuckets(): number {
        return this.accounts.size()
    }

    private count(ip: string, now: number): number {
        return this.rows.filter((row) => row.key === ip && now - row.at < this.windowMs).length
    }

    private prune(now: number): void {
        this.rows = this.rows.filter((row) => now - row.at < this.windowMs)
    }
}
