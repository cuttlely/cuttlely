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
 * The code is stored as an HMAC with issued, expiry, and consumed times.
 * This process keeps the plaintext only so it can print the link.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { authSecret, ensureInstanceSecret } from './authSecrets'
import { cookiePasswordOk, localAdminEnabled, workosConfigured } from './constants'
import { recordSetupFailure, resetSetupFailures, setupFailureLimited } from './setupLimit'

export const SETUP_CODE_TTL_MS = 60 * 60 * 1000
export const SETUP_CODE_MAX_LENGTH = 64

export interface SetupCodeRow {
    codeHmac: string
    issuedAt: number
    expiresAt: number
    consumedAt: number | null
}

/** inserted: no row before. replaced: this write won. kept: a live row from another copy stayed. */
export type SetupCodeWrite = 'inserted' | 'replaced' | 'kept'

export interface SetupCodeStore {
    read(): Promise<SetupCodeRow | null>
    save(row: SetupCodeRow, previousHmac?: string | null): Promise<SetupCodeWrite>
    consume(hmac: string, now: number): Promise<boolean>
}

class MemorySetupCodeStore implements SetupCodeStore {
    private row: SetupCodeRow | null = null

    async read(): Promise<SetupCodeRow | null> {
        return this.row ? { ...this.row } : null
    }

    async save(row: SetupCodeRow, previousHmac?: string | null): Promise<SetupCodeWrite> {
        const before = this.row
        if (!before) {
            this.row = { ...row }
            return 'inserted'
        }
        const previous = previousHmac ?? ''
        const keep = before.consumedAt == null && before.expiresAt > row.issuedAt && before.codeHmac !== previous
        if (keep) return 'kept'
        this.row = { ...row }
        return 'replaced'
    }

    async consume(hmac: string, now: number): Promise<boolean> {
        const row = this.row
        if (!row || row.consumedAt != null || row.expiresAt <= now) return false
        if (!sameHmac(row.codeHmac, hmac)) return false
        this.row = { ...row, consumedAt: now }
        return true
    }

    clear(): void {
        this.row = null
    }
}

const memoryStore = new MemorySetupCodeStore()
let boundStore: SetupCodeStore | undefined
let pending: Promise<void> = Promise.resolve()
let issuedPlain: string | undefined
let issuedExpiresAt = 0
let localRetired = false
let heldByOther = false
let printer: (line: string) => void = () => undefined
let startupPort: number | string = 3000
let startupEnv: NodeJS.ProcessEnv = process.env
let linkKind: 'organization' | 'server' = 'organization'

function activeStore(): SetupCodeStore {
    return boundStore ?? memoryStore
}

/** Production binds the database store after migrations. Tests keep the in-memory store. */
export function bindSetupCodeStore(store: SetupCodeStore): void {
    boundStore = store
}

/** TOKEN_HASH_SECRET, or the instance secret stored with the other auth secrets. */
function compareMaterial(): string {
    const fromEnv = process.env.TOKEN_HASH_SECRET
    if (fromEnv && fromEnv.trim()) return fromEnv.trim()
    try {
        return authSecret('TOKEN_HASH_SECRET')
    } catch {
        return ensureInstanceSecret('TOKEN_HASH_SECRET')
    }
}

function digest(value: string): string {
    return createHmac('sha256', compareMaterial()).update(value).digest('hex')
}

