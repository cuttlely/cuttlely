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
 * A pending invite becomes active only with that invite's one-time token. A matching email alone never activates it.
 */

import { IdentityStore } from './store'
import { LinkFailure, LinkResult, NotEmptyError, UserRow, WorkosIdentity } from './types'

export const INVITE_PENDING = 'You have a pending invite. Open the invite link from your email to join.'
export const INVITE_LINK_INVALID = 'This invite link is not valid. Ask for a new invite.'

export function isActiveStatus(status: string | null | undefined): boolean {
    return (status || '').toLowerCase() === 'active'
}

export function isPendingInvite(status: string | null | undefined): boolean {
    return (status || '').toLowerCase() === 'invited'
}

/** AuthKit may open an active row, or a pending invite through its invite link. */
export function isAuthKitEligible(status: string | null | undefined): boolean {
    return isActiveStatus(status) || isPendingInvite(status)
}

export interface LinkOptions {
    bootstrapEmail?: string
    /** Raw token from the invite link, carried through the AuthKit round trip. */
    inviteToken?: string
    now?: number
    /** A durable subject link may sign in; new mailbox matches wait for administrator review when false. */
    automaticEmailLinking?: boolean
    providerKey?: string
    providerLinkedUser?: UserRow | null
    recordProviderLink?: (user: UserRow, basis: string) => Promise<boolean>
}

async function acceptLinkedUser(store: IdentityStore, row: UserRow, identity: WorkosIdentity, options: LinkOptions): Promise<LinkResult> {
    if (!isAuthKitEligible(row.status)) return { ok: false, reason: 'inactive' }
    if (isPendingInvite(row.status)) {
        if (!options.inviteToken) return { ok: false, reason: 'invite-required' }
        if (row.externalId && row.externalId !== identity.id) return { ok: false, reason: 'rebind' }
        const accepted = await store.acceptInvite({
            token: options.inviteToken,
            userId: row.id,
            email: identity.email,
            externalId: identity.id,
            now: options.now ?? Date.now(),
            ...(options.providerKey
                ? {
                      providerKey: options.providerKey,
                      subject: identity.id,
                      assuranceBasis: 'invitation',
                      retainExternalId: true
                  }
                : {})
        })
        if (accepted !== 'accepted') return { ok: false, reason: 'invite-invalid' }
        return { ok: true, user: { ...row, externalId: identity.id, status: 'active' }, bootstrapped: false }
    }
    if (row.externalId && row.externalId !== identity.id) return { ok: false, reason: 'rebind' }
    if (!row.externalId) {
        const linked = await store.setExternalId(row.id, identity.id)
        if (linked === 'rebind') return { ok: false, reason: 'rebind' }
        if (linked !== 'linked') return { ok: false, reason: 'unknown' }
    }
    return { ok: true, user: { ...row, externalId: identity.id }, bootstrapped: false }
}

/**
 * Mailbox comparison for linking. Surrounding spaces and letter case are ignored.
 * A plus tag, a dot, or a different domain is a different mailbox.
 */
export function mailboxKey(email: string): string {
    return email.trim().toLowerCase()
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
export async function linkWorkosUser(store: IdentityStore, identity: WorkosIdentity, options: LinkOptions = {}): Promise<LinkResult> {
    if (options.providerLinkedUser) return acceptLinkedUser(store, options.providerLinkedUser, identity, options)

    if (identity.emailVerified !== true) return { ok: false, reason: 'unverified' }
    const wanted = mailboxKey(identity.email)
    if (!wanted) return { ok: false, reason: 'unknown' }

    const byExternal = await store.findUserByExternalId(identity.id)
    if (byExternal) {
        const result = await acceptLinkedUser(store, byExternal, identity, options)
        if (result.ok && options.recordProviderLink) await options.recordProviderLink(result.user, 'workos_legacy')
        return result
    }

    if (options.automaticEmailLinking === false) return { ok: false, reason: 'review-required' }

    const byEmail = (await store.findUsersByEmail(wanted)).filter((row) => mailboxKey(row.email) === wanted)
    if (byEmail.length > 1) return { ok: false, reason: 'ambiguous' }
    if (byEmail.length === 1) {
        const row = byEmail[0]
        if (row.externalId && row.externalId !== identity.id) return { ok: false, reason: 'rebind' }
        const result = await acceptLinkedUser(store, row, identity, options)
        if (result.ok && options.recordProviderLink) await options.recordProviderLink(result.user, 'email_verified')
        return result
    }

    if ((await store.countUsers()) === 0) {
        const allow = options.bootstrapEmail?.trim()
        if (!allow) return { ok: false, reason: 'bootstrap-unset' }
        if (mailboxKey(identity.email) !== mailboxKey(allow)) return { ok: false, reason: 'bootstrap-denied' }
        try {
            // An open first-run code is retired in this same createOwner transaction.
            const user = await store.createOwner({
                email: identity.email,
                name: displayName(identity),
                credential: null,
                externalId: identity.id
            })
            if (options.recordProviderLink) await options.recordProviderLink(user, 'email_verified')
            return { ok: true, user, bootstrapped: true }
        } catch (error) {
            if (error instanceof NotEmptyError) return { ok: false, reason: 'unknown' }
            throw error
        }
    }

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
        case 'invite-required':
            return INVITE_PENDING
        case 'invite-invalid':
            return INVITE_LINK_INVALID
        case 'review-required':
            return 'An administrator must review the WorkOS configuration before this account can be linked.'
        default:
            return 'No account exists for this email.'
    }
}
