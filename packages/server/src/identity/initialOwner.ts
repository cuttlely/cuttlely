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

/**
 * First owner from host configuration (issue 479). On an empty database with local password sign-in on, the web
 * server creates the first owner from CUTTLELY_INITIAL_OWNER_* before it listens, so no setup code is printed.
 *
 * - Create-only. Once any user exists the variables are ignored with a one-line warning; nothing is updated.
 * - Fails closed. On an empty database a malformed or refused configuration stops the start; it never falls back
 *   to the setup link.
 * - The value-bearing variables are captured once and removed from the process environment, so child processes
 *   never inherit them. No message here contains a value, its length, or its hash.
 */

import fs from 'fs'
import path from 'path'
import type { DataSource } from 'typeorm'
import { isEmailAddress } from '../settings/validate'
import { readAuthenticationState } from './authenticationState'
import { localAdminEnabled, workosEnvironmentConfigured } from './constants'
import { hashPassword, passwordErrors } from './password'
import { SqlIdentityStore } from './sqlStore'
import { NotEmptyError } from './types'

export const INITIAL_OWNER_EMAIL = 'CUTTLELY_INITIAL_OWNER_EMAIL'
export const INITIAL_OWNER_NAME = 'CUTTLELY_INITIAL_OWNER_NAME'

type PasswordSource = 'hash_file' | 'password_file' | 'hash_env' | 'password_env'

/** Most preferred first. Exactly one may be set; two set is an error, not a precedence rule. */
const PASSWORD_SOURCES: { key: string; source: PasswordSource; hashed: boolean; file: boolean }[] = [
    { key: 'CUTTLELY_INITIAL_OWNER_PASSWORD_HASH_FILE', source: 'hash_file', hashed: true, file: true },
    { key: 'CUTTLELY_INITIAL_OWNER_PASSWORD_FILE', source: 'password_file', hashed: false, file: true },
    { key: 'CUTTLELY_INITIAL_OWNER_PASSWORD_HASH', source: 'hash_env', hashed: true, file: false },
    { key: 'CUTTLELY_INITIAL_OWNER_PASSWORD', source: 'password_env', hashed: false, file: false }
]

export const INITIAL_OWNER_PASSWORD_KEYS = PASSWORD_SOURCES.map((entry) => entry.key)
export const INITIAL_OWNER_KEYS = [INITIAL_OWNER_EMAIL, INITIAL_OWNER_NAME, ...INITIAL_OWNER_PASSWORD_KEYS]
/** Variables that carry a password or hash themselves. They are removed from the environment once read. */
export const INITIAL_OWNER_VALUE_KEYS = PASSWORD_SOURCES.filter((entry) => !entry.file).map((entry) => entry.key)

/** A secret file is a password or one hash line. Anything bigger is not one. */
const SECRET_FILE_MAX_BYTES = 4096
/** Exactly what hashPassword writes: a 16-byte salt and a 32-byte key, both standard base64 with padding. */
const SCRYPT_HASH = /^scrypt\$([A-Za-z0-9+/]{22}==)\$([A-Za-z0-9+/]{43}=)$/

type Values = Record<string, string | undefined>

export type InitialOwnerConfig =
    | { state: 'off' }
    | { state: 'invalid'; reasons: string[] }
    | { state: 'ready'; email: string; name: string; credential: string; source: PasswordSource }

export interface InitialOwnerLog {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
}

export type InitialOwnerOutcome = 'off' | 'created' | 'exists' | 'ignored' | 'refused'

const PREFIX = '🔑 [server]: First owner from host configuration:'

let captured: Values | null = null

/**
 * Copies the CUTTLELY_INITIAL_OWNER_* values once and removes the value-bearing ones from `env`.
 * Called from every command's init, before anything can start a child process. Later calls only remove again.
 */
export function captureInitialOwnerEnvironment(env: Values = process.env): void {
    if (!captured) captured = Object.fromEntries(INITIAL_OWNER_KEYS.map((key) => [key, env[key]]))
    for (const key of INITIAL_OWNER_VALUE_KEYS) delete env[key]
}

