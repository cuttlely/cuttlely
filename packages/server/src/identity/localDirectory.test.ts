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

import { builtInPermissionKeys, builtInPermissionJson, permissionsLowered } from './builtInRoles'
import { catalogKeys } from './permissionsCatalog'
import {
    DirectoryError,
    Sql,
    createRole,
    deleteOrganizationUser,
    deleteRole,
    deleteWorkspaceUser,
    endUserSession,
    endUserSessions,
    listLocalUsers,
    listUserSessions,
    listWorkspaceMemberships,
    pageFrom,
    setUserDisabled,
    updateRole,
    updateWorkspaceUserRole
} from './directory'

const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
        exec(sql: string): void
        prepare(sql: string): {
            all(...params: unknown[]): Record<string, unknown>[]
            run(...params: unknown[]): { changes: number }
        }
    }
}

const ORG = 'org-1'
const OWNER = 'owner-1'
const ADMIN = 'admin-user'
const TEAM = 'team-1'
const TEAM_B = 'team-2'

function memorySql(): { sql: Sql; db: InstanceType<typeof DatabaseSync> } {
    const db = new DatabaseSync(':memory:')
    const adminPermissions = builtInPermissionJson('admin')
    const builderPermissions = builtInPermissionJson('builder')
    const viewerPermissions = builtInPermissionJson('viewer')
    db.exec(`
        CREATE TABLE "user" (
            id text primary key, name text, email text unique, credential text, status text,
            "externalId" text, "createdBy" text, "updatedBy" text, "createdDate" text, "updatedDate" text,
            permissionVersion integer not null default 0
        );
        CREATE TABLE organization (id text primary key, name text);
        CREATE TABLE role (
            id text primary key, "organizationId" text, name text, description text, permissions text,
            "createdBy" text, "updatedBy" text, "updatedDate" text
        );
        CREATE TABLE workspace (
            id text primary key, name text, description text, "organizationId" text,
            "createdBy" text, "updatedBy" text, "updatedDate" text
        );
        CREATE TABLE organization_user (
            "organizationId" text, "userId" text, "roleId" text, status text,
            "createdBy" text, "updatedBy" text, "updatedDate" text,
            primary key ("organizationId", "userId")
        );
        CREATE TABLE workspace_user (
            "workspaceId" text, "userId" text, "roleId" text, status text, "lastLogin" text,
            "createdBy" text, "updatedBy" text, "updatedDate" text, primary key ("workspaceId", "userId")
        );
        CREATE TABLE identity_local_session (
            id text primary key, userId text, token text, expiresAt text, absoluteExpiresAt text,
            createdDate text, permissionVersion integer not null default 0
        );
        INSERT INTO organization (id, name) VALUES ('${ORG}', 'Cuttlely');
        INSERT INTO "user" (id, name, email, status, permissionVersion) VALUES
            ('${OWNER}', 'Owner', 'owner@example.com', 'active', 0),
            ('${ADMIN}', 'Admin', 'admin@example.com', 'active', 0),
            ('member-1', 'Member', 'member@example.com', 'active', 0),
            ('viewer-1', 'Viewer', 'viewer@example.com', 'active', 0);
        INSERT INTO role (id, "organizationId", name, description, permissions) VALUES
            ('role-owner', '${ORG}', 'owner', 'owner', '[]'),
            ('role-admin', NULL, 'admin', 'admin', '${adminPermissions}'),
            ('role-builder', NULL, 'builder', 'builder', '${builderPermissions}'),
            ('role-viewer', NULL, 'viewer', 'viewer', '${viewerPermissions}'),
            ('role-member', NULL, 'member', 'member', '[]');
        INSERT INTO workspace (id, name, "organizationId") VALUES
            ('${TEAM}', 'Default Workspace', '${ORG}'),
            ('${TEAM_B}', 'Other', '${ORG}');
        INSERT INTO organization_user ("organizationId", "userId", "roleId", status) VALUES
            ('${ORG}', '${OWNER}', 'role-owner', 'active'),
            ('${ORG}', '${ADMIN}', 'role-admin', 'active'),
            ('${ORG}', 'member-1', 'role-member', 'active'),
            ('${ORG}', 'viewer-1', 'role-viewer', 'active');
        INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES
            ('${TEAM}', '${OWNER}', 'role-owner', 'active'),
            ('${TEAM}', '${ADMIN}', 'role-admin', 'active'),
            ('${TEAM}', 'member-1', 'role-member', 'active'),
            ('${TEAM}', 'viewer-1', 'role-viewer', 'active'),
            ('${TEAM_B}', 'viewer-1', 'role-viewer', 'active');
    `)
    const query = async (statement: string, params: unknown[] = []) => {
        const prepared = db.prepare(statement)
        if (/^\s*(select|with)\b/i.test(statement)) return prepared.all(...params)
        prepared.run(...params)
        return []
    }
    const sql: Sql = {
        type: 'sqlite',
        query,
        transaction: async (fn) => fn(query)
    }
    return { sql, db }
}

