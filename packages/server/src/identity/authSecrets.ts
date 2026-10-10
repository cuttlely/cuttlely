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
 * Secrets Manager for these values. AuthKit uses WORKOS_COOKIE_PASSWORD and does not
 * read them.
 */

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

function directory(): string {
    return process.env.SECRETKEY_PATH ? process.env.SECRETKEY_PATH : path.join(os.homedir(), '.cuttlely')
}

async function loadOne(envKey: string, fileName: string, createdValue?: string): Promise<string> {
    const envVal = process.env[envKey]
    if (envVal && envVal.trim() !== '') return envVal.trim()
    const dir = directory()
    const filePath = path.join(dir, fileName)
    try {
        return await fs.promises.readFile(filePath, 'utf8')
    } catch {
        const value = createdValue !== undefined ? createdValue : randomBytes(32).toString('base64')
        await fs.promises.mkdir(dir, { recursive: true })
        await fs.promises.writeFile(filePath, value)
        return value
    }
}

/** Load the six auth values once. Later calls return the same map. */
export async function initAuthSecrets(): Promise<void> {
    if (loaded) return
    const next = new Map<string, string>()
    for (const spec of SPECS) {
        next.set(spec.envKey, await loadOne(spec.envKey, spec.fileName, spec.createdValue))
    }
    loaded = next
}

export function authSecret(envKey: string): string {
    if (!loaded || !loaded.has(envKey)) {
        throw new Error('Auth secrets are not initialized')
    }
    return loaded.get(envKey) as string
}

/** Tests start from an empty map. Production boot calls initAuthSecrets once. */
export function resetAuthSecretsForTests(): void {
    loaded = null
}
