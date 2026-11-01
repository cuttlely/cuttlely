/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { randomBytes } from 'crypto'
import { inviteAccount, LinkDeps, liveInviteUser } from './actionLink'
import { resetAuthSecretsForTests } from './authSecrets'
import { deactivateUserInTransaction, DirectoryError, Sql } from './directory'
import { LoginRateLimit } from './rateLimit'
import {
    authenticateScimToken,
    createUser,
    createScimToken,
    deleteUser,
    endScimOverlap,
    errorBody,
    parseScimFilter,
    patchChanges,
    readScimTokenState,
    recordScimAuthenticationFailureAudit,
    revokeScimTokens,
    rotateScimToken,
    ScimError,
    serviceProviderConfig,
    groupResourceType,
    groupSchema,
    mutateUser,
    operationCategoryForGroupChanges,
    operationCategoryForUserChanges,
    pageUsers,
    userResourceType,
    userSchema,
    usersForOrganization
} from './scim'
import { groupPatchChanges } from './scimGroups'

const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
        exec(sql: string): void
        close(): void
        prepare(sql: string): {
            all(...params: unknown[]): Record<string, unknown>[]
            get(...params: unknown[]): Record<string, unknown> | undefined
            run(...params: unknown[]): { changes: number }
        }
    }
}

type MemoryDatabase = InstanceType<typeof DatabaseSync>

function sqlite(): { sql: Sql; db: MemoryDatabase } {
    const db = new DatabaseSync(':memory:')
    const query = async (statement: string, params: unknown[] = []) => {
        const prepared = db.prepare(statement)
        if (/^\s*(select|with)\b/i.test(statement)) return prepared.all(...params) as Record<string, unknown>[]
        prepared.run(...params)
        return []
    }
    const sql: Sql = {
        type: 'sqlite',
        query,
        transaction: async (fn) => {
            db.exec('BEGIN IMMEDIATE')
            try {
                const result = await fn(query)
                db.exec('COMMIT')
                return result
            } catch (error) {
                db.exec('ROLLBACK')
                throw error
            }
        }
    }
    return { sql, db }
}