const owner = { id: OWNER, organizationId: ORG, workspaceId: TEAM }
const admin = { id: ADMIN, organizationId: ORG, workspaceId: TEAM }

describe('built-in role permission matrix', () => {
    it('gives Owner and Admin the catalog, Builder a build set, and Viewer view keys', () => {
        const catalog = catalogKeys()
        const ownerKeys = builtInPermissionKeys('owner') || []
        const adminKeys = builtInPermissionKeys('admin') || []
        const builderKeys = builtInPermissionKeys('builder') || []
        const viewerKeys = builtInPermissionKeys('viewer') || []
        expect(ownerKeys).toEqual([...catalog].sort())
        expect(adminKeys).toEqual(ownerKeys)
        expect(adminKeys).toEqual(
            expect.arrayContaining(['users:manage', 'roles:manage', 'workspace:delete', 'logs:view', 'chatflows:delete'])
        )
        expect(builderKeys).toEqual(expect.arrayContaining(['chatflows:view', 'chatflows:create', 'chatflows:update', 'chatflows:delete']))
        expect(builderKeys).not.toEqual(expect.arrayContaining(['users:manage', 'roles:manage', 'workspace:create', 'logs:view']))
        expect(viewerKeys.every((key) => key.endsWith(':view'))).toBe(true)
        expect(viewerKeys).toContain('chatflows:view')
        expect(viewerKeys).not.toContain('chatflows:create')
        expect(viewerKeys).not.toContain('logs:view')
        for (const key of [...ownerKeys, ...builderKeys, ...viewerKeys]) expect(catalog).toContain(key)
        expect(permissionsLowered(['chatflows:view', 'chatflows:update'], ['chatflows:view'], false)).toBe(true)
        expect(permissionsLowered(['chatflows:view'], ['chatflows:view', 'chatflows:update'], false)).toBe(false)
        expect(permissionsLowered(['chatflows:view'], ['chatflows:view'], true)).toBe(true)
    })
})