/** Test helper: forget the captured values. */
export function resetInitialOwnerForTests(): void {
    captured = null
}

function blank(value: string | undefined): boolean {
    return typeof value !== 'string' || value.trim() === ''
}

/** True when any CUTTLELY_INITIAL_OWNER_* value was set for this process. */
export function initialOwnerConfigured(values: Values): boolean {
    return INITIAL_OWNER_KEYS.some((key) => !blank(values[key]))
}

/** Exactly hashPassword's scrypt form. bcrypt and hand-built strings are refused. */
export function isInitialOwnerHash(value: string): boolean {
    const match = SCRYPT_HASH.exec(value)
    if (!match) return false
    const salt = Buffer.from(match[1], 'base64')
    const key = Buffer.from(match[2], 'base64')
    return salt.length === 16 && key.length === 32 && salt.toString('base64') === match[1] && key.toString('base64') === match[2]
}

/** Reads one secret file. Only one trailing line break is removed, so spaces in a password stay. */
function readSecretFile(key: string, filePath: string): { value: string } | { reason: string } {
    if (!path.isAbsolute(filePath) || filePath.includes('\0')) return { reason: `${key} must be an absolute file path.` }
    let stat: fs.Stats
    try {
        // statSync follows links, so a Kubernetes secret volume (a link into ..data) works.
        stat = fs.statSync(filePath)
    } catch {
        return { reason: `${key} names a file that cannot be read.` }
    }
    if (!stat.isFile()) return { reason: `${key} must name a regular file.` }
    if (stat.size > SECRET_FILE_MAX_BYTES) return { reason: `${key} names a file larger than ${SECRET_FILE_MAX_BYTES} bytes.` }
    let text: string
    try {
        text = fs.readFileSync(filePath, 'utf8')
    } catch {
        return { reason: `${key} names a file that cannot be read.` }
    }
    const value = text.replace(/\r?\n$/, '')
    if (value === '') return { reason: `${key} names an empty file.` }
    return { value }
}

/** `pnpm hash-password`: the same password rules as setup, then the exact stored form. */
export async function hashPasswordForHost(password: string): Promise<{ ok: true; hash: string } | { ok: false; errors: string[] }> {
    const errors = passwordErrors(password)
    if (errors.length) return { ok: false, errors }
    return { ok: true, hash: await hashPassword(password) }
}

/** `pnpm hash-password --output`: a new file readable only by its owner, holding the hash and one line break. */
export function writeHashFile(target: string, hash: string, base: string): { ok: true; path: string } | { ok: false; error: string } {
    const file = path.resolve(base, target)
    try {
        // 'wx' never replaces an existing file, so a typo cannot overwrite another secret.
        fs.writeFileSync(file, `${hash}\n`, { mode: 0o600, flag: 'wx' })
        return { ok: true, path: file }
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EEXIST') return { ok: false, error: `${file} already exists. Choose a new file name.` }
        return { ok: false, error: `${file} could not be written (${code || 'error'}).` }
    }
}

