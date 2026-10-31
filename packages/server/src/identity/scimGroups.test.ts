/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { Sql } from './directory'
import { TokenActor } from './scim'
import {
    createGroup,
    createMapping,
    deleteGroup,
    groupPatchChanges,
    groupsForOrganization,
    mappingOptions,
    mutateGroup,
    pageGroups,
    previewMappingRemoval,
    readScimOperations,
    recordScimOperation,
    removeMapping,
    sweepScimDiagnostics
} from './scimGroups'

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

const tokenActor: TokenActor = {
    organizationId: 'org-1',
    tokenId: 'token-1',
    displayPrefix: 'cuttlely_scim_test…',
    creatorId: 'owner-1'
}
const adminActor = { id: 'owner-1', organizationId: 'org-1' }
const start = Date.UTC(2026, 9, 31, 12)

function store(): { sql: Sql; db: MemoryDatabase } {
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
    db.exec(`
        CREATE TABLE user (
            id text primary key, name text, status text, permissionVersion integer not null default 0,
            createdBy text, updatedBy text
        );
        CREATE TABLE role (id text primary key, organizationId text, name text, permissions text, createdDate text default CURRENT_TIMESTAMP);
        CREATE TABLE organization_user (organizationId text, userId text, roleId text, status text);
        CREATE TABLE workspace (id text primary key, organizationId text, name text);
        CREATE TABLE workspace_user (
            workspaceId text, userId text, roleId text, status text, createdBy text, updatedBy text,
            primary key (workspaceId, userId)
        );
        CREATE TABLE identity_scim_user (
            id text primary key, organizationId text, userId text, displayName text, deletedAt text
        );
        CREATE TABLE identity_scim_group (
            id text primary key, organizationId text, externalId text, displayName text,
            deletedAt text, createdAt text, updatedAt text, unique (organizationId, externalId)
        );
        CREATE TABLE identity_scim_group_member (
            groupId text, scimUserId text, createdAt text, primary key (groupId, scimUserId)
        );
        CREATE TABLE identity_scim_mapping (
            id text primary key, organizationId text, groupId text unique, workspaceId text,
            roleId text, createdAt text, createdBy text
        );
        CREATE TABLE identity_scim_assignment (
            mappingId text, userId text, workspaceId text, roleId text, createdAt text,
            primary key (mappingId, userId)
        );
        CREATE TABLE identity_scim_diagnostic (
            id text primary key, organizationId text, category text, outcome text,
            correlationId text, detail text, completedAt text
        );
        INSERT INTO role VALUES
            ('role-member', NULL, 'member', '[]', CURRENT_TIMESTAMP),
            ('role-viewer', 'org-1', 'viewer-custom', '["chatflows:view"]', CURRENT_TIMESTAMP),
            ('role-builder', 'org-1', 'builder-custom', '["chatflows:update"]', CURRENT_TIMESTAMP),
            ('role-auth', 'org-1', 'auth-admin', '["authentication:manage"]', CURRENT_TIMESTAMP),
            ('role-admin', 'org-1', 'admin', '[]', CURRENT_TIMESTAMP),
            ('role-owner', NULL, 'owner', '["authentication:manage"]', CURRENT_TIMESTAMP);
        INSERT INTO user VALUES
            ('owner-1', 'Owner', 'active', 0, 'owner-1', 'owner-1'),
            ('user-1', 'Ada', 'active', 0, 'owner-1', 'owner-1'),
            ('user-2', 'Lin', 'active', 0, 'owner-1', 'owner-1'),
            ('user-3', 'Manual', 'active', 0, 'owner-1', 'owner-1');
        INSERT INTO organization_user VALUES
            ('org-1', 'owner-1', 'role-owner', 'active'),
            ('org-1', 'user-1', 'role-member', 'active'),
            ('org-1', 'user-2', 'role-member', 'active'),
            ('org-1', 'user-3', 'role-member', 'active');
        INSERT INTO identity_scim_user VALUES
            ('scim-user-1', 'org-1', 'user-1', 'Ada', NULL),
            ('scim-user-2', 'org-1', 'user-2', 'Lin', NULL),
            ('scim-user-3', 'org-1', 'user-3', 'Manual', NULL);
        INSERT INTO workspace VALUES ('team-1', 'org-1', 'Product'), ('team-2', 'org-1', 'Support');
        INSERT INTO workspace_user VALUES ('team-1', 'user-3', 'role-builder', 'active', 'owner-1', 'owner-1');
    `)
    return { sql, db }
}

