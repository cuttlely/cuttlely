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
 * Recorded once per transition. A later restart while AuthKit stays on
 * must not delete the owner break-glass session created after the switch.
 */

export interface AuthKitSwitchState {
    /** True while AuthKit is the mode the web server last applied. */
    configured: boolean
    /** Local sessions deleted the last time AuthKit became configured. */
    sessionsEnded: number
    /** When that deletion ran. Null until AuthKit has been turned on once. */
    switchedAt: string | null
}

export interface AuthKitSwitchApply {
    /**
     * Set only by the web server when its own environment has AuthKit off.
     * A process that merely does not see the AuthKit variables must leave a recorded-on switch alone,
     * or the next web start treats AuthKit as newly on and deletes local sessions again.
     */
    recordOff?: boolean
}

/**
 * `endSessions` is true only on the transition from off to on.
 * `recordOff` is the web server recording that AuthKit was turned off. Without it, an unconfigured
 * observation does not change a switch that is already on, and does not restore deleted rows.
 */
export function nextAuthKitSwitch(
    previous: AuthKitSwitchState | null,
    configured: boolean,
    at: Date,
    liveSessions: number,
    options: AuthKitSwitchApply = {}
): { endSessions: boolean; state: AuthKitSwitchState } {
    if (configured && previous?.configured !== true) {
        return {
            endSessions: true,
            state: {
                configured: true,
                sessionsEnded: liveSessions,
                switchedAt: at.toISOString()
            }
        }
    }
    if (!configured && previous?.configured === true) {
        if (!options.recordOff) return { endSessions: false, state: previous }
        return {
            endSessions: false,
            state: {
                configured: false,
                sessionsEnded: previous.sessionsEnded,
                switchedAt: previous.switchedAt
            }
        }
    }
    if (!previous) {
        return { endSessions: false, state: { configured: false, sessionsEnded: 0, switchedAt: null } }
    }
    return { endSessions: false, state: previous }
}

/** Applies `nextAuthKitSwitch` to an in-memory session map. The returned state is the new record. */
export function switchedSessions<T>(
    previous: AuthKitSwitchState | null,
    configured: boolean,
    at: Date,
    sessions: Map<string, T>,
    options: AuthKitSwitchApply = {}
): AuthKitSwitchState {
    const next = nextAuthKitSwitch(previous, configured, at, sessions.size, options)
    if (next.endSessions) sessions.clear()
    return next.state
}
