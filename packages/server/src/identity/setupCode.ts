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
import fs from 'fs'
import os from 'os'
import path from 'path'
import { setTimeout as delay } from 'node:timers/promises'
import { authSecret, ensureInstanceSecret } from './authSecrets'
import type { AuthenticationMethod } from './authenticationState'
import { cookiePasswordOk, localAdminEnabled, workosConfigured } from './constants'
import { recordSetupFailure, resetSetupFailures, setupFailureLimited } from './setupLimit'

export const SETUP_CODE_TTL_MS = 60 * 60 * 1000
export const SETUP_CODE_MAX_LENGTH = 64
/** How often a running server checks for an expired code while setup is still open. */
export const SETUP_CODE_WATCH_MS = 60 * 1000

export interface SetupCodeRow {
    codeHmac: string
    issuedAt: number
    expiresAt: number
    consumedAt: number | null
    /** HMAC of the code replaced because it had already expired. Absent when there is none. */
    previousCodeHmac?: string | null
    /** Expiry of that previous code. A match on it is expired only once this time has passed. */
    previousExpiresAt?: number | null
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

const SETUP_INSTANCE_FILE = 'setup-instance.id'
const SETUP_ISSUER_FILE = 'setup-issuer.json'
/** A start that has not written a heartbeat this recently, and whose process is gone, is a previous start. */
const SETUP_HEARTBEAT_FRESH_MS = 3 * 60 * 1000

interface StartMark {
    pid: number
    startedAt: number
    heartbeatAt: number
    issuedAt?: number
    expiresAt?: number
}

let instanceId = ''
let startId = ''
let processStartedAt = 0
const startMarks = new Map<string, StartMark>()
let persistChain: Promise<void> = Promise.resolve()
let issuerEpoch = 0
let watchTimer: ReturnType<typeof setInterval> | undefined
let watchCountUsers: (() => Promise<number>) | undefined
let watchLocalAdmin = false
let watchEnv: NodeJS.ProcessEnv = process.env

function inTestRunner(): boolean {
    if (process.env.NODE_ENV === 'test') return true
    if (process.env.JEST_WORKER_ID) return true
    if (process.env.NODE_TEST_CONTEXT) return true
    return [...process.execArgv, ...process.argv].some(
        (arg) => arg === '--test' || arg.startsWith('--test-reporter') || arg.startsWith('--test-name-pattern')
    )
}

/** Secret directory in production. Tests persist only when SECRETKEY_PATH points at a throwaway directory. */
function issuerDirectory(): string | null {
    if (process.env.SECRETKEY_PATH) return process.env.SECRETKEY_PATH
    if (inTestRunner()) return null
    return path.join(os.homedir(), '.cuttlely')
}

/** Yields so a lock wait does not stall the rest of the process. */
function sleepMs(ms: number): Promise<void> {
    return delay(ms)
}

async function withIssuerLock(dir: string, body: () => void): Promise<void> {
    const lock = path.join(dir, 'setup-issuer.lock')
    const started = Date.now()
    let held = false
    while (!held && Date.now() - started < 2000) {
        try {
            fs.writeFileSync(lock, String(process.pid), { flag: 'wx' })
            held = true
        } catch {
            try {
                if (Date.now() - fs.statSync(lock).mtimeMs > 5000) {
                    fs.unlinkSync(lock)
                    continue
                }
            } catch {
                continue
            }
            await sleepMs(15)
        }
    }
    try {
        body()
    } finally {
        if (held) {
            try {
                fs.unlinkSync(lock)
            } catch {
                // The lock file is already gone.
            }
        }
    }
}

function markFrom(value: Partial<StartMark> | undefined): StartMark | null {
    if (!value || typeof value !== 'object') return null
    const issuedAt = value.issuedAt == null ? undefined : Number(value.issuedAt)
    const expiresAt = value.expiresAt == null ? undefined : Number(value.expiresAt)
    return {
        pid: Number(value.pid) || 0,
        startedAt: Number(value.startedAt) || 0,
        heartbeatAt: Number(value.heartbeatAt) || 0,
        issuedAt: Number.isFinite(issuedAt) ? issuedAt : undefined,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined
    }
}

function readMarkFile(): { instanceId: string; starts: Record<string, StartMark> } | null {
    const dir = issuerDirectory()
    if (!dir) return null
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, SETUP_ISSUER_FILE), 'utf8')) as {
            instanceId?: unknown
            starts?: Record<string, Partial<StartMark>>
        }
        if (typeof parsed.instanceId !== 'string' || !parsed.instanceId) return null
        const starts: Record<string, StartMark> = {}
        const raw = parsed.starts && typeof parsed.starts === 'object' ? parsed.starts : {}
        for (const [id, value] of Object.entries(raw)) {
            const mark = markFrom(value)
            if (mark) starts[id] = mark
        }
        return { instanceId: parsed.instanceId, starts }
    } catch {
        return null
    }
}

