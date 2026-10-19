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

import { AuthKitSwitchApply, AuthKitSwitchState } from './authKitSwitch'
import { CreateOwnerInput, InviteSignIn, LocalSession, SessionUser, UserRow } from './types'

export interface IdentityStore {
    countUsers(): Promise<number>
    listEmails(): Promise<string[]>
    findUserByExternalId(externalId: string): Promise<UserRow | null>
    findUsersByEmail(email: string): Promise<UserRow[]>
    setExternalId(userId: string, externalId: string): Promise<'linked' | 'rebind' | 'missing'>
    findSuperUser(): Promise<UserRow | null>
    setCredential(userId: string, credential: string): Promise<void>
    /**
     * Replaces the stored hash only when it still equals `expected`.
     * Returns false when the row is missing or another writer already changed it.
     */
    replaceCredential(userId: string, expected: string, next: string): Promise<boolean>
    createOwner(input: CreateOwnerInput): Promise<UserRow>
    /**
     * Uses one invite token for this pending user: the token must be an unused, unexpired invite for that user and
     * that mailbox, and the invite must still stand. In one transaction it marks the token used, sets the user
     * `active`, and binds the AuthKit id. Anything else leaves the user and the token unchanged.
     */
    acceptInvite(input: InviteSignIn): Promise<'accepted' | 'invalid'>
    sessionFor(userId: string, preferredWorkspaceId?: string | null): Promise<SessionUser | null>
    touchLastLogin(userId: string, workspaceId: string | null, at: Date): Promise<void>
    insertLocalSession(row: LocalSession): Promise<void>
    findLocalSession(token: string): Promise<LocalSession | null>
    slideLocalSession(token: string, idleExpires: Date, lastSeenAt?: Date): Promise<void>
    deleteLocalSession(token: string): Promise<void>
    /** Removes every local session for this user. Holds across restarts because the rows are in the database. */
    deleteLocalSessionsForUser(userId: string): Promise<void>
    /**
     * True when the user row is active and no organization membership is `disable`.
     * A missing user, an invited or deleted user, and a disabled membership are false.
     */
    localAccountOpen(userId: string): Promise<boolean>
    /** Null until the switch row has been written. */
    readAuthKitSwitch(): Promise<AuthKitSwitchState | null>
    /**
     * When AuthKit becomes configured, deletes every local session and records that.
     * A later call while it stays configured does not delete sessions created after the switch.
     * `recordOff` is only for the web server. Without it, seeing AuthKit unconfigured leaves a recorded-on switch as it is.
     */
    applyAuthKitSwitch(configured: boolean, at: Date, options?: AuthKitSwitchApply): Promise<AuthKitSwitchState>
}
