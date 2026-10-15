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
 *
 * Local session lifetimes are read on every authenticated request.
 * A shorter idle or absolute value ends a session that was already issued.
 * Sessions issued before these settings existed used the constants below.
 */

import { ABSOLUTE_MS, IDLE_MS } from './constants'
import { sessionAbsoluteHours, sessionIdleMinutes } from '../settings/runtime'
import { LocalSession } from './types'

export function sessionLimitsMs(env: NodeJS.ProcessEnv = process.env, now = Date.now()): { idleMs: number; absoluteMs: number } {
    return {
        idleMs: sessionIdleMinutes(env, now) * 60 * 1000,
        absoluteMs: sessionAbsoluteHours(env, now) * 60 * 60 * 1000
    }
}

/** Issue time and last activity. Missing fields are derived from the old fixed lifetimes. */
export function localSessionTimes(row: LocalSession): { issuedAt: number; lastSeenAt: number } {
    const issuedAt = row.issuedAt?.getTime() ?? row.absoluteExpires.getTime() - ABSOLUTE_MS
    if (row.lastSeenAt) return { issuedAt, lastSeenAt: row.lastSeenAt.getTime() }
    const guessed = row.idleExpires.getTime() - IDLE_MS
    const lastSeenAt = Math.min(row.idleExpires.getTime(), Math.max(guessed, issuedAt))
    return { issuedAt, lastSeenAt }
}

/**
 * Why a local session must end, or null when it is still valid.
 * The stored expiry is checked as well, so a session cannot outlive the deadline it was given.
 */
export function localSessionBlock(row: LocalSession, now: number, limits = sessionLimitsMs()): 'idle' | 'absolute' | null {
    const times = localSessionTimes(row)
    if (now >= times.issuedAt + limits.absoluteMs) return 'absolute'
    if (now >= row.absoluteExpires.getTime()) return 'absolute'
    if (now >= times.lastSeenAt + limits.idleMs) return 'idle'
    if (now >= row.idleExpires.getTime()) return 'idle'
    return null
}
