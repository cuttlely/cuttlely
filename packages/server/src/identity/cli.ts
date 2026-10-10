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

import { hashPassword, passwordErrors } from './password'
import { IdentityStore } from './store'

export interface UserCliInput {
    email?: string
    password?: string
    localAdmin: boolean
}

export interface UserCliResult {
    ok: boolean
    lines: string[]
}

export async function runUserCli(store: IdentityStore, input: UserCliInput): Promise<UserCliResult> {
    const email = input.email?.trim()
    const password = input.password
    if (!email && !password) {
        const emails = await store.listEmails()
        return { ok: true, lines: [`Email addresses: ${emails.join(', ')}`, `Email count: ${emails.length}`] }
    }
    if (!email || !password) {
        return { ok: false, lines: ['Email and password are both required.'] }
    }
    const errors = passwordErrors(password)
    if (errors.length) return { ok: false, lines: errors }

    const hash = await hashPassword(password)
    const existing = await store.findUsersByEmail(email)
    if (existing.length > 1) return { ok: false, lines: ['This email matches more than one account.'] }
    if (existing.length === 1) {
        const row = existing[0]
        if (!input.localAdmin) {
            const owner = await store.findSuperUser()
            if (!owner || owner.id !== row.id) {
                return { ok: false, lines: [`Refusing to set a password for ${row.email}.`] }
            }
        }
        await store.setCredential(row.id, hash)
        return { ok: true, lines: [`Password updated for ${row.email}.`] }
    }

    if (!input.localAdmin) return { ok: false, lines: ['Refusing to create a user while the local admin flag is off.'] }
    if ((await store.countUsers()) !== 0) return { ok: false, lines: [`No account exists for ${email}.`] }
    const name = email.split('@')[0]?.trim().slice(0, 100) || 'Super User'
    const created = await store.createOwner({ email, name, credential: hash, externalId: null })
    return { ok: true, lines: [`Super User created for ${created.email}.`] }
}
