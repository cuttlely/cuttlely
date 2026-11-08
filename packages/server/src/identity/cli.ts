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

import type { DataSource } from 'typeorm'
import { initializeAuthenticationState } from './authenticationState'
import { hashPassword, passwordErrors } from './password'
import { SqlIdentityStore } from './sqlStore'
import { IdentityStore } from './store'
import { operatorDatabaseFingerprint } from './instanceOperator'
import { operatorRecoveryUserError, writeOperatorBinding } from './operatorBinding'

export interface UserCliInput {
    email?: string
    password?: string
    localAdmin: boolean
    bindOperator?: boolean
}

export interface UserCliResult {
    ok: boolean
    lines: string[]
    /** Internal host-command result; never returned by browser routes. */
    operatorUserId?: string
}

export async function runUserCommand(
    dataSource: DataSource,
    input: UserCliInput,
    env: Record<string, string | undefined> = process.env
): Promise<UserCliResult> {
    const ownershipError = operatorRecoveryUserError(env)
    if (ownershipError) return { ok: false, lines: [ownershipError] }
    await initializeAuthenticationState(dataSource)
    const store = new SqlIdentityStore(dataSource)
    const result = await runUserCli(store, input)
    if (!result.ok || !result.operatorUserId) return result
    try {
        // Credentials must succeed first. Never publish authority for a failed credential operation.
        if (!(await store.isActiveOwner(result.operatorUserId))) throw new Error('owner no longer active')
        writeOperatorBinding({ userId: result.operatorUserId, database: operatorDatabaseFingerprint(dataSource.options) }, env)
        result.lines.push(
            'Host operator binding saved. This active owner is the default instance operator unless the host environment overrides it.'
        )
    } catch {
        return {
            ok: false,
            lines: [
                ...result.lines,
                'Host operator binding did not complete cleanly; verify the host binding file before relying on browser authority. The credential operation above has already completed (bind-only leaves the password unchanged).',
                'Check settings-directory ownership, permissions and free space, and the host history log. Then rerun pnpm user --email <owner-email> --bind-operator against the same installation and database.',
                'If repairing a corrupt or unsafe instance-operator.json, remove it on the host first. Set CUTTLELY_INSTANCE_OPERATOR=none to revoke all browser administration during recovery.'
            ]
        }
    }
    return result
}

export async function runUserCli(store: IdentityStore, input: UserCliInput): Promise<UserCliResult> {
    const email = input.email?.trim()
    const password = input.password
    if (input.bindOperator && (!email || password !== undefined))
        return { ok: false, lines: ['--bind-operator requires an explicit email and does not accept a password.'] }
    if (!email && !password) {
        const emails = await store.listEmails()
        return { ok: true, lines: [`Email addresses: ${emails.join(', ')}`, `Email count: ${emails.length}`] }
    }
    if (!email || (!password && !input.bindOperator)) {
        return { ok: false, lines: ['Email and password are both required.'] }
    }
    const errors = input.bindOperator ? [] : passwordErrors(password!)
    if (errors.length) return { ok: false, lines: errors }

    const hash = input.bindOperator ? null : await hashPassword(password!)
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
        const activeOwner = Boolean(await store.isActiveOwner?.(row.id))
        if (input.bindOperator && !activeOwner) return { ok: false, lines: ['Refusing to bind an account without active ownership.'] }
        if (hash) await store.setCredential(row.id, hash)
        return {
            ok: true,
            lines: [input.bindOperator ? 'Existing active owner selected; password unchanged.' : `Password updated for ${row.email}.`],
            ...(activeOwner ? { operatorUserId: row.id } : {})
        }
    }

    if (input.bindOperator) return { ok: false, lines: ['No existing account matches the explicit email. Nothing changed.'] }
    if (!input.localAdmin) return { ok: false, lines: ['Refusing to create a user while the local admin flag is off.'] }
    if ((await store.countUsers()) !== 0) return { ok: false, lines: [`No account exists for ${email}.`] }
    const name = email.split('@')[0]?.trim().slice(0, 100) || 'Super User'
    // An open first-run code is retired in this same createOwner transaction.
    const created = await store.createOwner({ email, name, credential: hash!, externalId: null }, { activateLocalAuthentication: true })
    return { ok: true, lines: [`Super User created for ${created.email}.`], operatorUserId: created.id }
}