function refreshMarks(): void {
    const file = readMarkFile()
    if (!file || file.instanceId !== instanceId) return
    for (const [id, mark] of Object.entries(file.starts)) {
        const existing = startMarks.get(id)
        startMarks.set(id, existing ? mergeMark(existing, mark) : mark)
    }
}

/** Keeps the code times from either copy, and a finished start (pid 0) over a later heartbeat. */
function mergeMark(current: StartMark, incoming: StartMark): StartMark {
    if (current.pid === 0) {
        return {
            ...current,
            issuedAt: current.issuedAt ?? incoming.issuedAt,
            expiresAt: current.expiresAt ?? incoming.expiresAt
        }
    }
    const newer = incoming.heartbeatAt > current.heartbeatAt ? incoming : current
    const older = newer === incoming ? current : incoming
    return {
        ...newer,
        issuedAt: newer.issuedAt ?? older.issuedAt,
        expiresAt: newer.expiresAt ?? older.expiresAt
    }
}

function persistMarks(): Promise<void> {
    const dir = issuerDirectory()
    const epoch = issuerEpoch
    if (!dir || !instanceId) return Promise.resolve()
    const run = persistChain.then(async () => {
        if (epoch !== issuerEpoch || !instanceId) return
        const current = issuerDirectory()
        if (!current) return
        await withIssuerLock(current, () => {
            if (epoch !== issuerEpoch || !instanceId) return
            const merged = new Map(startMarks)
            const file = readMarkFile()
            if (file && file.instanceId === instanceId) {
                for (const [id, mark] of Object.entries(file.starts)) {
                    const existing = merged.get(id)
                    merged.set(id, existing ? mergeMark(existing, mark) : mark)
                }
            }
            startMarks.clear()
            for (const [id, mark] of merged) startMarks.set(id, mark)
            const starts: Record<string, StartMark> = {}
            for (const [id, mark] of startMarks) starts[id] = { ...mark }
            fs.mkdirSync(current, { recursive: true })
            fs.writeFileSync(path.join(current, SETUP_ISSUER_FILE), JSON.stringify({ instanceId, starts }))
        })
    })
    persistChain = run.then(
        () => undefined,
        () => undefined
    )
    return run
}

function loadOrCreateInstanceId(): string {
    const dir = issuerDirectory()
    if (!dir) return randomBytes(16).toString('hex')
    const file = path.join(dir, SETUP_INSTANCE_FILE)
    try {
        const existing = fs.readFileSync(file, 'utf8').trim()
        if (existing) return existing
    } catch {
        // The file is created below.
    }
    const id = randomBytes(16).toString('hex')
    fs.mkdirSync(dir, { recursive: true })
    try {
        fs.writeFileSync(file, id, { flag: 'wx' })
        return id
    } catch {
        try {
            const existing = fs.readFileSync(file, 'utf8').trim()
            if (existing) return existing
        } catch {
            // Use the id this process generated.
        }
        return id
    }
}