/** Validates the captured values. Plain passwords are hashed here and not kept. */
export async function readInitialOwnerConfig(values: Values): Promise<InitialOwnerConfig> {
    if (!initialOwnerConfigured(values)) return { state: 'off' }
    const reasons: string[] = []
    const email = (values[INITIAL_OWNER_EMAIL] ?? '').trim()
    if (!email) reasons.push(`${INITIAL_OWNER_EMAIL} is not set, but other CUTTLELY_INITIAL_OWNER_* variables are.`)
    else if (!isEmailAddress(email) || email.length > 255) reasons.push(`${INITIAL_OWNER_EMAIL} is not a valid email address.`)

    const rawName = values[INITIAL_OWNER_NAME]
    let name = email.split('@')[0]?.trim().slice(0, 100) || 'Super User'
    if (!blank(rawName)) {
        const trimmed = (rawName as string).trim()
        if (trimmed.length > 100) reasons.push(`${INITIAL_OWNER_NAME} must be at most 100 characters.`)
        else name = trimmed
    }

    const set = PASSWORD_SOURCES.filter((entry) => !blank(values[entry.key]))
    if (set.length === 0) {
        reasons.push(`Set one of ${INITIAL_OWNER_PASSWORD_KEYS.join(', ')}.`)
        return { state: 'invalid', reasons }
    }
    if (set.length > 1) {
        reasons.push(`Set only one password source. Found: ${set.map((entry) => entry.key).join(', ')}.`)
        return { state: 'invalid', reasons }
    }

    const chosen = set[0]
    let secret: string
    if (chosen.file) {
        const read = readSecretFile(chosen.key, (values[chosen.key] as string).trim())
        if ('reason' in read) {
            reasons.push(read.reason)
            return { state: 'invalid', reasons }
        }
        secret = read.value
    } else {
        // A hash is one token, so surrounding space is dropped. A plain password is used exactly as given.
        secret = chosen.hashed ? (values[chosen.key] as string).trim() : (values[chosen.key] as string)
    }

    let credential: string | null = null
    if (chosen.hashed) {
        if (isInitialOwnerHash(secret)) credential = secret
        else reasons.push(`${chosen.key} is not a password hash from pnpm hash-password (scrypt only).`)
    } else {
        // The same rules as browser setup and pnpm user. The messages name the rule, never the value.
        const errors = passwordErrors(secret)
        if (errors.length) reasons.push(...errors.map((error) => `${chosen.key}: ${error}.`))
    }
    if (reasons.length) return { state: 'invalid', reasons }
    if (!credential) credential = await hashPassword(secret)
    return { state: 'ready', email, name, credential, source: chosen.source }
}

/**
 * Runs after migrations and durable sign-in state, before the server listens. The caller exits the start on
 * 'refused'. Any existing user makes this a no-op; losing the create to another copy of the server is success.
 */
export async function applyInitialOwnerOnBoot(
    dataSource: DataSource,
    log: InitialOwnerLog,
    env: Values = process.env
): Promise<InitialOwnerOutcome> {
    captureInitialOwnerEnvironment(env)
    const values = captured as Values
    if (!initialOwnerConfigured(values)) return 'off'
    const store = new SqlIdentityStore(dataSource)
    if ((await store.countUsers()) > 0) {
        log.warn(
            `${PREFIX} accounts already exist, so the CUTTLELY_INITIAL_OWNER_* variables were not used. Remove them and any secret file they name: on an empty database they would create an owner again.`
        )
        return 'ignored'
    }
    const refuse = (reasons: string[]): InitialOwnerOutcome => {
        for (const reason of reasons) log.error(`${PREFIX} ${reason}`)
        log.error(
            `${PREFIX} the first owner was not created and the setup link is not offered. Fix the configuration, or remove the CUTTLELY_INITIAL_OWNER_* variables to use the setup link, then start again.`
        )
        return 'refused'
    }
    if (!localAdminEnabled(env)) return refuse(['local password sign-in is off. Set CUTTLELY_LOCAL_ADMIN=true.'])
    if (workosEnvironmentConfigured(env))
        return refuse(['AuthKit is configured. Use CUTTLELY_BOOTSTRAP_EMAIL for an AuthKit first owner instead.'])
    const state = await readAuthenticationState(dataSource)
    if (state?.activeMethod === 'workos' || state?.activeMethod === 'oidc')
        return refuse(['the selected sign-in method is not Local password sign-in.'])
    const config = await readInitialOwnerConfig(values)
    if (config.state === 'invalid') return refuse(config.reasons)
    if (config.state === 'off') return 'off'
    try {
        // An open setup code is retired in this same transaction, and the owner_created audit row records the source.
        await store.createOwner(
            { email: config.email, name: config.name, credential: config.credential, externalId: null },
            { activateLocalAuthentication: true, auditSource: 'host_config' }
        )
    } catch (error) {
        if (error instanceof NotEmptyError) {
            log.info(`${PREFIX} another copy of the server created the first owner first. Nothing changed here.`)
            return 'exists'
        }
        throw error
    }
    log.info(
        `${PREFIX} the first owner was created. Sign in with that email and password. Remove the CUTTLELY_INITIAL_OWNER_* variables and any secret file they name.`
    )
    return 'created'
}
