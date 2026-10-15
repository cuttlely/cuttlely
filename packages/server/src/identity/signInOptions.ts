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

import { localAdminEnabled, localUsersMode, workosConfigured } from './constants'

export interface SignInOptions {
    authKit: boolean
    localAdmin: boolean
    /** True only when CUTTLELY_LOCAL_USERS is exactly true and AuthKit is not configured. */
    localUsers: boolean
    mail: boolean
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
        mail: mailConfigured(env)
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