async function ensureProcess(): Promise<void> {
    if (startId) return
    instanceId = loadOrCreateInstanceId()
    startId = randomBytes(16).toString('hex')
    processStartedAt = Date.now()
    startMarks.set(startId, {
        pid: process.pid,
        startedAt: processStartedAt,
        heartbeatAt: processStartedAt
    })
    refreshMarks()
    const current = startMarks.get(startId)
    if (!current) {
        startMarks.set(startId, {
            pid: process.pid,
            startedAt: processStartedAt,
            heartbeatAt: processStartedAt
        })
    }
    await persistMarks()
}

async function rememberIssuer(row: SetupCodeRow, now: number): Promise<void> {
    await ensureProcess()
    const mark = startMarks.get(startId)
    if (!mark) return
    mark.issuedAt = row.issuedAt
    mark.expiresAt = row.expiresAt
    mark.heartbeatAt = Math.max(mark.heartbeatAt, now, Date.now())
    mark.pid = process.pid
    await persistMarks()
}

async function noteHeartbeat(now: number): Promise<void> {
    await ensureProcess()
    const mark = startMarks.get(startId)
    if (!mark) return
    mark.heartbeatAt = now
    mark.pid = process.pid
    await persistMarks()
}

function pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
}

function startAlive(mark: StartMark, now: number): boolean {
    if (now - mark.heartbeatAt > SETUP_HEARTBEAT_FRESH_MS) return false
    return pidAlive(mark.pid)
}

/** last-start: an earlier start of this install issued the live row and that start is gone. */
function classifyKept(row: SetupCodeRow, now: number): 'last-start' | 'other-copy' {
    refreshMarks()
    let otherAlive = false
    let priorDeadMatch = false
    for (const [id, mark] of startMarks) {
        if (id !== startId && startAlive(mark, now)) otherAlive = true
        const issuedThis = mark.issuedAt === row.issuedAt && mark.expiresAt === row.expiresAt
        if (issuedThis && id !== startId && !startAlive(mark, now)) priorDeadMatch = true
    }
    if (otherAlive) return 'other-copy'
    if (priorDeadMatch) return 'last-start'
    return 'other-copy'
}

function keptLine(localAdmin: boolean, row: SetupCodeRow | null, now: number): string {
    const lastStart = row != null && row.consumedAt == null && classifyKept(row, now) === 'last-start'
    const until = row ? new Date(row.expiresAt).toISOString() : ''
    if (lastStart) {
        if (localAdmin) return `👋 [server]: No account yet. The setup code from the last start is still valid until ${until}.`
        return `🔑 [server]: No sign-in method is on yet. The setup code from the last start is still valid until ${until}.`
    }
    if (localAdmin) return '👋 [server]: No account yet. The setup code was printed by another copy of this server.'
    return '🔑 [server]: No sign-in method is on yet. The setup code was printed by another copy of this server.'
}

function stopSetupCodeWatch(): void {
    if (watchTimer) clearInterval(watchTimer)
    watchTimer = undefined
}

function startSetupCodeWatch(countUsers: () => Promise<number>, localAdmin: boolean, env: NodeJS.ProcessEnv): void {
    watchCountUsers = countUsers
    watchLocalAdmin = localAdmin
    watchEnv = env
    if (watchTimer) return
    const timer = setInterval(() => {
        void runSetupCodeWatch(Date.now()).catch(() => undefined)
    }, SETUP_CODE_WATCH_MS)
    timer.unref()
    watchTimer = timer
}

async function setupStillOpen(): Promise<boolean> {
    if (localRetired || !watchCountUsers) return false
    if ((await watchCountUsers()) > 0) return false
    if (!watchLocalAdmin && !noSignInMethod(watchEnv)) return false
    return true
}

function resetIssuer(): void {
    issuerEpoch += 1
    const dir = issuerDirectory()
    instanceId = ''
    startId = ''
    processStartedAt = 0
    startMarks.clear()
    stopSetupCodeWatch()
    watchCountUsers = undefined
    watchLocalAdmin = false
    watchEnv = process.env
    if (!dir || !inTestRunner()) return
    for (const name of [SETUP_ISSUER_FILE, SETUP_INSTANCE_FILE]) {
        try {
            fs.unlinkSync(path.join(dir, name))
        } catch {
            // The marker file is already absent.
        }
    }
    try {
        fs.unlinkSync(path.join(dir, 'setup-issuer.lock'))
    } catch {
        // The lock file is already absent.
    }
}

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
    return `${publicOrigin(startupPort, startupEnv)}/setup#code=${plain}`
}

