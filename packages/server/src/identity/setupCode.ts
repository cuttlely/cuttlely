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

// A fresh install with no account accepts the first account from this machine (loopback). Through Docker's published
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

const SERVICE_NAME = /^[A-Za-z0-9_.-]+$/

/** Compose service name for the setup-code help line. A bad value falls back to the published service name. */
export function setupServiceName(env: NodeJS.ProcessEnv = process.env): string {
    const raw = (env.CUTTLELY_SERVICE_NAME ?? '').trim()
    if (raw && raw.length <= 64 && SERVICE_NAME.test(raw)) return raw
    return 'cuttlely'
}

/** One address for the setup page. The code rides in the fragment, so the browser does not send it. */
export function setupPageLink(port: number | string, env: NodeJS.ProcessEnv = process.env): string {
    return `${publicOrigin(port, env)}/setup#code=${encodeURIComponent(firstRunSetupCode())}`
}

export function firstRunSetupLink(port: number | string, env: NodeJS.ProcessEnv = process.env): string {
    return setupPageLink(port, env)
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

/** The one-time link that opens setup when no sign-in method is on. Same address as the local-admin link. */
export function serverSetupLink(port: number | string, env: NodeJS.ProcessEnv = process.env): string {
    return setupPageLink(port, env)
}

export const SETUP_READY_REPRINT_MS = 5 * 60 * 1000

const READY_RULE = '─'.repeat(62)

/** The ready block printed while the first account still has to be created. */
export function setupReadyBlock(port: number | string, env: NodeJS.ProcessEnv = process.env): string[] {
    const code = firstRunSetupCode()
    const link = `${publicOrigin(port, env)}/setup#code=${encodeURIComponent(code)}`
    return [
        READY_RULE,
        '✅ Cuttlely is ready — finish setup:',
        `   ${link}      ← open on this machine`,
        `   Setup code: ${code}   (valid 60 min, works once)`,
        `   Remote/Docker? Open http://<your-host>:${port}/setup and paste the code.`,
        READY_RULE
    ]
}

export type FirstRunAnnounce = 'setup' | 'recover' | 'none'

/**
 * On a fresh install with no account yet, prints the ready block (the link and the setup code). With the local
 * account on, that link creates the first account. With no sign-in method at all (for example Render without
 * AuthKit), the same link opens the sign-in choice. When accounts exist but no sign-in method is on, it prints how
 * to turn one back on instead, and does not print a code.
 */
export async function announceFirstRunSetup(
    port: number | string,
    countUsers: () => Promise<number>,
    log: (line: string) => void,
    localAdmin: boolean,
    env: NodeJS.ProcessEnv = process.env
): Promise<FirstRunAnnounce> {
    if (!localAdmin && !noSignInMethod(env)) return 'none'
    if ((await countUsers()) > 0) {
        if (localAdmin) return 'none'
        // Accounts exist but nothing lets them in, for example a .env that lost CUTTLELY_LOCAL_ADMIN. Say how to get back.
        log(
            '🔑 [server]: No sign-in method is on, so nobody can sign in. Turn on the password sign-in (CUTTLELY_LOCAL_ADMIN=true) or AuthKit on the host, then restart.'
        )
        return 'recover'
    }
    for (const line of setupReadyBlock(port, env)) log(line)
    return 'setup'
}

/**
 * Prints the ready block again every few minutes while setup is still open, so later warnings do not hide it.
 * Stops once announce is no longer the setup block. Returns a function that stops the reminder.
 */
export function watchFirstRunSetup(
    port: number | string,
    countUsers: () => Promise<number>,
    log: (line: string) => void,
    localAdmin: boolean,
    env: NodeJS.ProcessEnv = process.env,
    everyMs: number = SETUP_READY_REPRINT_MS
): () => void {
    const timer = setInterval(() => {
        announceFirstRunSetup(port, countUsers, log, localAdmin, env)
            .then((kind) => {
                if (kind !== 'setup') clearInterval(timer)
            })
            .catch(() => {
                // A reminder that fails stays quiet. The next interval tries again.
            })
    }, everyMs)
    timer.unref?.()
    return () => clearInterval(timer)
}
