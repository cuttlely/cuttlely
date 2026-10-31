/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Sign-in screen contract for docs/identity/phase0-spec.md section 8.
 */

import { AuthKitSwitchState } from './authKitSwitch'
import type { AuthenticationState } from './authenticationState'
import { localAdminEnabled, localUsersMode, localUsersSetting, workosConfigured, workosEnvironmentConfigured } from './constants'

export interface SignInOptions {
    authKit: boolean
    localAdmin: boolean
    /** True only when CUTTLELY_LOCAL_USERS is exactly true and AuthKit is not configured. */
    localUsers: boolean
    mail: boolean
    /** The separate owner recovery page is always present. */
    ownerRecovery: true
}

export const SIGN_IN_METHOD = {
    authKit: 'authKit',
    localAdmin: 'localAdmin',
    localUsers: 'localUsers',
    mail: 'mail'
} as const

/**
 * The sign-in page's Forgot password flag stays off.
 * Admin invite and reset links can send mail when SMTP is configured.
 * That is not this flag: turning it on would show a form that still has no self-service route.
 */
export function mailConfigured(_env: NodeJS.ProcessEnv = process.env): boolean {
    return false
}

/** Public flags for the sign-in screen. The password form is on only when the break-glass flag is exactly true. */
export function signInOptionsBody(env: NodeJS.ProcessEnv = process.env): SignInOptions {
    return {
        authKit: workosConfigured(env),
        localAdmin: localAdminEnabled(env),
        localUsers: localUsersMode(env),
        mail: mailConfigured(env),
        ownerRecovery: true
    }
}

/** Names of the methods that are on. Methods that are off are omitted. */
export function enabledSignInMethods(env: NodeJS.ProcessEnv = process.env): { methods: string[] } {
    const options = signInOptionsBody(env)
    const methods: string[] = []
    if (options.authKit) methods.push(SIGN_IN_METHOD.authKit)
    if (options.localAdmin) methods.push(SIGN_IN_METHOD.localAdmin)
    if (options.localUsers) methods.push(SIGN_IN_METHOD.localUsers)
    if (options.mail) methods.push(SIGN_IN_METHOD.mail)
    return { methods }
}

export type LocalSessionSwitchStatus = 'open' | 'ended' | 'pending'

export interface AuthOptionsStatus {
    authKit: boolean
    /** True only while local password sign-in for any user is on. AuthKit turns it off. */
    localPasswordSignIn: boolean
    /** The owner break-glass route. Independent of local password sign-in. */
    breakGlassOwner: boolean
    /**
     * `ended` after AuthKit has been turned on and the existing local sessions were deleted.
     * `pending` when AuthKit is configured and that deletion has not been recorded yet.
     * `open` when AuthKit is off. Deleted sessions are not restored.
     */
    localSessions: LocalSessionSwitchStatus
    /** How many local sessions were deleted the last time AuthKit became configured. */
    sessionsEnded: number
}

type AuthOptionsState = Pick<AuthenticationState, 'activeMethod' | 'sessionsEnded' | 'changedAt'> | AuthKitSwitchState

function isDurableState(state: AuthOptionsState): state is Pick<AuthenticationState, 'activeMethod' | 'sessionsEnded' | 'changedAt'> {
    return 'activeMethod' in state
}

/** Public body for GET /api/v1/auth/options. Durable method state takes precedence over the older switch row. */
export function authOptionsBody(
    env: NodeJS.ProcessEnv = process.env,
    state: AuthOptionsState | null = null
): { methods: string[]; status: AuthOptionsStatus } {
    const durable = state && isDurableState(state) ? state : null
    const legacy = state && !isDurableState(state) ? state : null
    const options = signInOptionsBody(env)
    const authKit = durable ? durable.activeMethod === 'workos' && workosEnvironmentConfigured(env) : options.authKit
    const localPasswordSignIn = durable ? durable.activeMethod === 'local' && localUsersSetting(env) : options.localUsers
    let localSessions: LocalSessionSwitchStatus = 'open'
    if (durable) localSessions = durable.activeMethod === 'workos' ? 'ended' : 'open'
    else if (options.authKit) localSessions = legacy?.configured ? 'ended' : 'pending'
    const methods: string[] = []
    if (authKit) methods.push(SIGN_IN_METHOD.authKit)
    if (options.localAdmin) methods.push(SIGN_IN_METHOD.localAdmin)
    if (localPasswordSignIn) methods.push(SIGN_IN_METHOD.localUsers)
    if (options.mail) methods.push(SIGN_IN_METHOD.mail)
    return {
        methods,
        status: {
            authKit,
            localPasswordSignIn,
            breakGlassOwner: options.localAdmin,
            localSessions,
            sessionsEnded: state?.sessionsEnded ?? 0
        }
    }
}
