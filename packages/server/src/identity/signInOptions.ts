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

import { localAdminEnabled, workosConfigured } from './constants'

export interface SignInOptions {
    authKit: boolean
    localAdmin: boolean
    mail: boolean
}

/**
 * Password reset stays off until a sender and a reset route exist.
 * SMTP_HOST alone used to show Forgot password, and that form posted to a 404.
 */
export function mailConfigured(_env: NodeJS.ProcessEnv = process.env): boolean {
    return false
}

/** Public flags for the sign-in screen. The password form is on only when the break-glass flag is exactly true. */
export function signInOptionsBody(env: NodeJS.ProcessEnv = process.env): SignInOptions {
    return {
        authKit: workosConfigured(env),
        localAdmin: localAdminEnabled(env),
        mail: mailConfigured(env)
    }
}