describe('SCIM bearer lifecycle', () => {
    const actor = { id: 'owner-1', organizationId: 'org-1' }
    const started = Date.UTC(2026, 9, 31, 12)

    beforeAll(() => {
        process.env.TOKEN_HASH_SECRET = randomBytes(32).toString('hex')
        resetAuthSecretsForTests()
    })

    afterAll(() => {
        delete process.env.TOKEN_HASH_SECRET
        resetAuthSecretsForTests()
    })

    function store() {
        const value = sqlite()
        value.db.exec(`
            CREATE TABLE identity_scim_configuration (
                id integer primary key, organizationId text, activeTokenId text, previousTokenId text
            );
            INSERT INTO identity_scim_configuration (id) VALUES (1);
            CREATE TABLE identity_scim_token (
                id text primary key, organizationId text not null, tokenHmac text not null unique,
                displayPrefix text not null, status text not null, createdAt text not null, createdBy text not null,
                lastUsedAt text, overlapEndsAt text, revokedAt text
            );
            CREATE TABLE audit_event (
                id text, type text, organizationId text, workspaceId text, userId text,
                actorId text, summary text, detail text, createdAt integer
            );
        `)
        return value
    }

    it('stores only a keyed digest and returns the clear value only from create and rotate', async () => {
        const { sql, db } = store()
        const created = await createScimToken(sql, actor, started)
        expect(created.clear).toMatch(/^cuttlely_scim_/)
        const row = db.prepare('SELECT tokenHmac, displayPrefix FROM identity_scim_token').get() as Record<string, unknown>
        expect(row.tokenHmac).not.toBe(created.clear)
        expect(JSON.stringify(row)).not.toContain(created.clear)
        expect(await authenticateScimToken(sql, randomBytes(32).toString('base64url'), started + 1)).toBeNull()
        expect(await authenticateScimToken(sql, created.clear, started + 1)).toMatchObject({ organizationId: actor.organizationId })
        expect(await readScimTokenState(sql)).not.toHaveProperty('clear')

        const rotated = await rotateScimToken(sql, actor, 1, started + 1000)
        expect(rotated.clear).not.toBe(created.clear)
        expect(rotated.state.status).toBe('overlap')
        expect(await authenticateScimToken(sql, created.clear, started + 30 * 60 * 1000)).not.toBeNull()
        expect(await authenticateScimToken(sql, created.clear, started + 61 * 60 * 1000)).toBeNull()
        expect(await authenticateScimToken(sql, rotated.clear, started + 61 * 60 * 1000)).not.toBeNull()
        expect(db.prepare("SELECT COUNT(*) AS count FROM audit_event WHERE type = 'scim_token'").get()).toMatchObject({ count: 2 })
        db.close()
    })

    it('aggregates authentication failures into persisted five-minute audit windows', async () => {
        const { sql, db } = store()
        await recordScimAuthenticationFailureAudit(sql, 'org-1', 'credential_missing', started)
        await recordScimAuthenticationFailureAudit(sql, 'org-1', 'credential_refused', started + 1_000)
        await recordScimAuthenticationFailureAudit(sql, 'org-1', 'credential_refused', started + 5 * 60 * 1_000 + 1)
        const rows = db
            .prepare("SELECT detail FROM audit_event WHERE type = 'scim_auth_failure' ORDER BY createdAt ASC")
            .all()
            .map((row) => JSON.parse(String(row.detail)) as Record<string, unknown>)
        expect(rows).toHaveLength(2)
        expect(rows[0]).toMatchObject({
            count: 2,
            firstOccurrenceAt: new Date(started).toISOString(),
            lastOccurrenceAt: new Date(started + 1_000).toISOString(),
            categories: ['credential_missing', 'credential_refused']
        })
        expect(rows[1]).toMatchObject({ count: 1, categories: ['credential_refused'] })
        expect(rows.reduce((total, row) => total + Number(row.count), 0)).toBe(3)
        db.close()
    })

    it('ends overlap immediately and revocation is decided from the stored rows', async () => {
        const { sql, db } = store()
        const first = await createScimToken(sql, actor, started)
        const second = await rotateScimToken(sql, actor, 24, started + 1)
        await endScimOverlap(sql, actor, started + 2)
        expect(await authenticateScimToken(sql, first.clear, started + 3)).toBeNull()
        expect(await authenticateScimToken(sql, second.clear, started + 3)).not.toBeNull()
        await revokeScimTokens(sql, actor, started + 4)
        expect(await authenticateScimToken(sql, second.clear, started + 5)).toBeNull()
        expect((await readScimTokenState(sql)).status).toBe('revoked')
        db.close()
    })

    it('bounds rotation overlap', async () => {
        const { sql, db } = store()
        await createScimToken(sql, actor, started)
        await expect(rotateScimToken(sql, actor, 25, started + 1)).rejects.toMatchObject({ status: 400 })
        db.close()
    })
})

describe('SCIM filters', () => {
    it.each([
        'userName eq "person@example.com"',
        'USERNAME eq "person@example.com" and (externalId eq "42" or displayName eq "Person")',
        '(userName eq "a@example.com" or userName eq "b@example.com") and displayName eq "A"'
    ])('accepts supported eq expressions: %s', (filter) => {
        expect(parseScimFilter(filter)).toBeDefined()
    })

    it.each(['emails eq "a@example.com"', 'userName co "example"', 'userName eq "a" trailing', 'userName eq a'])(
        'rejects unsupported filters: %s',
        (filter) => {
            expect(() => parseScimFilter(filter)).toThrow(ScimError)
            try {
                parseScimFilter(filter)
            } catch (error) {
                expect(error).toMatchObject({ status: 400, scimType: 'invalidFilter' })
            }
        }
    )
})

describe('SCIM protocol documents', () => {
    it('advertises the supported service capabilities and User resource', () => {
        expect(serviceProviderConfig).toMatchObject({
            patch: { supported: true },
            bulk: { supported: false },
            filter: { supported: true, maxResults: expect.any(Number) },
            changePassword: { supported: false },
            sort: { supported: false },
            etag: { supported: false },
            authenticationSchemes: [{ type: 'oauthbearertoken' }]
        })
        expect(userResourceType).toMatchObject({ id: 'User', endpoint: '/Users' })
        expect(groupResourceType).toMatchObject({ id: 'Group', endpoint: '/Groups' })
        expect(userSchema.attributes.map((attribute) => attribute.name)).toEqual([
            'userName',
            'externalId',
            'displayName',
            'name',
            'emails',
            'active'
        ])
        expect(groupSchema.attributes.map((attribute) => attribute.name)).toEqual(['displayName', 'externalId', 'members'])
    })

    it('uses the RFC error envelope with a string status', () => {
        expect(errorBody(400, 'Bad filter.', 'invalidFilter')).toEqual({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
            status: '400',
            detail: 'Bad filter.',
            scimType: 'invalidFilter'
        })
    })
})

