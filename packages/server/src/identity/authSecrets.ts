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
 * Boot loader for the auth env names declared on the CLI
 * (JWT_AUTH_TOKEN_SECRET, JWT_REFRESH_TOKEN_SECRET, JWT_ISSUER, JWT_AUDIENCE,
 * EXPRESS_SESSION_SECRET, TOKEN_HASH_SECRET). A set environment value wins. Otherwise
 * the value is read or created under SECRETKEY_PATH. Cuttlely does not require AWS
 * Secrets Manager for these values. Legacy sealed-session compatibility uses
 * WORKOS_COOKIE_PASSWORD separately; authentication state signing derives from
 * TOKEN_HASH_SECRET.
 */

import { postgresSettings, AUTH_SECRETS_DOCUMENT } from '../settings/postgres'
import { withSettingsLockSync } from '../settings/lock'
import { settingsDir } from '../settings/store'
import { randomBytes } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

const SPECS: { envKey: string; fileName: string; createdValue?: string }[] = [
    { envKey: 'JWT_AUTH_TOKEN_SECRET', fileName: 'jwt-auth-token.secret' },
    { envKey: 'JWT_REFRESH_TOKEN_SECRET', fileName: 'jwt-refresh-token.secret' },
    { envKey: 'EXPRESS_SESSION_SECRET', fileName: 'express-session.secret' },
    { envKey: 'TOKEN_HASH_SECRET', fileName: 'token-hash.secret' },
    { envKey: 'JWT_ISSUER', fileName: 'jwt-issuer', createdValue: 'cuttlely' },
    { envKey: 'JWT_AUDIENCE', fileName: 'jwt-audience', createdValue: 'cuttlely' }
]

let loaded: Map<string, string> | null = null
const ensured = new Map<string, string>()

function directory(): string {
    return process.env.SECRETKEY_PATH ? process.env.SECRETKEY_PATH : path.join(os.homedir(), '.cuttlely')
}

export function readAuthenticationFile(file: string): string | null {
    let fd: number
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
    }
    try {
        if (!fs.fstatSync(fd).isFile()) throw new Error('Expected a regular authentication secret file.')
        const value = fs.readFileSync(fd, 'utf8')
        if (!value.trim()) throw new Error('An authentication secret file is empty.')
        return value
    } finally {
        fs.closeSync(fd)
    }
}

function persistentAuthSecrets(): Map<string, string> | undefined {
    const dir = settingsDir()
    const postgres = postgresSettings(dir)
    if (!postgres) return
    let document = postgres.read(AUTH_SECRETS_DOCUMENT)
    if (document === null) {
        document = withSettingsLockSync(dir, () => {
            const existing = postgres.read(AUTH_SECRETS_DOCUMENT)
            if (existing !== null) return existing
            const values = Object.fromEntries(
                SPECS.map(({ envKey, fileName, createdValue }) => [
                    envKey,
                    process.env[envKey]?.trim() ||
                        readAuthenticationFile(path.join(directory(), fileName)) ||
                        createdValue ||
                        randomBytes(32).toString('base64')
                ])
            )
            const text = JSON.stringify(values)
            postgres.write(AUTH_SECRETS_DOCUMENT, text)
            return text
        })
    }
    const values = JSON.parse(document)
    const result = new Map<string, string>()
    for (const { envKey } of SPECS) {
        if (typeof values?.[envKey] !== 'string' || !values[envKey].trim())
            throw new Error('The stored authentication secrets are incomplete.')
        result.set(envKey, process.env[envKey]?.trim() || values[envKey])
    }
    return result
}

/** Load the six auth values once. Later calls return the same map. */
export async function initAuthSecrets(): Promise<void> {
    if (loaded) return
    const durable = persistentAuthSecrets()
    if (durable) {
        loaded = durable
        return
    }
    const next = new Map<string, string>()
    for (const spec of SPECS) {
        next.set(spec.envKey, ensureInstanceSecret(spec.envKey))
    }
    loaded = next
}

export function authSecret(envKey: string): string {
    if (!loaded || !loaded.has(envKey)) {
        throw new Error('Auth secrets are not initialized')
    }
    return loaded.get(envKey) as string
}

/**
 * The instance secret for one auth env name.
 * A set environment value wins, then a secret already loaded at boot, then the file under SECRETKEY_PATH.
 * A missing file is created once, the same way initAuthSecrets creates the other auth secrets.
 */
export function ensureInstanceSecret(envKey: string): string {
    const fromEnv = process.env[envKey]
    if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim()
    if (loaded && loaded.has(envKey)) return loaded.get(envKey) as string
    const cached = ensured.get(envKey)
    if (cached) return cached
    const spec = SPECS.find((item) => item.envKey === envKey)
    if (!spec) throw new Error(`Unknown auth secret ${envKey}`)
    const durable = persistentAuthSecrets()
    if (durable) {
        loaded = durable
        return durable.get(envKey)!
    }
    const dir = directory()
    const filePath = path.join(dir, spec.fileName)
    const existing = readAuthenticationFile(filePath)
    if (existing) {
        ensured.set(envKey, existing)
        return existing
    }
    const value = spec.createdValue !== undefined ? spec.createdValue : randomBytes(32).toString('base64')
    fs.mkdirSync(dir, { recursive: true })
    try {
        fs.writeFileSync(filePath, value, { flag: 'wx', mode: 0o600 })
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const raced = readAuthenticationFile(filePath)
        if (!raced) throw new Error(`Auth secret ${envKey} could not be read`)
        ensured.set(envKey, raced)
        return raced
    }
    ensured.set(envKey, value)
    return value
}

/** Tests start from an empty map. Production boot calls initAuthSecrets once. */
export function resetAuthSecretsForTests(): void {
    loaded = null
    ensured.clear()
}
