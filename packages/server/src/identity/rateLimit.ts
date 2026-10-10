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

import { LOGIN_FAILURE_LIMIT, LOGIN_FAILURE_WINDOW_MS } from './constants'

/**
 * 10 failed break-glass sign-ins per client IP and per account email per 15 minutes.
 * A success does not clear the window. Rows outside the window are dropped.
 */
export interface LoginLimiter {
    blocked(ip: string, account: string, now: number): Promise<boolean>
    recordFailure(ip: string, account: string, now: number): Promise<void>
}

type FailureRow = { scope: 'ip' | 'account'; key: string; at: number }

export class LoginRateLimit implements LoginLimiter {
    private rows: FailureRow[] = []

    constructor(private readonly limit = LOGIN_FAILURE_LIMIT, private readonly windowMs = LOGIN_FAILURE_WINDOW_MS) {}

    async blocked(ip: string, account: string, now: number): Promise<boolean> {
        this.prune(now)
        if (this.count('ip', ip, now) >= this.limit) return true
        const email = account.trim().toLowerCase()
        return email !== '' && this.count('account', email, now) >= this.limit
    }

    async recordFailure(ip: string, account: string, now: number): Promise<void> {
        this.prune(now)
        this.rows.push({ scope: 'ip', key: ip, at: now })
        const email = account.trim().toLowerCase()
        if (email) this.rows.push({ scope: 'account', key: email, at: now })
    }

    retained(): number {
        return this.rows.length
    }

    private count(scope: FailureRow['scope'], key: string, now: number): number {
        return this.rows.filter((row) => row.scope === scope && row.key === key && now - row.at < this.windowMs).length
    }

    private prune(now: number): void {
        this.rows = this.rows.filter((row) => now - row.at < this.windowMs)
    }
}