function sameHmac(left: string, right: string): boolean {
    const a = Buffer.from(left)
    const b = Buffer.from(right)
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

function acceptable(candidate: unknown): candidate is string {
    return typeof candidate === 'string' && candidate.length > 0 && candidate.length <= SETUP_CODE_MAX_LENGTH
}

/** HMAC for a candidate, or null when the candidate is not a short string. */
export function setupCodeHmac(candidate: unknown): string | null {
    if (!acceptable(candidate)) return null
    return digest(candidate)
}

function printedSetupLink(plain: string): string {
    if (linkKind === 'server') return `${publicOrigin(startupPort, startupEnv)}/server-setup#code=${plain}`
    return `http://localhost:${startupPort}/organization-setup#code=${plain}`
}

function printFreshLink(plain: string): void {
    printer(`👋 [server]: A new setup link is ready. Open ${printedSetupLink(plain)}`)
}

function issue(now: number, notify: boolean): string {
    const previous = issuedPlain ? digest(issuedPlain) : null
    const plain = randomBytes(12).toString('base64url')
    const row: SetupCodeRow = {
        codeHmac: digest(plain),
        issuedAt: now,
        expiresAt: now + SETUP_CODE_TTL_MS,
        consumedAt: null
    }
    issuedPlain = plain
    issuedExpiresAt = row.expiresAt
    localRetired = false
    heldByOther = false
    const save = async () => {
        const outcome = await activeStore().save(row, previous)
        if (issuedPlain !== plain) return
        if (outcome === 'kept') {
            issuedPlain = undefined
            issuedExpiresAt = 0
            heldByOther = true
            return
        }
        if (notify) printFreshLink(plain)
    }
    pending = pending.then(save, save)
    return plain
}

/** Resolves after the latest issued row has been written. */
export function setupCodeReady(): Promise<void> {
    return pending
}

/**
 * The code for this process. A live in-memory code is reused.
 * An expired one is replaced, and the new link is printed once the write wins.
 */
export function firstRunSetupCode(now = Date.now()): string {
    if (localRetired && issuedPlain) return issuedPlain
    if (localRetired) return 'setup-code-retired'
    if (issuedPlain && issuedExpiresAt > now) return issuedPlain
    return issue(now, Boolean(issuedPlain))
}

/** Prints a fresh link. Used when the server-wide failure cap is reached, and by tests. */
export function reissueFirstRunSetupCode(now = Date.now()): string {
    return issue(now, true)
}

/**
 * Constant-time compare against the stored HMAC.
 * A non-string, an empty string, and anything longer than 64 characters are rejected before the compare.
 * Expiry and the consumed time are checked after the compare.
 */
export async function setupCodeMatches(candidate: unknown, now = Date.now()): Promise<boolean> {
    if (!acceptable(candidate)) return false
    const given = Buffer.from(digest(candidate))
    await pending
    const row = await activeStore().read()
    const expectedHex = row && /^[0-9a-f]{64}$/i.test(row.codeHmac) ? row.codeHmac : digest('setup-code-absent')
    const expected = Buffer.from(expectedHex)
    const equal = given.length === expected.length && timingSafeEqual(given, expected)
    if (!equal || !row) return false
    if (row.consumedAt != null) return false
    if (row.expiresAt <= now) return false
    return true
}

/** Marks the current row used. Returns false when it is missing, expired, already used, or a different HMAC. */
export async function consumeSetupCode(hmac: string, now: number): Promise<boolean> {
    await pending
    return activeStore().consume(hmac, now)
}

/** HMAC of the code this process can still print, or null after a restart cleared that copy. */
export function issuedSetupHmac(): string | null {
    if (!issuedPlain) return null
    return digest(issuedPlain)
}

/**
 * True when hmac is the stored setup row and that row is still unused and unexpired.
 * A restart or another copy can check this without the plaintext this process printed.
 */
export async function storedSetupCodeLive(hmac: string, now = Date.now()): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/i.test(hmac)) return false
    await pending
    const row = await activeStore().read()
    if (!row || row.consumedAt != null || row.expiresAt <= now) return false
    return sameHmac(row.codeHmac, hmac)
}

export function firstRunSetupLink(port: number | string): string {
    return `http://localhost:${port}/organization-setup#code=${firstRunSetupCode()}`
}

/** The setup link has been used. Its code stops working at once. */
export async function retireFirstRunSetupCode(now = Date.now()): Promise<void> {
    localRetired = true
    await pending
    const row = await activeStore().read()
    if (row && row.consumedAt == null) {
        const save = async () => {
            await activeStore().save({ ...row, consumedAt: now }, row.codeHmac)
        }
        pending = pending.then(save, save)
        await pending
        return
    }
    if (!row) {
        const save = async () => {
            await activeStore().save(
                {
                    codeHmac: digest('setup-code-retired'),
                    issuedAt: now,
                    expiresAt: now,
                    consumedAt: now
                },
                null
            )
        }
        pending = pending.then(save, save)
        await pending
    }
}

/**
 * Retires an unconsumed setup row. Operator commands call this from createOwner
 * when they do not carry a setup HMAC. A live row from another copy is left in place
 * when this process cannot name it.
 */