describe('local directory rules', () => {
    it('rejects edits to built-in roles and a grant the caller does not hold', async () => {
        const { sql } = memorySql()
        await expect(updateRole(sql, admin, { id: 'role-admin', name: 'Admin2', permissions: '["chatflows:view"]' })).rejects.toMatchObject(
            {
                status: 403,
                message: 'Built-in roles cannot be changed'
            }
        )
        await expect(deleteRole(sql, admin, 'role-viewer', ORG)).rejects.toMatchObject({ status: 403 })
        await expect(updateRole(sql, admin, { id: 'role-owner', name: 'Owner2', permissions: '["chatflows:view"]' })).rejects.toMatchObject(
            {
                status: 403
            }
        )
        await expect(
            createRole(sql, admin, { name: 'admin', organizationId: ORG, permissions: '["chatflows:view"]' })
        ).rejects.toMatchObject({ status: 400 })
        const viewer = { id: 'viewer-1', organizationId: ORG, workspaceId: TEAM }
        await expect(
            createRole(sql, viewer, { name: 'Wide', organizationId: ORG, permissions: JSON.stringify(['users:manage']) })
        ).rejects.toMatchObject({ status: 403, message: 'You cannot grant a permission you do not have' })
        await expect(
            updateWorkspaceUserRole(sql, admin, { userId: 'member-1', workspaceId: TEAM, roleId: 'role-owner' })
        ).rejects.toMatchObject({
            status: 403,
            message: 'Only an owner can assign the owner role'
        })
    })

    it('refuses to disable, delete, unlink, or demote the last owner, including themselves', async () => {
        const { sql, db } = memorySql()
        await expect(setUserDisabled(sql, owner, OWNER, true)).rejects.toMatchObject({
            status: 409,
            message: 'The last owner cannot be removed'
        })
        await expect(setUserDisabled(sql, owner, owner.id, true)).rejects.toMatchObject({ status: 409 })
        await expect(deleteOrganizationUser(sql, owner, ORG, OWNER)).rejects.toMatchObject({ status: 409 })
        await expect(deleteWorkspaceUser(sql, owner, TEAM, OWNER)).rejects.toMatchObject({ status: 409 })
        await expect(updateWorkspaceUserRole(sql, owner, { userId: OWNER, workspaceId: TEAM, roleId: 'role-admin' })).rejects.toMatchObject(
            {
                status: 409
            }
        )
        expect(db.prepare('SELECT status FROM organization_user WHERE "userId" = ?').all(OWNER)).toEqual([{ status: 'active' }])
    })

    it('lets one of two overlapping owner disables succeed', async () => {
        const { sql, db } = memorySql()
        db.exec(`
            INSERT INTO "user" (id, name, email, status, permissionVersion) VALUES ('owner-2', 'Second', 'second@example.com', 'active', 0);
            INSERT INTO organization_user ("organizationId", "userId", "roleId", status) VALUES ('${ORG}', 'owner-2', 'role-owner', 'active');
            INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES ('${TEAM}', 'owner-2', 'role-owner', 'active');
        `)
        const results = await Promise.allSettled([setUserDisabled(sql, owner, OWNER, true), setUserDisabled(sql, owner, 'owner-2', true)])
        const ok = results.filter((item) => item.status === 'fulfilled')
        const denied = results.filter((item) => item.status === 'rejected' && (item.reason as DirectoryError).status === 409)
        expect(ok).toHaveLength(1)
        expect(denied).toHaveLength(1)
        const active = db
            .prepare(`SELECT "userId" AS userId FROM organization_user WHERE LOWER(status) = 'active' AND "roleId" = 'role-owner'`)
            .all()
        expect(active).toHaveLength(1)
    })

    it('disables a member, ends sessions, bumps the version, and is idempotent', async () => {
        const { sql, db } = memorySql()
        db.exec(`
            INSERT INTO identity_local_session (id, userId, token, expiresAt, absoluteExpiresAt, createdDate, permissionVersion)
            VALUES ('sess-1', 'member-1', 'digest-secret', '2099-01-01', '2099-01-08', '2026-10-01', 0);
        `)
        const first = await setUserDisabled(sql, admin, 'member-1', true)
        expect(first).toEqual({ id: 'member-1', disabled: true })
        expect(db.prepare('SELECT id, token FROM identity_local_session').all()).toEqual([])
        expect(db.prepare('SELECT permissionVersion, status FROM "user" WHERE id = ?').all('member-1')).toEqual([
            { permissionVersion: 1, status: 'disable' }
        ])
        const again = await setUserDisabled(sql, admin, 'member-1', true)
        expect(again.disabled).toBe(true)
        await setUserDisabled(sql, admin, 'member-1', false)
        expect(db.prepare('SELECT status FROM organization_user WHERE "userId" = ?').all('member-1')).toEqual([{ status: 'active' }])
        expect(db.prepare('SELECT status FROM "user" WHERE id = ?').all('member-1')).toEqual([{ status: 'active' }])
    })

    it('ends sessions when a role is lowered and hides session secrets', async () => {
        const { sql, db } = memorySql()
        db.exec(`
            UPDATE workspace_user SET "roleId" = 'role-builder' WHERE "userId" = 'member-1';
            UPDATE organization_user SET "roleId" = 'role-builder' WHERE "userId" = 'member-1';
        `)
        db.exec(`
            INSERT INTO identity_local_session (id, userId, token, expiresAt, absoluteExpiresAt, createdDate, permissionVersion)
            VALUES ('sess-9', 'member-1', 'digest-secret', '2099-01-01', '2099-01-08', '2026-10-01', 0);
        `)
        await updateWorkspaceUserRole(sql, admin, { userId: 'member-1', workspaceId: TEAM, roleId: 'role-viewer' })
        expect(db.prepare('SELECT id FROM identity_local_session WHERE userId = ?').all('member-1')).toEqual([])
        expect(db.prepare('SELECT permissionVersion FROM "user" WHERE id = ?').all('member-1')).toEqual([{ permissionVersion: 1 }])
        db.exec(`
            INSERT INTO identity_local_session (id, userId, token, expiresAt, absoluteExpiresAt, createdDate, permissionVersion)
            VALUES ('sess-2', 'viewer-1', 'another-digest', '2099-01-01', '2099-01-08', '2026-10-02', 0);
        `)
        const listed = await listUserSessions(sql, admin, 'viewer-1', pageFrom({}))
        expect(listed.total).toBe(1)
        expect(listed.sessions[0]).toEqual({
            id: 'sess-2',
            createdAt: '2026-10-02T00:00:00.000Z',
            idleExpiresAt: '2099-01-01T00:00:00.000Z',
            absoluteExpiresAt: '2099-01-08T00:00:00.000Z'
        })
        expect(JSON.stringify(listed)).not.toContain('another-digest')
        expect(JSON.stringify(listed)).not.toContain('token')
        await endUserSession(sql, admin, 'viewer-1', 'missing')
            .then(() => {
                throw new Error('expected 404')
            })
            .catch((error: unknown) => {
                expect(error).toMatchObject({ status: 404, message: 'Session not found' })
            })
        await endUserSession(sql, admin, 'viewer-1', 'sess-2')
        expect(await endUserSessions(sql, admin, 'viewer-1')).toEqual({ ended: 0 })
    })

    it('does not let an admin read another workspace', async () => {
        const { sql, db } = memorySql()
        db.exec(`
            INSERT INTO "user" (id, name, email, status, permissionVersion) VALUES ('only-b', 'Only', 'only@example.com', 'active', 0);
            INSERT INTO organization_user ("organizationId", "userId", "roleId", status) VALUES ('${ORG}', 'only-b', 'role-viewer', 'active');
            INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES ('${TEAM_B}', 'only-b', 'role-viewer', 'active');
        `)
        await expect(listWorkspaceMemberships(sql, admin, { workspaceId: TEAM_B })).rejects.toMatchObject({
            status: 404,
            message: 'Team not found'
        })
        await expect(setUserDisabled(sql, admin, 'only-b', true)).rejects.toMatchObject({ status: 404, message: 'User not found' })
        const listed = await listLocalUsers(sql, owner, pageFrom({ q: 'member', limit: 10, offset: 0 }))
        expect(listed.users.map((user) => user.email)).toEqual(['member@example.com'])
        const otherTeam = await listLocalUsers(sql, { ...owner, workspaceId: TEAM_B }, pageFrom({}))
        expect(otherTeam.users.map((user) => user.email)).toContain('only@example.com')
    })

    it('rejects a bad page and a bad role id shape through status codes', async () => {
        expect(() => pageFrom({ limit: 500 })).toThrow(expect.objectContaining({ status: 400, message: 'limit must be from 1 to 100' }))
        expect(() => pageFrom({ offset: -1 })).toThrow(expect.objectContaining({ status: 400 }))
        expect(() => pageFrom({ sort: 'token' })).toThrow(expect.objectContaining({ status: 400 }))
        const { sql } = memorySql()
        await expect(
            updateWorkspaceUserRole(sql, admin, { userId: 'member-1', workspaceId: TEAM, roleId: 'missing-role' })
        ).rejects.toMatchObject({
            status: 400
        })
        await expect(setUserDisabled(sql, admin, 'nobody', true)).rejects.toMatchObject({ status: 404 })
    })
})
