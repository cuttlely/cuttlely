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

import { createHmac } from 'crypto'
import { LOGIN_FAILURE_WINDOW_MS } from './constants'
import { runtimeNumber } from '../settings/runtime'
import { authSecret } from './authSecrets'

/**
 * 10 failed sign-ins per client address and per email per 15 minutes.
 * A success does not clear the window. The account key is an HMAC of the normalized email
 * under the server secret, so the address itself is not stored. Rows outside the window are dropped,
 * and the oldest email keys are dropped when too many distinct addresses have failed.
 */
export interface LoginLimiter {
    blocked(ip: string, account: string, now: number): Promise<boolean>
    recordFailure(ip: string, account: string, now: number): Promise<void>
}

type FailureRow = { scope: 'ip' | 'account'; key: string; at: number }

/** How many distinct email keys to keep. Older ones are dropped first. */
export const ACCOUNT_LOCK_CAP = 1024

const LOCK_PURPOSE = 'cuttlely-login-failure-v1'

/** HMAC of the normalized email. Empty when there is no address or no server secret. */
export function accountLockKey(email: string, secret = loginFailureSecret()): string {
    const normalized = email.trim().toLowerCase()
    if (!normalized || !secret) return ''
    return createHmac('sha256', secret).update(`${LOCK_PURPOSE}\0${normalized}`).digest('hex')
}

function loginFailureSecret(): string {
    const fromEnv = process.env.TOKEN_HASH_SECRET?.trim()
    if (fromEnv) return fromEnv
    try {
        return authSecret('TOKEN_HASH_SECRET')
    } catch {
        return ''
    }
}

export class LoginRateLimit implements LoginLimiter {
    private rows: FailureRow[] = []

    constructor(
        private readonly limit: number | (() => number) = () => runtimeNumber('CUTTLELY_LOGIN_FAILURE_LIMIT'),
        private readonly windowMs = LOGIN_FAILURE_WINDOW_MS,
        private readonly accountCap = ACCOUNT_LOCK_CAP
    ) {}

    private cap(): number {
        return typeof this.limit === 'function' ? this.limit() : this.limit
    }

    async blocked(ip: string, account: string, now: number): Promise<boolean> {
        this.prune(now)
        if (this.count('ip', ip, now) >= this.cap()) return true
        const key = accountLockKey(account)
        return key !== '' && this.count('account', key, now) >= this.cap()
    }

    async recordFailure(ip: string, account: string, now: number): Promise<void> {
        this.prune(now)
        this.rows.push({ scope: 'ip', key: ip, at: now })
        const key = accountLockKey(account)
        if (key) this.rows.push({ scope: 'account', key, at: now })
        this.evictAccounts()
    }

    retained(): number {
        return this.rows.length
    }

    accountBuckets(): number {
        return new Set(this.rows.filter((row) => row.scope === 'account').map((row) => row.key)).size
    }

    private count(scope: FailureRow['scope'], key: string, now: number): number {
        return this.rows.filter((row) => row.scope === scope && row.key === key && now - row.at < this.windowMs).length
    }

    private prune(now: number): void {
        this.rows = this.rows.filter((row) => now - row.at < this.windowMs)
    }

    /** Drop the least recently used email keys until the distinct count fits the cap. */
    private evictAccounts(): void {
        const latest = new Map<string, number>()
        for (const row of this.rows) {
            if (row.scope !== 'account') continue
            latest.set(row.key, Math.max(latest.get(row.key) || 0, row.at))
        }
        const oldest = [...latest.entries()].sort((a, b) => a[1] - b[1]).map(([key]) => key)
        const extra = oldest.length - this.accountCap
        if (extra <= 0) return
        const drop = new Set(oldest.slice(0, extra))
        this.rows = this.rows.filter((row) => row.scope !== 'account' || !drop.has(row.key))
    }
}