export async function retireOpenSetupCode(now = Date.now()): Promise<void> {
    await pending
    const row = await activeStore().read()
    if (!row || row.consumedAt != null) return
    let outcome: SetupCodeWrite = 'kept'
    const save = async () => {
        outcome = await activeStore().save({ ...row, consumedAt: now }, row.codeHmac)
    }
    pending = pending.then(save, save)
    await pending
    if (outcome === 'kept') return
    localRetired = true
    issuedPlain = undefined
    issuedExpiresAt = 0
}

export async function setupCodeRetired(): Promise<boolean> {
    if (localRetired) return true
    await pending
    const row = await activeStore().read()
    return row?.consumedAt != null
}

/** Sync view of the in-process flag. The stored row is what other processes see. */
export function firstRunSetupCodeRetired(): boolean {
    return localRetired
}

/**
 * Test hook: forget the in-process code and the in-memory row.
 * A store bound for a test is dropped so the next test starts clean.
 */
export function resetFirstRunSetupCode(): void {
    issuedPlain = undefined
    issuedExpiresAt = 0
    localRetired = false
    heldByOther = false
    pending = Promise.resolve()
    printer = () => undefined
    linkKind = 'organization'
    startupPort = 3000
    startupEnv = process.env
    boundStore = undefined
    memoryStore.clear()
    resetSetupFailures()
}

/** Clears only this process's copy of the code. The stored row stays, as it would for another process. */
export function forgetIssuedSetupCode(): void {
    issuedPlain = undefined
    issuedExpiresAt = 0
    localRetired = false
    heldByOther = false
}

/**
 * Records a failed register or code exchange.
 * Already at the cap: limited, and this attempt is not recorded.
 * Otherwise the attempt is recorded, and the server-wide cap prints a new link at most once per window.
 * Check and record stay synchronous so concurrent failures cannot all pass the cap.
 */
export function noteSetupFailure(address: string, now: number): { limited: boolean } {
    if (setupFailureLimited(address, now)) return { limited: true }
    const outcome = recordSetupFailure(address, now)
    if (outcome.reissue) reissueFirstRunSetupCode(now)
    return { limited: false }
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
    return `${publicOrigin(port, env)}/server-setup#code=${firstRunSetupCode()}`
}

async function claimLiveCode(now = Date.now()): Promise<void> {
    if (localRetired) {
        await pending
        return
    }
    if (!(issuedPlain && issuedExpiresAt > now)) issue(now, false)
    await pending
}

/**
 * On a fresh install with no account yet, prints where to start. With the local account on, the link creates the
 * first account. With no sign-in method at all (for example Render without AuthKit), the link opens only
 * Sign-in & identity, works once, and stops working when the first account exists. Either link carries the
 * one-time code in the fragment, so it also works through Docker's published port. When accounts exist but no
 * sign-in method is on, it prints how to turn one back on instead.
 */
export async function announceFirstRunSetup(
    port: number | string,
    countUsers: () => Promise<number>,
    log: (line: string) => void,
    localAdmin: boolean,
    env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
    printer = log
    startupPort = port
    startupEnv = env
    linkKind = localAdmin ? 'organization' : 'server'
    if (!localAdmin && !noSignInMethod(env)) return false
    if ((await countUsers()) > 0) {
        if (localAdmin) return false
        // Accounts exist but nothing lets them in, for example a .env that lost CUTTLELY_LOCAL_ADMIN. Say how to get back.
        log(
            '🔑 [server]: No sign-in method is on, so nobody can sign in. Turn on the password sign-in (CUTTLELY_LOCAL_ADMIN=true) or AuthKit on the host, then restart.'
        )
        return true
    }
    await claimLiveCode()
    if (heldByOther || !issuedPlain) {
        if (localAdmin) log('👋 [server]: No account yet. The setup code was printed by another copy of this server.')
        else log('🔑 [server]: No sign-in method is on yet. The setup code was printed by another copy of this server.')
        return true
    }
    if (localAdmin) {
        log(`👋 [server]: No account yet. Open ${firstRunSetupLink(port)} to create yours.`)
        return true
    }
    log(`🔑 [server]: No sign-in method is on yet. Open ${serverSetupLink(port, env)} to set one up. The link works once.`)
    return true
}