describe('SCIM groups', () => {
    it('creates, filters, pages, replaces, patches every membership form, and deletes', async () => {
        const { sql, db } = store()
        const group = await createGroup(
            sql,
            tokenActor,
            {
                displayName: 'Engineering',
                externalId: 'provider-group-1',
                members: [{ value: 'scim-user-1' }]
            },
            start
        )
        expect(group.members).toEqual([{ value: 'scim-user-1', display: 'Ada' }])
        expect(pageGroups([group], { filter: 'displayName eq "Engineering" and externalId eq "provider-group-1"' })).toMatchObject({
            totalResults: 1,
            itemsPerPage: 1
        })
        expect(pageGroups([group], { startIndex: '2', count: '1' })).toMatchObject({ itemsPerPage: 0 })
        expect(() => pageGroups([group], { filter: 'members eq "scim-user-1"' })).toThrow(
            expect.objectContaining({ status: 400, scimType: 'invalidFilter' })
        )

        await mutateGroup(
            sql,
            tokenActor,
            group.id,
            groupPatchChanges({ Operations: [{ op: 'Add', path: 'members', value: [{ value: 'scim-user-2' }] }] }),
            start + 1
        )
        await mutateGroup(
            sql,
            tokenActor,
            group.id,
            groupPatchChanges({ Operations: [{ op: 'Remove', path: 'members', value: [{ value: 'scim-user-1' }] }] }),
            start + 2
        )
        await mutateGroup(
            sql,
            tokenActor,
            group.id,
            groupPatchChanges({ Operations: [{ op: 'Add', path: 'members', value: [{ value: 'scim-user-1' }] }] }),
            start + 3
        )
        await mutateGroup(
            sql,
            tokenActor,
            group.id,
            groupPatchChanges({ Operations: [{ op: 'Remove', path: 'members[value eq "scim-user-2"]' }] }),
            start + 4
        )
        const replaced = await mutateGroup(
            sql,
            tokenActor,
            group.id,
            groupPatchChanges({
                Operations: [
                    { op: 'Replace', value: { displayName: 'Platform', externalId: 'provider-group-2' } },
                    { op: 'Replace', path: 'members', value: [{ value: 'scim-user-2' }] }
                ]
            }),
            start + 5
        )
        expect(replaced).toMatchObject({ displayName: 'Platform', externalId: 'provider-group-2' })
        expect(replaced.members.map((member) => member.value)).toEqual(['scim-user-2'])

        await deleteGroup(sql, tokenActor, group.id, start + 6)
        expect(await groupsForOrganization(sql.query, sql, 'org-1')).toEqual([])
        await expect(deleteGroup(sql, tokenActor, group.id, start + 7)).rejects.toMatchObject({ status: 404 })
        db.close()
    })

    it('rejects an unknown member without applying earlier operations', async () => {
        const { sql, db } = store()
        const group = await createGroup(sql, tokenActor, { displayName: 'Engineering', members: [{ value: 'scim-user-1' }] }, start)
        await expect(
            mutateGroup(
                sql,
                tokenActor,
                group.id,
                groupPatchChanges({
                    Operations: [
                        { op: 'Remove', path: 'members', value: [{ value: 'scim-user-1' }] },
                        { op: 'Add', path: 'members', value: [{ value: 'unknown' }] }
                    ]
                })
            )
        ).rejects.toMatchObject({ status: 400, scimType: 'invalidValue' })
        expect((await groupsForOrganization(sql.query, sql, 'org-1'))[0].members.map((member) => member.value)).toEqual(['scim-user-1'])
        db.close()
    })
})