function printFreshLink(plain: string): void {
    printer(`👋 [server]: A new setup link is ready. Open ${printedSetupLink(plain)}`)
}

/**
 * Startup collects lines, then flushes them once. The same function stays the printer, so a later
 * reissue writes straight to the real log instead of a buffer that nobody reads again.
 */
export function createStartupPrinter(write: (line: string) => void): { log: (line: string) => void; flush: () => void } {
    const lines: string[] = []
    let flushed = false
    return {
        log(line: string) {
            if (flushed) write(line)
            else lines.push(line)
        },
        flush() {
            if (flushed) return
            flushed = true
            const pendingLines = lines.splice(0, lines.length)
            for (const line of pendingLines) write(line)
        }
    }
}

function issue(now: number, notify: boolean): string {
    const booting = ensureProcess()
    const ownHmac = issuedPlain ? digest(issuedPlain) : null
    const plain = randomBytes(12).toString('base64url')
    const expiresAt = now + SETUP_CODE_TTL_MS
    issuedPlain = plain
    issuedExpiresAt = expiresAt
    localRetired = false
    heldByOther = false
    const save = async () => {
        await booting
        // Read at write time so the HMAC kept is the row this conditional write replaces.
        const existing = await activeStore().read()
        const expiredOpen = existing != null && existing.consumedAt == null && existing.expiresAt <= now
        const row: SetupCodeRow = {
            codeHmac: digest(plain),
            issuedAt: now,
            expiresAt,
            consumedAt: null,
            previousCodeHmac: expiredOpen ? existing.codeHmac : existing?.previousCodeHmac ?? null,
            previousExpiresAt: expiredOpen ? existing.expiresAt : existing?.previousExpiresAt ?? null
        }
        const outcome = await activeStore().save(row, ownHmac)
        if (issuedPlain !== plain) return
        if (outcome === 'kept') {
            issuedPlain = undefined
            issuedExpiresAt = 0
            heldByOther = true
            return
        }
        await rememberIssuer(row, now)
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
 * A second copy's write is kept when a live code is already stored, so only one reissue lands.
 */
export function firstRunSetupCode(now = Date.now()): string {
    if (localRetired && issuedPlain) return issuedPlain
    if (localRetired) return 'setup-code-retired'
    if (issuedPlain && issuedExpiresAt > now) return issuedPlain
    return issue(now, Boolean(issuedPlain))
}

/**
 * When the stored code is unused and already expired, issue a new one and print it if this write wins.
 * A live code, including one a second copy just wrote, is left in place.
 */
export async function reissueExpiredSetupCode(now = Date.now()): Promise<void> {
    await pending
    if (localRetired) return
    const row = await activeStore().read()
    if (!row || row.consumedAt != null || row.expiresAt > now) return
    if (issuedPlain && issuedExpiresAt > now) return
    if (issuedPlain && issuedExpiresAt <= now) firstRunSetupCode(now)
    else issue(now, true)
    await pending
}

/**
 * Setup pages call this while the first account is still absent.
 * With the password sign-in on, that is enough. With it off, a sign-in method that is already on stops the check.
 */
export async function reissueExpiredSetupIfOpen(
    countUsers: () => Promise<number>,
    localAdmin: boolean,
    env: NodeJS.ProcessEnv = process.env,
    now = Date.now()
): Promise<void> {
    if (localRetired) return
    if ((await countUsers()) > 0) return
    if (!localAdmin && !noSignInMethod(env)) return
    await reissueExpiredSetupCode(now)
}

/** True while the one-minute check is scheduled. */
export function setupCodeWatchActive(): boolean {
    return watchTimer != null
}

/** True when that check will not keep the process alive on its own. */
export function setupCodeWatchUnrefd(): boolean {
    const timer = watchTimer as { hasRef?: () => boolean } | undefined
    return Boolean(timer && typeof timer.hasRef === 'function' && timer.hasRef() === false)
}

/** One pass of the one-minute check. Tests call this with a chosen clock. */
export async function runSetupCodeWatch(now = Date.now()): Promise<void> {
    if (!watchCountUsers) return
    await noteHeartbeat(now)
    if (!(await setupStillOpen())) {
        stopSetupCodeWatch()
        return
    }
    await reissueExpiredSetupCode(now)
}

/**
 * Test hook: this process continues as a new start, and the start that issued the current code is gone.
 * The stored row stays.
 */
export async function simulateSetupRestart(): Promise<void> {
    await ensureProcess()
    const previous = startMarks.get(startId)
    if (previous) {
        previous.pid = 0
        previous.heartbeatAt = 0
    }
    startId = randomBytes(16).toString('hex')
    processStartedAt = Date.now()
    startMarks.set(startId, {
        pid: process.pid,
        startedAt: processStartedAt,
        heartbeatAt: processStartedAt
    })
    issuedPlain = undefined
    issuedExpiresAt = 0
    heldByOther = false
    localRetired = false
    await persistMarks()
}

/**
 * Test hook: this process continues as a new start, and the start that issued the current code is still running.
 * The stored row stays.
 */
export async function simulateOtherSetupCopy(): Promise<void> {
    await ensureProcess()
    const previous = startMarks.get(startId)
    if (previous) {
        previous.pid = process.pid
        previous.heartbeatAt = Date.now()
    }
    startId = randomBytes(16).toString('hex')
    processStartedAt = Date.now()
    startMarks.set(startId, {
        pid: process.pid,
        startedAt: processStartedAt,
        heartbeatAt: processStartedAt
    })
    issuedPlain = undefined
    issuedExpiresAt = 0
    heldByOther = false
    localRetired = false
    await persistMarks()
}

/** Prints a fresh link. Used when the server-wide failure cap is reached, and by tests. */
export function reissueFirstRunSetupCode(now = Date.now()): string {
    return issue(now, true)
}

/** Shown when the submitted code matches a row that is already past its time. The new code stays in the log. */
export const SETUP_CODE_EXPIRED_MESSAGE = 'This setup code has expired. A new code was printed in the server log.'

export type SetupCodeVerdict = 'match' | 'expired' | 'rejected'

function hmacHex(value: string | null | undefined): string | null {
    return value && /^[0-9a-f]{64}$/i.test(value) ? value : null
}

/**
 * Constant-time compare against the live HMAC and the previous HMAC.
 * A non-string, an empty string, and anything longer than 64 characters are rejected before the compare.
 * Both compares run for every accepted candidate. A missing HMAC is compared to a stand-in digest and does not count.
 * A live match is rejected when that row was used, and expired when it is past its time.
 * A previous match is expired only when that previous code is past its expiry. It is never a match.
 * The code itself is not returned.
 */
export async function setupCodeVerdict(candidate: unknown, now = Date.now()): Promise<SetupCodeVerdict> {
    if (!acceptable(candidate)) return 'rejected'
    const given = Buffer.from(digest(candidate))
    await pending
    const row = await activeStore().read()
    const liveHex = hmacHex(row?.codeHmac) ?? digest('setup-code-absent')
    const previousHex = hmacHex(row?.previousCodeHmac) ?? digest('setup-code-previous-absent')
    const live = Buffer.from(liveHex)
    const previous = Buffer.from(previousHex)
    const liveEqual = given.length === live.length && timingSafeEqual(given, live)
    const previousEqual = given.length === previous.length && timingSafeEqual(given, previous)
    if (liveEqual && row && hmacHex(row.codeHmac)) {
        if (row.consumedAt != null) return 'rejected'
        if (row.expiresAt <= now) return 'expired'
        return 'match'
    }
    const previousExpires = row?.previousExpiresAt
    if (
        previousEqual &&
        row &&
        hmacHex(row.previousCodeHmac) &&
        previousExpires != null &&
        Number.isFinite(previousExpires) &&
        previousExpires <= now
    ) {
        return 'expired'
    }
    return 'rejected'
}

/** True only when the candidate matches a live row. */
export async function setupCodeMatches(candidate: unknown, now = Date.now()): Promise<boolean> {
    return (await setupCodeVerdict(candidate, now)) === 'match'
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
export async function retireFirstRunSetupCode(now = Date.now()): Promise<void> {
    localRetired = true
    stopSetupCodeWatch()
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
    stopSetupCodeWatch()
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
    startupPort = 3000
    startupEnv = process.env
    boundStore = undefined
    memoryStore.clear()
    resetSetupFailures()
    resetIssuer()
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
 * An expired code is counted the same as a code that is not the live one. Callers record every verdict that is not a match, so the address cap is unchanged.
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

/** True when nobody could sign in: OIDC is not active, password sign-in is off, and AuthKit is not set up. */
export function noSignInMethod(env: NodeJS.ProcessEnv = process.env, activeMethod?: AuthenticationMethod | null): boolean {
    const durableMethod =
        activeMethod === undefined
            ? (require('./authenticationState') as typeof import('./authenticationState')).selectedAuthenticationMethod()
            : activeMethod
    return durableMethod !== 'oidc' && !localAdminEnabled(env) && !(workosConfigured(env) && cookiePasswordOk(env.WORKOS_COOKIE_PASSWORD))
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

/** The ready block for a live code this process can still print. It does not issue a code. */
export function setupReadyLines(port: number | string, env: NodeJS.ProcessEnv, code: string): string[] {
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

async function claimLiveCode(now = Date.now()): Promise<void> {
    if (localRetired) {
        await pending
        return
    }
    if (!(issuedPlain && issuedExpiresAt > now)) issue(now, false)
    await pending
}

/**
 * On a fresh install with no account yet, prints the ready block (the link and the setup code). With the local
 * account on, that link creates the first account. With no sign-in method at all (for example Render without
 * AuthKit), the same link opens the sign-in choice. The code is the live stored code: a restart or another copy
 * keeps it, and an expired one is replaced by the one-minute check. When accounts exist but no sign-in method is
 * on, it prints how to turn one back on instead, and does not print a code.
 */
export async function announceFirstRunSetup(
    port: number | string,
    countUsers: () => Promise<number>,
    log: (line: string) => void,
    localAdmin: boolean,
    env: NodeJS.ProcessEnv = process.env
): Promise<FirstRunAnnounce> {
    printer = log
    startupPort = port
    startupEnv = env
    if (!localAdmin && !noSignInMethod(env)) return 'none'
    if ((await countUsers()) > 0) {
        if (localAdmin) return 'none'
        // Accounts exist but nothing lets them in, for example a .env that lost CUTTLELY_LOCAL_ADMIN. Say how to get back.
        log(
            '🔑 [server]: No sign-in method is on, so nobody can sign in. Turn on the password sign-in (CUTTLELY_LOCAL_ADMIN=true) or AuthKit on the host, then restart.'
        )
        return 'recover'
    }
    await claimLiveCode()
    startSetupCodeWatch(countUsers, localAdmin, env)
    if (heldByOther || !issuedPlain) {
        log(keptLine(localAdmin, await activeStore().read(), Date.now()))
        return 'setup'
    }
    for (const line of setupReadyLines(port, env, issuedPlain)) log(line)
    return 'setup'
}

/**
 * Prints the ready block again every few minutes while setup is still open, using the live code this process
 * already holds. It does not issue a code. An expired code is not printed; the one-minute check replaces it.
 * The latest write is settled first, so a code that did not win that write is not printed. Returns a function
 * that stops the reminder.
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
        void (async () => {
            try {
                if (localRetired || (await countUsers()) > 0 || (!localAdmin && !noSignInMethod(env))) {
                    clearInterval(timer)
                    return
                }
                await setupCodeReady()
                const now = Date.now()
                if (!issuedPlain || issuedExpiresAt <= now) return
                for (const line of setupReadyLines(port, env, issuedPlain)) log(line)
            } catch {
                // A reminder that fails stays quiet. The next interval tries again.
            }
        })()
    }, everyMs)
    timer.unref?.()
    return () => clearInterval(timer)
}