describe('SCIM users', () => {
    const actor = { organizationId: 'org-1', tokenId: 'token-1', displayPrefix: 'cuttlely_scim_test…', creatorId: 'owner-1' }

    function directoryStore() {
        const value = sqlite()
        value.db.exec(`
            CREATE TABLE user (
                id text primary key, name text, email text unique, credential text, status text,
                externalId text, ssoProvider text, ssoSubjectId text,
                createdBy text, updatedBy text, createdDate text default CURRENT_TIMESTAMP,
                updatedDate text default CURRENT_TIMESTAMP, permissionVersion integer not null default 0
            );
            CREATE TABLE role (
                id text primary key, organizationId text, name text, description text, permissions text,
                createdDate text default CURRENT_TIMESTAMP
            );
            CREATE TABLE organization_user (
                organizationId text, userId text, roleId text, status text,
                createdBy text, updatedBy text, createdDate text default CURRENT_TIMESTAMP, updatedDate text default CURRENT_TIMESTAMP
            );
            CREATE TABLE workspace (id text primary key, organizationId text, name text, description text, updatedDate text);
            CREATE TABLE workspace_user (
                workspaceId text, userId text, roleId text, status text, createdBy text, updatedBy text,
                primary key (workspaceId, userId)
            );
            CREATE TABLE identity_action_link (
                id text primary key, tokenHash text unique, purpose text, organizationId text, workspaceId text,
                userId text, expiresAt text, usedAt text, consumeId text, createdBy text, createdDate text
            );
            CREATE TABLE identity_action_audit (
                id text primary key, action text, purpose text, organizationId text, workspaceId text,
                userId text, actorId text, result text, reason text, createdDate text
            );
            CREATE TABLE identity_local_session (id text, userId text);
            CREATE TABLE apikey (id text, ownerUserId text, disabledAt text);
            CREATE TABLE identity_personal_token (id text, ownerUserId text, tokenHash text, disabledAt text);
            CREATE TABLE identity_scim_user (
                id text primary key, organizationId text not null, userId text not null unique,
                externalId text, userName text not null, normalizedUserName text not null,
                displayName text not null, givenName text, familyName text, workEmail text,
                deletedAt text, createdAt text not null, updatedAt text not null,
                unique (organizationId, normalizedUserName), unique (organizationId, externalId)
            );
            CREATE TABLE identity_scim_group (
                id text primary key, organizationId text, externalId text, displayName text, normalizedDisplayName text,
                deletedAt text, createdAt text, updatedAt text, unique (organizationId, normalizedDisplayName)
            );
            CREATE TABLE identity_scim_group_member (groupId text, scimUserId text, createdAt text, primary key (groupId, scimUserId));
            CREATE TABLE identity_scim_mapping (
                id text primary key, organizationId text, groupId text, workspaceId text, roleId text, createdAt text, createdBy text
            );
            CREATE TABLE identity_scim_assignment (
                mappingId text, userId text, workspaceId text, roleId text, createdAt text, primary key (mappingId, userId)
            );
            CREATE TABLE identity_scim_diagnostic (
                id text primary key, organizationId text, category text, outcome text,
                correlationId text, detail text, completedAt text
            );
            CREATE TABLE audit_event (
                id text, type text, organizationId text, workspaceId text, userId text,
                actorId text, summary text, detail text, createdAt integer
            );
            INSERT INTO role (id, name) VALUES ('member-role', 'member'), ('owner-role', 'owner');
            INSERT INTO user (id, name, email, status, createdBy, updatedBy) VALUES
                ('owner-1', 'Owner One', 'owner1@example.com', 'active', 'owner-1', 'owner-1'),
                ('owner-2', 'Owner Two', 'owner2@example.com', 'active', 'owner-1', 'owner-1');
            INSERT INTO organization_user (organizationId, userId, roleId, status, createdBy, updatedBy) VALUES
                ('org-1', 'owner-1', 'owner-role', 'active', 'owner-1', 'owner-1'),
                ('org-1', 'owner-2', 'owner-role', 'active', 'owner-1', 'owner-1');
        `)
        return value
    }

    it('activates a matched pending account and closes its invitation', async () => {
        const { sql, db } = directoryStore()
        const now = Date.UTC(2026, 9, 31, 12)
        db.prepare('INSERT INTO workspace (id, organizationId, name) VALUES (?, ?, ?)').run('invite-team', 'org-1', 'Invite Team')
        const deps: LinkDeps = {
            now: () => now,
            env: {},
            origin: () => 'https://example.com',
            mailReady: () => false,
            send: async () => undefined,
            rateLimit: new LoginRateLimit(),
            activeMethod: () => 'oidc'
        }
        const invitation = await inviteAccount(
            sql,
            { id: 'owner-1', organizationId: 'org-1', workspaceId: 'invite-team', owner: true },
            {
                user: { name: 'Invited User', email: 'invited@example.com' },
                workspace: { id: 'invite-team' },
                role: { id: 'member-role' },
                link: true
            },
            deps
        )
        const token = decodeURIComponent(new URL(invitation.link || '').hash.slice('#token='.length))
        await expect(liveInviteUser(sql, token, now)).resolves.toBe(invitation.id)

        const provisioned = await createUser(sql, actor, { userName: 'invited@example.com' }, now + 1)

        expect(provisioned).toMatchObject({ userId: invitation.id, userStatus: 'active', membershipStatus: 'active' })
        await expect(liveInviteUser(sql, token, now + 2)).resolves.toBeNull()
        expect(db.prepare('SELECT usedAt, consumeId FROM identity_action_link WHERE userId = ?').get(invitation.id)).toMatchObject({
            usedAt: expect.any(String),
            consumeId: 'revoked'
        })
        expect(db.prepare("SELECT summary FROM audit_event WHERE type = 'scim_user' AND userId = ?").get(invitation.id)).toMatchObject({
            summary: 'SCIM user created'
        })

        const inactiveInvitation = await inviteAccount(
            sql,
            { id: 'owner-1', organizationId: 'org-1', workspaceId: 'invite-team', owner: true },
            {
                user: { name: 'Inactive Invite', email: 'inactive-invite@example.com' },
                workspace: { id: 'invite-team' },
                role: { id: 'member-role' },
                link: true
            },
            deps
        )
        const inactive = await createUser(sql, actor, { userName: 'inactive-invite@example.com', active: false }, now + 3)
        expect(inactive).toMatchObject({ userId: inactiveInvitation.id, userStatus: 'disable', membershipStatus: 'disable' })

        db.prepare("UPDATE user SET status = 'invited' WHERE id = ?").run(inactive.userId)
        db.prepare("UPDATE organization_user SET status = 'active' WHERE organizationId = ? AND userId = ?").run('org-1', inactive.userId)
        db.prepare(
            'INSERT INTO identity_action_link (id, tokenHash, purpose, organizationId, workspaceId, userId) VALUES (?, ?, ?, ?, ?, ?)'
        ).run('pending-update-link', 'pending-update-hash', 'invite', 'org-1', 'invite-team', inactive.userId)
        const reactivated = await mutateUser(sql, actor, inactive.id, { active: true }, 'updated', now + 4)
        expect(reactivated).toMatchObject({ userStatus: 'active', membershipStatus: 'active' })
        expect(db.prepare('SELECT usedAt, consumeId FROM identity_action_link WHERE id = ?').get('pending-update-link')).toMatchObject({
            usedAt: expect.any(String),
            consumeId: 'revoked'
        })
        db.close()
    })

    it('creates, reads, replaces, deactivates, deletes, and restores a stable resource', async () => {
        const { sql, db } = directoryStore()
        const created = await createUser(
            sql,
            actor,
            {
                userName: 'person@example.com',
                externalId: 'provider-42',
                displayName: 'First Person',
                name: { givenName: 'First', familyName: 'Person' },
                emails: [{ type: 'work', value: 'person@example.com' }]
            },
            Date.UTC(2026, 9, 31, 12)
        )
        expect(created.userName).toBe('person@example.com')
        expect(db.prepare('SELECT credential FROM user WHERE id = ?').get(created.userId)).toMatchObject({ credential: null })
        expect(db.prepare('SELECT roleId FROM organization_user WHERE userId = ?').get(created.userId)).toMatchObject({
            roleId: 'member-role'
        })
        const mappedAt = '2026-10-31T12:30:00.000Z'
        db.prepare('INSERT INTO workspace (id, organizationId, name) VALUES (?, ?, ?)').run('mapped-team', 'org-1', 'Mapped Team')
        db.prepare('INSERT INTO identity_scim_group VALUES (?, ?, ?, ?, ?, NULL, ?, ?)').run(
            'mapped-group',
            'org-1',
            'mapped-external',
            'Mapped Group',
            'mapped group',
            mappedAt,
            mappedAt
        )
        db.prepare('INSERT INTO identity_scim_group_member VALUES (?, ?, ?)').run('mapped-group', created.id, mappedAt)
        db.prepare('INSERT INTO identity_scim_mapping VALUES (?, ?, ?, ?, NULL, ?, ?)').run(
            'mapped-mapping',
            'org-1',
            'mapped-group',
            'mapped-team',
            mappedAt,
            'owner-1'
        )
        await mutateUser(sql, actor, created.id, { active: true }, 'updated', Date.UTC(2026, 9, 31, 12, 30))
        expect(db.prepare('SELECT roleId FROM workspace_user WHERE userId = ?').get(created.userId)).toMatchObject({
            roleId: 'member-role'
        })

        const replaced = await mutateUser(
            sql,
            actor,
            created.id,
            { displayName: 'Updated Person', givenName: 'Updated', externalId: 'provider-43' },
            'replaced',
            Date.UTC(2026, 9, 31, 13)
        )
        expect(replaced).toMatchObject({ displayName: 'Updated Person', givenName: 'Updated', externalId: 'provider-43' })

        db.prepare('INSERT INTO identity_local_session VALUES (?, ?)').run('session-1', created.userId)
        db.prepare('INSERT INTO apikey VALUES (?, ?, NULL)').run('key-1', created.userId)
        db.prepare('INSERT INTO identity_personal_token VALUES (?, ?, ?, NULL)').run('personal-1', created.userId, 'digest')
        const inactive = await mutateUser(
            sql,
            actor,
            created.id,
            patchChanges({ Operations: [{ op: 'Replace', path: 'active', value: 'False' }] }),
            'updated',
            Date.UTC(2026, 9, 31, 14)
        )
        expect(inactive.userStatus).toBe('disable')
        expect(db.prepare('SELECT COUNT(*) AS count FROM identity_local_session').get()).toMatchObject({ count: 0 })
        expect(db.prepare('SELECT disabledAt FROM apikey').get()).toMatchObject({ disabledAt: expect.any(String) })

        await mutateUser(sql, actor, created.id, { active: true }, 'updated', Date.UTC(2026, 9, 31, 15))
        expect(db.prepare('SELECT disabledAt FROM apikey').get()).toMatchObject({ disabledAt: expect.any(String) })

        await deleteUser(sql, actor, created.id, Date.UTC(2026, 9, 31, 16))
        expect(await usersForOrganization(sql.query, sql, 'org-1')).toHaveLength(0)
        expect(db.prepare('SELECT COUNT(*) AS count FROM identity_scim_group_member WHERE scimUserId = ?').get(created.id)).toMatchObject({
            count: 0
        })
        const restored = await createUser(sql, actor, { userName: 'person@example.com', externalId: 'provider-43' })
        expect(restored.id).toBe(created.id)
        expect(db.prepare('SELECT COUNT(*) AS count FROM workspace_user WHERE userId = ?').get(created.userId)).toMatchObject({
            count: 0
        })
        expect(db.prepare("SELECT COUNT(*) AS count FROM audit_event WHERE type = 'scim_user'").get()).toMatchObject({ count: 7 })
        db.close()
    })

    it('accepts pathless and identity-provider PATCH forms', () => {
        expect(patchChanges({ Operations: [{ op: 'replace', value: { active: false } }] })).toMatchObject({ active: false })
        expect(patchChanges({ Operations: [{ op: 'Add', path: 'name.givenName', value: 'A' }] })).toMatchObject({ givenName: 'A' })
        expect(
            patchChanges({ Operations: [{ op: 'Replace', path: 'emails[type eq "work"].value', value: 'work@example.com' }] })
        ).toMatchObject({ workEmail: 'work@example.com' })
        expect(
            patchChanges({
                Operations: [
                    {
                        op: 'Replace',
                        value: {
                            'NAME.GIVENNAME': 'Casey',
                            'emails[type eq "WORK"].value': 'casey.work@example.com',
                            ACTIVE: 'False'
                        }
                    }
                ]
            })
        ).toEqual({ givenName: 'Casey', workEmail: 'casey.work@example.com', active: false })
    })

    it('merges only attributes present in a pathless user PATCH', async () => {
        const { sql, db } = directoryStore()
        const created = await createUser(sql, actor, {
            userName: 'mira@example.com',
            externalId: 'Directory-Mira-1',
            displayName: 'Mira Vale',
            name: { givenName: 'Mira', familyName: 'Vale' },
            emails: [{ type: 'work', value: 'mira.work@example.com' }]
        })
        const changes = patchChanges({ Operations: [{ op: 'replace', value: { displayName: 'Mira North' } }] })
        expect(changes).toEqual({ displayName: 'Mira North' })

        const updated = await mutateUser(sql, actor, created.id, changes, 'updated')

        expect(updated).toMatchObject({
            displayName: 'Mira North',
            givenName: 'Mira',
            familyName: 'Vale',
            workEmail: 'mira.work@example.com',
            externalId: 'Directory-Mira-1'
        })
        db.close()
    })

    it('classifies every supported inactive mutation as a disabled-user operation', () => {
        const changes = [
            { active: false },
            patchChanges({ Operations: [{ op: 'replace', value: { active: false } }] }),
            patchChanges({ Operations: [{ op: 'Replace', path: 'active', value: 'False' }] }),
            patchChanges({ Operations: [{ op: 'replace', path: 'active', value: false }] })
        ]
        for (const change of changes) expect(operationCategoryForUserChanges(change)).toBe('usersDisabled')
        expect(operationCategoryForUserChanges(patchChanges({ Operations: [{ op: 'Replace', path: 'displayName', value: 'New' }] }))).toBe(
            'usersUpdated'
        )
    })

    it('classifies group membership operations from parsed PATCH changes', () => {
        expect(
            operationCategoryForGroupChanges(
                groupPatchChanges({ Operations: [{ op: 'Replace', path: 'displayName', value: 'Board Members' }] })
            )
        ).toBe('groupOperations')
        expect(
            operationCategoryForGroupChanges(
                groupPatchChanges({ Operations: [{ op: 'Add', path: 'members', value: [{ value: 'scim-user-1' }] }] })
            )
        ).toBe('membershipOperations')
        expect(operationCategoryForGroupChanges({ replaceMembers: [] })).toBe('membershipOperations')
    })

    it('audits PATCH and PUT active-state transitions with their resulting actions', async () => {
        const { sql, db } = directoryStore()
        const created = await createUser(sql, actor, { userName: 'audit-transition@example.com' })

        await mutateUser(sql, actor, created.id, { active: false }, 'updated')
        await mutateUser(sql, actor, created.id, { active: true }, 'updated')
        await mutateUser(sql, actor, created.id, { active: false }, 'replaced')
        await mutateUser(sql, actor, created.id, { active: true }, 'replaced')
        await mutateUser(sql, actor, created.id, { displayName: 'Updated name' }, 'updated')
        await mutateUser(sql, actor, created.id, { displayName: 'Replaced name' }, 'replaced')

        const operations = db
            .prepare("SELECT detail FROM audit_event WHERE type = 'scim_user'")
            .all()
            .map((row) => JSON.parse(String(row.detail)).operation)
        expect(operations.filter((operation) => operation === 'deactivated')).toHaveLength(2)
        expect(operations.filter((operation) => operation === 'reactivated')).toHaveLength(2)
        expect(operations).toEqual(expect.arrayContaining(['updated', 'replaced']))
        db.close()
    })

    it.each([
        ['PUT active false', { active: false }],
        ['pathless replace', patchChanges({ Operations: [{ op: 'replace', value: { active: false } }] })],
        ['capitalized replace with a string', patchChanges({ Operations: [{ op: 'Replace', path: 'active', value: 'False' }] })],
        ['active path', patchChanges({ Operations: [{ op: 'replace', path: 'active', value: false }] })]
    ])('%s uses the complete deactivation transaction', async (_label, changes) => {
        const { sql, db } = directoryStore()
        const created = await createUser(sql, actor, { userName: 'deactivate@example.com' })
        db.prepare(
            'INSERT INTO identity_action_link (id, tokenHash, purpose, organizationId, userId, usedAt, consumeId) VALUES (?, ?, ?, ?, ?, NULL, NULL)'
        ).run('invite-link', 'invite-hash', 'invite', 'org-1', created.userId)
        db.prepare(
            'INSERT INTO identity_action_link (id, tokenHash, purpose, organizationId, userId, usedAt, consumeId) VALUES (?, ?, ?, ?, ?, NULL, NULL)'
        ).run('reset-link', 'reset-hash', 'reset', 'org-1', created.userId)
        db.prepare('INSERT INTO identity_local_session VALUES (?, ?)').run('session-1', created.userId)
        db.prepare('INSERT INTO apikey VALUES (?, ?, NULL)').run('key-1', created.userId)
        db.prepare('INSERT INTO identity_personal_token VALUES (?, ?, ?, NULL)').run('personal-1', created.userId, 'digest')

        await mutateUser(sql, actor, created.id, changes, 'updated', Date.UTC(2026, 9, 31, 14))

        expect(db.prepare('SELECT COUNT(*) AS count FROM identity_local_session').get()).toMatchObject({ count: 0 })
        expect(db.prepare('SELECT COUNT(*) AS count FROM identity_action_link WHERE usedAt IS NOT NULL').get()).toMatchObject({ count: 2 })
        expect(db.prepare('SELECT disabledAt FROM apikey').get()).toMatchObject({ disabledAt: expect.any(String) })
        expect(db.prepare('SELECT disabledAt FROM identity_personal_token').get()).toMatchObject({ disabledAt: expect.any(String) })
        db.close()
    })

    it('deactivates a non-last owner and audits a refused last-owner delete without changing it', async () => {
        const { sql, db } = directoryStore()
        const at = '2026-10-31T12:00:00.000Z'
        db.prepare(
            `INSERT INTO identity_scim_user
             (id, organizationId, userId, userName, normalizedUserName, displayName, workEmail, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run('scim-owner-1', 'org-1', 'owner-1', 'owner1@example.com', 'owner1@example.com', 'Owner One', 'owner1@example.com', at, at)
        db.prepare(
            `INSERT INTO identity_scim_user
             (id, organizationId, userId, userName, normalizedUserName, displayName, workEmail, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run('scim-owner-2', 'org-1', 'owner-2', 'owner2@example.com', 'owner2@example.com', 'Owner Two', 'owner2@example.com', at, at)

        await deleteUser(sql, actor, 'scim-owner-1', Date.UTC(2026, 9, 31, 13))
        db.prepare('INSERT INTO identity_local_session VALUES (?, ?)').run('owner-session', 'owner-2')
        db.prepare('INSERT INTO apikey VALUES (?, ?, NULL)').run('owner-key', 'owner-2')

        await expect(
            mutateUser(sql, actor, 'scim-owner-2', { active: false }, 'updated', Date.UTC(2026, 9, 31, 13, 30))
        ).rejects.toMatchObject({ status: 409 })
        await expect(deleteUser(sql, actor, 'scim-owner-2', Date.UTC(2026, 9, 31, 14))).rejects.toMatchObject({ status: 409 })
        expect(db.prepare('SELECT status FROM user WHERE id = ?').get('owner-2')).toMatchObject({ status: 'active' })
        expect(db.prepare('SELECT status FROM organization_user WHERE userId = ?').get('owner-2')).toMatchObject({ status: 'active' })
        expect(db.prepare('SELECT COUNT(*) AS count FROM identity_local_session WHERE userId = ?').get('owner-2')).toMatchObject({
            count: 1
        })
        expect(db.prepare('SELECT disabledAt FROM apikey WHERE ownerUserId = ?').get('owner-2')).toMatchObject({ disabledAt: null })
        expect(db.prepare('SELECT deletedAt FROM identity_scim_user WHERE id = ?').get('scim-owner-2')).toMatchObject({ deletedAt: null })
        expect(db.prepare("SELECT COUNT(*) AS count FROM audit_event WHERE type = 'scim_user'").get()).toMatchObject({ count: 3 })
        db.close()
    })

    it('returns stable pages and empty connection probes for unknown names and external ids', async () => {
        const { sql, db } = directoryStore()
        await createUser(
            sql,
            actor,
            { userName: 'first@example.com', externalId: 'first-provider-id', displayName: 'First Person' },
            Date.UTC(2026, 9, 31, 12)
        )
        await createUser(sql, actor, { userName: 'second@example.com', externalId: 'second-provider-id' }, Date.UTC(2026, 9, 31, 13))
        const users = await usersForOrganization(sql.query, sql, 'org-1')

        expect(pageUsers(users, { startIndex: '2', count: '1' })).toMatchObject({
            totalResults: 2,
            startIndex: 2,
            itemsPerPage: 1,
            resources: [{ userName: 'second@example.com' }]
        })
        expect(pageUsers(users, { filter: 'userName eq "unknown@example.com"' })).toMatchObject({ totalResults: 0, resources: [] })
        expect(pageUsers(users, { filter: 'externalId eq "unknown-provider-id"' })).toMatchObject({ totalResults: 0, resources: [] })
        expect(pageUsers(users, { filter: 'externalId eq "FIRST-PROVIDER-ID"' })).toMatchObject({ totalResults: 0, resources: [] })
        expect(pageUsers(users, { filter: 'displayName eq "first person"' })).toMatchObject({ totalResults: 1 })
        expect(pageUsers(users, { filter: 'USERNAME eq "FIRST@example.com" or externalId eq "second-provider-id"' })).toMatchObject({
            totalResults: 2
        })
        db.close()
    })
})

describe('atomic deactivation', () => {
    it('keeps one owner and disables every persisted credential in the same transaction', async () => {
        const { sql, db } = sqlite()
        db.exec(`
            CREATE TABLE user (id text primary key, status text, permissionVersion integer not null default 0, updatedDate text);
            CREATE TABLE role (id text primary key, name text);
            CREATE TABLE organization_user (organizationId text, userId text, roleId text, status text, updatedDate text);
            CREATE TABLE workspace_user (workspaceId text, userId text);
            CREATE TABLE identity_action_link (userId text, purpose text, usedAt text, consumeId text, organizationId text);
            CREATE TABLE identity_local_session (id text, userId text);
            CREATE TABLE apikey (id text, ownerUserId text, disabledAt text);
            CREATE TABLE identity_personal_token (id text, ownerUserId text, tokenHash text, disabledAt text);
            INSERT INTO role VALUES ('owner-role', 'owner');
            INSERT INTO user VALUES ('owner-1', 'active', 0, NULL), ('owner-2', 'active', 0, NULL);
            INSERT INTO organization_user VALUES ('org-1', 'owner-1', 'owner-role', 'active', NULL), ('org-1', 'owner-2', 'owner-role', 'active', NULL);
            INSERT INTO identity_action_link VALUES
                ('owner-1', 'invite', NULL, NULL, 'org-1'),
                ('owner-1', 'reset', NULL, NULL, 'org-2');
            INSERT INTO identity_local_session VALUES ('session-1', 'owner-1');
            INSERT INTO apikey VALUES ('key-1', 'owner-1', NULL);
            INSERT INTO identity_personal_token VALUES ('personal-1', 'owner-1', 'digest', NULL);
        `)
        await sql.transaction((query) => deactivateUserInTransaction(query, sql, 'org-1', 'owner-1', Date.UTC(2026, 9, 31)))
        expect(db.prepare('SELECT status, permissionVersion FROM user WHERE id = ?').get('owner-1')).toMatchObject({
            status: 'disable',
            permissionVersion: 1
        })
        expect(db.prepare('SELECT COUNT(*) AS count FROM identity_local_session').get()).toMatchObject({ count: 0 })
        expect(db.prepare('SELECT COUNT(*) AS count FROM identity_action_link WHERE usedAt IS NOT NULL').get()).toMatchObject({ count: 2 })
        expect(db.prepare('SELECT disabledAt FROM apikey').get()).toMatchObject({ disabledAt: expect.any(String) })
        expect(db.prepare('SELECT disabledAt FROM identity_personal_token').get()).toMatchObject({ disabledAt: expect.any(String) })
        await expect(
            sql.transaction((query) => deactivateUserInTransaction(query, sql, 'org-1', 'owner-2', Date.UTC(2026, 9, 31)))
        ).rejects.toBeInstanceOf(DirectoryError)
        expect(db.prepare('SELECT status FROM user WHERE id = ?').get('owner-2')).toMatchObject({ status: 'active' })
        db.close()
    })
})