describe('SCIM mapping reconciliation', () => {
    it('refuses owner and authentication-settings roles', async () => {
        const { sql, db } = store()
        const group = await createGroup(sql, tokenActor, { displayName: 'Engineering' }, start)
        await expect(
            createMapping(sql, adminActor, { groupId: group.id, workspaceId: 'team-1', roleId: 'role-owner' })
        ).rejects.toMatchObject({
            status: 400
        })
        await expect(
            createMapping(sql, adminActor, { groupId: group.id, workspaceId: 'team-1', roleId: 'role-auth' })
        ).rejects.toMatchObject({
            status: 400
        })
        await expect(
            createMapping(sql, adminActor, { groupId: group.id, workspaceId: 'team-1', roleId: 'role-admin' })
        ).rejects.toMatchObject({
            status: 400
        })
        expect((await mappingOptions(sql, adminActor)).roles).toEqual(
            expect.not.arrayContaining([
                expect.objectContaining({ id: 'role-owner' }),
                expect.objectContaining({ id: 'role-auth' }),
                expect.objectContaining({ id: 'role-admin' })
            ])
        )
        db.close()
    })

    it('adds and removes owned membership, bumps permission version, and leaves a manual membership alone', async () => {
        const { sql, db } = store()
        const group = await createGroup(
            sql,
            tokenActor,
            { displayName: 'Engineering', members: [{ value: 'scim-user-1' }, { value: 'scim-user-2' }, { value: 'scim-user-3' }] },
            start
        )
        const mapping = await createMapping(sql, adminActor, { groupId: group.id, workspaceId: 'team-1', roleId: 'role-viewer' }, start + 1)
        expect(db.prepare('SELECT roleId FROM workspace_user WHERE userId = ?').get('user-1')).toMatchObject({ roleId: 'role-viewer' })
        expect(db.prepare('SELECT roleId FROM workspace_user WHERE userId = ?').get('user-3')).toMatchObject({ roleId: 'role-builder' })
        expect(db.prepare('SELECT permissionVersion FROM user WHERE id = ?').get('user-1')).toMatchObject({ permissionVersion: 1 })
        expect(db.prepare('SELECT COUNT(*) AS count FROM identity_scim_assignment WHERE mappingId = ?').get(mapping.id)).toMatchObject({
            count: 2
        })

        db.prepare('UPDATE workspace_user SET roleId = ? WHERE userId = ?').run('role-builder', 'user-2')
        await mutateGroup(sql, tokenActor, group.id, { displayName: 'Engineering' }, start + 2)
        expect(db.prepare('SELECT roleId FROM workspace_user WHERE userId = ?').get('user-2')).toMatchObject({ roleId: 'role-builder' })
        expect(db.prepare('SELECT COUNT(*) AS count FROM identity_scim_assignment WHERE userId = ?').get('user-2')).toMatchObject({
            count: 0
        })

        await mutateGroup(
            sql,
            tokenActor,
            group.id,
            groupPatchChanges({ Operations: [{ op: 'Remove', path: 'members', value: [{ value: 'scim-user-1' }] }] }),
            start + 3
        )
        expect(db.prepare('SELECT COUNT(*) AS count FROM workspace_user WHERE userId = ?').get('user-1')).toMatchObject({ count: 0 })
        expect(db.prepare('SELECT permissionVersion FROM user WHERE id = ?').get('user-1')).toMatchObject({ permissionVersion: 2 })
        expect(db.prepare('SELECT roleId FROM workspace_user WHERE userId = ?').get('user-2')).toMatchObject({ roleId: 'role-builder' })
        expect(db.prepare('SELECT roleId FROM workspace_user WHERE userId = ?').get('user-3')).toMatchObject({ roleId: 'role-builder' })
        db.close()
    })

    it('fails closed on conflicting roles and records a diagnostic', async () => {
        const { sql, db } = store()
        const first = await createGroup(sql, tokenActor, { displayName: 'First', members: [{ value: 'scim-user-1' }] }, start)
        const second = await createGroup(sql, tokenActor, { displayName: 'Second', members: [{ value: 'scim-user-1' }] }, start + 1)
        await createMapping(sql, adminActor, { groupId: first.id, workspaceId: 'team-1', roleId: 'role-viewer' }, start + 2)
        await createMapping(sql, adminActor, { groupId: second.id, workspaceId: 'team-1', roleId: 'role-builder' }, start + 3)
        expect(db.prepare('SELECT roleId FROM workspace_user WHERE userId = ?').get('user-1')).toMatchObject({ roleId: 'role-viewer' })
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM identity_scim_diagnostic WHERE category = 'mapping_conflict'").get()
        ).toMatchObject({
            count: 1
        })
        db.close()
    })

    it('removes an owned grant when its role later gains authentication settings', async () => {
        const { sql, db } = store()
        const group = await createGroup(sql, tokenActor, { displayName: 'Engineering', members: [{ value: 'scim-user-1' }] }, start)
        await createMapping(sql, adminActor, { groupId: group.id, workspaceId: 'team-1', roleId: 'role-viewer' }, start + 1)
        db.prepare('UPDATE role SET permissions = ? WHERE id = ?').run('["authentication:manage"]', 'role-viewer')
        await mutateGroup(sql, tokenActor, group.id, { displayName: 'Engineering' }, start + 2)
        expect(db.prepare('SELECT COUNT(*) AS count FROM workspace_user WHERE userId = ?').get('user-1')).toMatchObject({ count: 0 })
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM identity_scim_diagnostic WHERE category = 'mapping_role_refused'").get()
        ).toMatchObject({ count: 1 })
        db.close()
    })

    it('requires a current preview fingerprint and group deletion removes owned assignments', async () => {
        const { sql, db } = store()
        const group = await createGroup(sql, tokenActor, { displayName: 'Engineering', members: [{ value: 'scim-user-1' }] }, start)
        const mapping = await createMapping(sql, adminActor, { groupId: group.id, workspaceId: 'team-1', roleId: 'role-viewer' }, start + 1)
        const preview = await previewMappingRemoval(sql, adminActor, mapping.id)
        db.prepare('UPDATE identity_scim_assignment SET roleId = ? WHERE mappingId = ?').run('role-builder', mapping.id)
        await expect(removeMapping(sql, adminActor, mapping.id, preview.fingerprint, start + 2)).rejects.toMatchObject({ status: 409 })
        db.prepare('UPDATE identity_scim_assignment SET roleId = ? WHERE mappingId = ?').run('role-viewer', mapping.id)
        await deleteGroup(sql, tokenActor, group.id, start + 3)
        expect(db.prepare('SELECT COUNT(*) AS count FROM workspace_user WHERE userId = ?').get('user-1')).toMatchObject({ count: 0 })
        expect(db.prepare('SELECT COUNT(*) AS count FROM identity_scim_assignment').get()).toMatchObject({ count: 0 })
        db.close()
    })

    it('removes a mapped assignment while inactive and restores it on reactivation reconciliation', async () => {
        const { sql, db } = store()
        const group = await createGroup(sql, tokenActor, { displayName: 'Engineering', members: [{ value: 'scim-user-1' }] }, start)
        await createMapping(sql, adminActor, { groupId: group.id, workspaceId: 'team-1', roleId: 'role-viewer' }, start + 1)
        db.prepare("UPDATE user SET status = 'disable' WHERE id = 'user-1'").run()
        await mutateGroup(sql, tokenActor, group.id, { displayName: 'Engineering' }, start + 2)
        expect(db.prepare('SELECT COUNT(*) AS count FROM workspace_user WHERE userId = ?').get('user-1')).toMatchObject({ count: 0 })
        db.prepare("UPDATE user SET status = 'active' WHERE id = 'user-1'").run()
        await mutateGroup(sql, tokenActor, group.id, { displayName: 'Engineering' }, start + 3)
        expect(db.prepare('SELECT roleId FROM workspace_user WHERE userId = ?').get('user-1')).toMatchObject({ roleId: 'role-viewer' })
        db.close()
    })
})

describe('SCIM operations diagnostics', () => {
    it('summarizes operations and removes records older than 30 days', async () => {
        const { sql, db } = store()
        await recordScimOperation(sql, {
            organizationId: 'org-1',
            category: 'usersCreated',
            outcome: 'success',
            correlationId: 'correlation-new',
            completedAt: start
        })
        db.prepare('INSERT INTO identity_scim_diagnostic VALUES (?, ?, ?, ?, ?, ?, ?)').run(
            'old',
            'org-1',
            'request',
            'failed',
            'correlation-old',
            'Old error',
            '2026-09-01T00:00:00.000Z'
        )
        await sweepScimDiagnostics(sql, start)
        const operations = await readScimOperations(sql, 'org-1')
        expect(operations).toMatchObject({ counts: { usersCreated: 1 }, retentionDays: 30 })
        expect(JSON.stringify(operations)).not.toContain('correlation-old')
        db.close()
    })
})
