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
 * An invited email-only user is linked and marked active.
 */

import { IdentityStore } from './store'
import { LinkFailure, LinkResult, NotEmptyError, UserRow, WorkosIdentity } from './types'

export function isActiveStatus(status: string | null | undefined): boolean {
    return (status || '').toLowerCase() === 'active'
}

/** AuthKit may open an active row or an invited row that has no local password. */
export function isAuthKitEligible(status: string | null | undefined): boolean {
    const value = (status || '').toLowerCase()
    return value === 'active' || value === 'invited'
}

async function acceptLinkedUser(store: IdentityStore, row: UserRow, externalId: string): Promise<LinkResult> {
    if (!isAuthKitEligible(row.status)) return { ok: false, reason: 'inactive' }
    let current = row
    if ((row.status || '').toLowerCase() === 'invited') {
        const activated = await store.activateUser(row.id)
        if (!activated || !isActiveStatus(activated.status)) return { ok: false, reason: 'inactive' }
        current = activated
    }
    if (current.externalId && current.externalId !== externalId) return { ok: false, reason: 'rebind' }
    if (!current.externalId) {
        const linked = await store.setExternalId(current.id, externalId)
        if (linked === 'rebind') return { ok: false, reason: 'rebind' }
        if (linked !== 'linked') return { ok: false, reason: 'unknown' }
    }
    return { ok: true, user: { ...current, externalId, status: 'active' }, bootstrapped: false }
}

export function displayName(identity: WorkosIdentity): string {
    const named = (identity.name || '').trim()
    if (named) return named.slice(0, 100)
    const local = identity.email.split('@')[0]?.trim()
    return (local || 'Super User').slice(0, 100)
}

/**
 * Link a verified AuthKit user to a Cuttlely row, or bootstrap the first Super User.
 * Unknown emails do not create a row once any user exists.
 */
export async function linkWorkosUser(
    store: IdentityStore,
    identity: WorkosIdentity,
    options: { bootstrapEmail?: string } = {}
): Promise<LinkResult> {
    if (identity.emailVerified !== true) return { ok: false, reason: 'unverified' }

    const byExternal = await store.findUserByExternalId(identity.id)
    if (byExternal) return acceptLinkedUser(store, byExternal, identity.id)

    const byEmail = await store.findUsersByEmail(identity.email)
    const unbound = byEmail.filter((row) => !row.externalId)
    if (unbound.length === 1) return acceptLinkedUser(store, unbound[0], identity.id)

    if (byEmail.some((row) => row.externalId && row.externalId !== identity.id)) {
        return { ok: false, reason: 'rebind' }
    }

    if ((await store.countUsers()) === 0) {
        const allow = options.bootstrapEmail?.trim()
        if (!allow) return { ok: false, reason: 'bootstrap-unset' }
        if (identity.email.toLowerCase() !== allow.toLowerCase()) return { ok: false, reason: 'bootstrap-denied' }
        try {
            const user = await store.createOwner({
                email: identity.email,
                name: displayName(identity),
                credential: null,
                externalId: identity.id
            })
            return { ok: true, user, bootstrapped: true }
        } catch (error) {
            if (error instanceof NotEmptyError) return { ok: false, reason: 'unknown' }
            throw error
        }
    }

    if (unbound.length > 1) return { ok: false, reason: 'ambiguous' }
    return { ok: false, reason: 'unknown' }
}

export function linkFailureMessage(reason: LinkFailure): string {
    switch (reason) {
        case 'unverified':
            return 'Email is not verified.'
        case 'rebind':
            return 'This email is already linked to a different sign-in.'
        case 'inactive':
            return 'This account is not active.'
        case 'ambiguous':
            return 'This email matches more than one account.'
        case 'bootstrap-unset':
            return 'First-user setup is not configured.'
        case 'bootstrap-denied':
            return 'This email cannot create the first account.'
        default:
            return 'No account exists for this email.'
    }
}
