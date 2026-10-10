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
 * First-run setup link for a fresh local install.
 */
import crypto from 'crypto'
import { cookiePasswordOk, localAdminEnabled, workosConfigured } from './constants'

// A fresh install with no account accepts Setup Account from this machine (loopback). Through Docker's published
// port the request comes from the container network instead, so the server prints a one-time link with this code
// in its log. The code lives in memory only, changes on every start, and is useless once the first account exists.
let code: string | undefined
// Set once the link has done its job (the first account, or the first sign-in method, was set up). A retired code
// never matches again, even before the restart that follows.
let retired = false

export function firstRunSetupCode(): string {
    if (!code) code = crypto.randomBytes(12).toString('base64url')
    return code
}

export function setupCodeMatches(candidate: unknown): boolean {
    if (!code || retired || typeof candidate !== 'string' || !candidate) return false
    const given = Buffer.from(candidate)
    const expected = Buffer.from(code)
    return given.length === expected.length && crypto.timingSafeEqual(given, expected)
}

export function firstRunSetupLink(port: number | string): string {
    return `http://localhost:${port}/organization-setup?code=${firstRunSetupCode()}`
}

/** The setup link has been used. Its code stops working at once. */
export function retireFirstRunSetupCode(): void {
    retired = true
}

export function firstRunSetupCodeRetired(): boolean {
    return retired
}

/** Test hook: forget the code so the next call makes a new one. */
export function resetFirstRunSetupCode(): void {
    code = undefined
    retired = false
}

/** True when nobody could sign in: the password sign-in is off and AuthKit is not set up. */
export function noSignInMethod(env: NodeJS.ProcessEnv = process.env): boolean {
    return !localAdminEnabled(env) && !(workosConfigured(env) && cookiePasswordOk(env.WORKOS_COOKIE_PASSWORD))
}

/** The address people use to reach this server: Render's public address, APP_URL, or this machine. */
export function publicOrigin(port: number | string, env: NodeJS.ProcessEnv = process.env): string {
    for (const candidate of [env.RENDER_EXTERNAL_URL, env.APP_URL]) {
        const value = (candidate ?? '').trim()
        if (!value) continue
        try {
            const url = new URL(value)
            if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
        } catch {
            // not an address; try the next one
        }
    }
    return `http://localhost:${port}`
}

/** The one-time link that opens Sign-in & identity when no sign-in method is on. */
export function serverSetupLink(port: number | string, env: NodeJS.ProcessEnv = process.env): string {
    return `${publicOrigin(port, env)}/server-setup?code=${firstRunSetupCode()}`
}

/**
 * On a fresh install with no account yet, prints where to start. With the local account on, the link creates the
 * first account. With no sign-in method at all (for example Render without AuthKit), the link opens only
 * Sign-in & identity, works once, and stops working when the first account exists. Either link carries the
 * one-time code, so it also works through Docker's published port. When accounts exist but no sign-in method is on,
 * it prints how to turn one back on instead.
 */
export async function announceFirstRunSetup(
    port: number | string,
    countUsers: () => Promise<number>,
    log: (line: string) => void,
    localAdmin: boolean,
    env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
    if (!localAdmin && !noSignInMethod(env)) return false
    if ((await countUsers()) > 0) {
        if (localAdmin) return false
        // Accounts exist but nothing lets them in, for example a .env that lost CUTTLELY_LOCAL_ADMIN. Say how to get back.
        log(
            '🔑 [server]: No sign-in method is on, so nobody can sign in. Turn on the password sign-in (CUTTLELY_LOCAL_ADMIN=true) or AuthKit on the host, then restart.'
        )
        return true
    }
    if (localAdmin) {
        log(`👋 [server]: No account yet. Open ${firstRunSetupLink(port)} to create yours.`)
        return true
    }
    log(`🔑 [server]: No sign-in method is on yet. Open ${serverSetupLink(port, env)} to set one up. The link works once.`)
    return true
}
