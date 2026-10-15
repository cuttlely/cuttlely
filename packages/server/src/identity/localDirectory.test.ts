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

import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { builtInPermissionKeys, builtInPermissionJson, permissionsLowered } from './builtInRoles'
import { likeEscapeClause } from './likeEscape'
import { catalogKeys } from './permissionsCatalog'
import {
    DirectoryError,
    Sql,
    createEmailUser,
    createRole,
    deleteOrganizationUser,
    deleteRole,
    deleteWorkspace,
    deleteWorkspaceUser,
    endUserSession,
    endUserSessions,
    getWorkspace,
    listLocalUsers,
    listOrganizationUsers,
    listRoles,
    listUserSessions,
    listWorkspaceMemberships,
    listWorkspaces,
    pageFrom,
    setUserDisabled,
    updateOrganizationUser,
    updateRole,
    updateWorkspace,
    updateWorkspaceUserRole
} from './directory'

const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
        exec(sql: string): void
        close(): void
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

function memorySql(record?: string[]): { sql: Sql; db: InstanceType<typeof DatabaseSync> } {
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
        record?.push(statement)
        const prepared = db.prepare(statement)
        if (/^\s*(select|with)\b/i.test(statement)) return prepared.all(...params)
        prepared.run(...params)
        return []
    }
    let tail: Promise<unknown> = Promise.resolve()
    const sql: Sql = {
        type: 'sqlite',
        query,
        transaction: async (fn) => {
            const run = tail.then(() => fn(query))
            tail = run.then(
                () => undefined,
                () => undefined
            )
            return run
        }
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

    it('counts an owner with no team and keeps a team role off the organization membership', async () => {
        const { sql, db } = memorySql()
        db.exec(`DELETE FROM workspace_user WHERE "userId" = '${OWNER}'`)
        await expect(updateOrganizationUser(sql, owner, { userId: OWNER, organizationId: ORG, status: 'inactive' })).rejects.toMatchObject({
            status: 409,
            message: 'The last owner cannot be removed'
        })
        const created = await createEmailUser(
            sql,
            { ...owner, workspaceId: TEAM },
            {
                user: { name: 'Ada Lovelace', email: 'ada@example.com' },
                workspace: { id: TEAM },
                role: { id: 'role-admin' }
            }
        )
        expect(db.prepare('SELECT "roleId" AS roleId FROM organization_user WHERE "userId" = ?').all(created.id)).toEqual([
            { roleId: 'role-member' }
        ])
        expect(db.prepare('SELECT "roleId" AS roleId FROM workspace_user WHERE "userId" = ?').all(created.id)).toEqual([
            { roleId: 'role-admin' }
        ])
        await updateWorkspaceUserRole(sql, owner, { userId: 'member-1', workspaceId: TEAM, roleId: 'role-viewer' })
        expect(db.prepare('SELECT "roleId" AS roleId FROM organization_user WHERE "userId" = ?').all('member-1')).toEqual([
            { roleId: 'role-member' }
        ])
        expect(
            db.prepare('SELECT "roleId" AS roleId FROM workspace_user WHERE "userId" = ? AND "workspaceId" = ?').all('member-1', TEAM)
        ).toEqual([{ roleId: 'role-viewer' }])
    })

    it('refuses a non-owner invite, disable, or delete in another team', async () => {
        const { sql, db } = memorySql()
        db.exec(`
            INSERT INTO "user" (id, name, email, status, permissionVersion) VALUES ('only-b', 'Only', 'only-b@example.com', 'active', 0);
            INSERT INTO organization_user ("organizationId", "userId", "roleId", status) VALUES ('${ORG}', 'only-b', 'role-viewer', 'active');
            INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES ('${TEAM_B}', 'only-b', 'role-viewer', 'active');
        `)
        await expect(
            createEmailUser(sql, admin, {
                user: { name: 'New Person', email: 'new-person@example.com' },
                workspace: { id: TEAM_B },
                role: { id: 'role-viewer' }
            })
        ).rejects.toMatchObject({ status: 404, message: 'Team not found' })
        expect(db.prepare('SELECT id FROM "user" WHERE email = ?').all('new-person@example.com')).toEqual([])
        await expect(
            updateOrganizationUser(sql, admin, { userId: 'only-b', organizationId: ORG, status: 'inactive' })
        ).rejects.toMatchObject({
            status: 404,
            message: 'User not found'
        })
        await expect(deleteOrganizationUser(sql, admin, ORG, 'only-b')).rejects.toMatchObject({ status: 404, message: 'User not found' })
        await expect(deleteOrganizationUser(sql, admin, ORG, 'member-1')).rejects.toMatchObject({
            status: 403,
            message: 'Only an owner can remove someone from every team'
        })
        await deleteOrganizationUser(sql, owner, ORG, 'member-1')
        expect(db.prepare('SELECT "userId" AS userId FROM organization_user WHERE "userId" = ?').all('member-1')).toEqual([])
    })

    it('limits team list, open, and edit to the active team for a non-owner', async () => {
        const { sql } = memorySql()
        const listed = await listWorkspaces(sql, admin, ORG)
        expect(listed.map((team) => team.id)).toEqual([TEAM])
        await expect(getWorkspace(sql, admin, TEAM_B)).rejects.toMatchObject({ status: 404, message: 'Team not found' })
        await expect(updateWorkspace(sql, admin, { id: TEAM_B, name: 'Other Name' })).rejects.toMatchObject({ status: 404 })
        await expect(deleteWorkspace(sql, admin, TEAM_B)).rejects.toMatchObject({ status: 404 })
        const ownerTeams = await listWorkspaces(sql, owner, ORG)
        expect(ownerTeams.map((team) => team.id).sort()).toEqual([TEAM, TEAM_B].sort())
    })

    it('refuses to delete the team that is the last owner only team', async () => {
        const { sql, db } = memorySql()
        db.exec(`
            INSERT INTO workspace (id, name, "organizationId") VALUES ('team-solo', 'Field', '${ORG}');
            DELETE FROM workspace_user WHERE "userId" = '${OWNER}';
            INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES ('team-solo', '${OWNER}', 'role-owner', 'active');
        `)
        await expect(deleteWorkspace(sql, owner, 'team-solo')).rejects.toMatchObject({
            status: 409,
            message: 'The last owner cannot be removed'
        })
        expect(db.prepare('SELECT id FROM workspace WHERE id = ?').all('team-solo')).toEqual([{ id: 'team-solo' }])
        db.exec(
            `INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES ('${TEAM}', '${OWNER}', 'role-owner', 'active')`
        )
        await deleteWorkspace(sql, owner, 'team-solo')
        expect(db.prepare('SELECT id FROM workspace WHERE id = ?').all('team-solo')).toEqual([])
        expect(db.prepare('SELECT "roleId" AS roleId FROM organization_user WHERE "userId" = ?').all(OWNER)).toEqual([
            { roleId: 'role-owner' }
        ])
    })

    it('matches percent and underscore in search as those characters', async () => {
        const { sql, db } = memorySql()
        db.exec(`
            INSERT INTO "user" (id, name, email, status, permissionVersion) VALUES
                ('user-under', 'A_B Person', 'a_b@example.com', 'active', 0),
                ('user-x', 'AXB Person', 'axb@example.com', 'active', 0),
                ('user-pct', 'Percent Person', 'percent@example.com', 'active', 0);
            INSERT INTO organization_user ("organizationId", "userId", "roleId", status) VALUES
                ('${ORG}', 'user-under', 'role-member', 'active'),
                ('${ORG}', 'user-x', 'role-member', 'active'),
                ('${ORG}', 'user-pct', 'role-member', 'active');
            INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES
                ('${TEAM}', 'user-under', 'role-member', 'active'),
                ('${TEAM}', 'user-x', 'role-member', 'active'),
                ('${TEAM}', 'user-pct', 'role-member', 'active');
        `)
        const under = await listLocalUsers(sql, admin, pageFrom({ q: 'a_b' }))
        expect(under.users.map((user) => user.email)).toEqual(['a_b@example.com'])
        const percent = await listLocalUsers(sql, admin, pageFrom({ q: '%' }))
        expect(percent.users).toEqual([])
    })

    it('uses a doubled LIKE escape on MySQL and MariaDB', async () => {
        expect(likeEscapeClause('mysql')).toBe("ESCAPE '\\\\'")
        expect(likeEscapeClause('mariadb')).toBe("ESCAPE '\\\\'")
        expect(likeEscapeClause('sqlite')).toBe("ESCAPE '\\'")
        expect(likeEscapeClause('postgres')).toBe("ESCAPE '\\'")
        const statements: string[] = []
        const sql: Sql = {
            type: 'mysql',
            query: async (statement) => {
                statements.push(statement)
                if (/count\(\*\)/i.test(statement)) return [{ count: 0 }]
                if (/FROM `workspace`/i.test(statement)) return [{ id: TEAM, name: 'Default Workspace', organizationId: ORG }]
                return []
            },
            transaction: async (fn) => fn(async (statement, params) => sql.query(statement, params))
        }
        await listLocalUsers(sql, admin, pageFrom({ q: 'a_b' }))
        const search = statements.find((statement) => statement.includes('LIKE')) || ''
        expect(search).toContain("ESCAPE '\\\\'")
        expect(search.includes("ESCAPE '\\'")).toBe(false)
    })

    it('reads the owner count before a plain organization write', async () => {
        const statements: string[] = []
        const { sql, db } = memorySql(statements)
        db.exec(`
            INSERT INTO "user" (id, name, email, status, permissionVersion) VALUES ('owner-2', 'Second', 'second@example.com', 'active', 0);
            INSERT INTO organization_user ("organizationId", "userId", "roleId", status) VALUES ('${ORG}', 'owner-2', 'role-owner', 'active');
            INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES ('${TEAM}', 'owner-2', 'role-owner', 'active');
        `)
        statements.length = 0
        await setUserDisabled(sql, owner, 'owner-2', true)
        const disable = statements.find((statement) => /UPDATE\s+"organization_user"\s+SET\s+"status"/i.test(statement)) || ''
        expect(disable).not.toMatch(/SELECT/i)
        expect(statements.findIndex((statement) => /LOWER\(r\."name"\) = 'owner'/i.test(statement))).toBeGreaterThan(-1)
        expect(statements.findIndex((statement) => /LOWER\(r\."name"\) = 'owner'/i.test(statement))).toBeLessThan(
            statements.indexOf(disable)
        )

        statements.length = 0
        await updateWorkspaceUserRole(sql, owner, { userId: 'owner-2', workspaceId: TEAM, roleId: 'role-admin' })
        const demote = statements.find((statement) => /UPDATE\s+"organization_user"\s+SET\s+"roleId"/i.test(statement)) || ''
        expect(demote).not.toMatch(/SELECT/i)
        expect(db.prepare('SELECT "roleId" AS roleId FROM organization_user WHERE "userId" = ?').all('owner-2')).toEqual([
            { roleId: 'role-member' }
        ])

        statements.length = 0
        await deleteOrganizationUser(sql, owner, ORG, 'owner-2')
        const removed = statements.find((statement) => /DELETE FROM "organization_user"/i.test(statement)) || ''
        expect(removed).not.toMatch(/SELECT/i)
        expect(db.prepare('SELECT "userId" AS userId FROM organization_user WHERE "userId" = ?').all('owner-2')).toEqual([])
    })

    it('counts a role on the active team and still refuses a delete while another team has it', async () => {
        const { sql, db } = memorySql()
        db.exec(`
            INSERT INTO role (id, "organizationId", name, description, permissions) VALUES
                ('role-field', '${ORG}', 'Field', 'field', '["chatflows:view"]');
            INSERT INTO "user" (id, name, email, status, permissionVersion) VALUES ('field-b', 'Field', 'field-b@example.com', 'active', 0);
            INSERT INTO organization_user ("organizationId", "userId", "roleId", status) VALUES ('${ORG}', 'field-b', 'role-member', 'active');
            INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES ('${TEAM_B}', 'field-b', 'role-field', 'active');
        `)
        const onActive = await listRoles(sql, admin, ORG)
        expect(onActive.find((role) => role.id === 'role-field')?.userCount).toBe(0)
        expect(onActive.find((role) => role.name === 'viewer')?.userCount).toBe(1)
        const onOther = await listRoles(sql, { ...owner, workspaceId: TEAM_B }, ORG)
        expect(onOther.find((role) => role.id === 'role-field')?.userCount).toBe(1)
        expect(onOther.find((role) => role.name === 'viewer')?.userCount).toBe(1)
        await expect(deleteRole(sql, owner, 'role-field', ORG)).rejects.toMatchObject({
            status: 400,
            message: 'Remove users with this role first'
        })
    })

    it('counts roles only on teams the caller shares', async () => {
        const { sql, db } = memorySql()
        const asAdmin = await listOrganizationUsers(sql, admin, ORG)
        expect(asAdmin.find((row) => row.userId === 'viewer-1')?.roleCount).toBe(1)
        db.exec(
            `INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES ('${TEAM_B}', '${OWNER}', 'role-owner', 'active')`
        )
        const asOwner = await listOrganizationUsers(sql, owner, ORG)
        expect(asOwner.find((row) => row.userId === 'viewer-1')?.roleCount).toBe(2)
    })

    it('lets only one of two connections remove the last owner from their two teams', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'owner-race-'))
        const file = join(dir, 'race.sqlite')
        const setup = new DatabaseSync(file)
        setup.exec(`
            PRAGMA busy_timeout = 8000;
            CREATE TABLE "user" (
                id text primary key, name text, email text, status text, permissionVersion integer not null default 0,
                "updatedDate" text
            );
            CREATE TABLE role (id text primary key, "organizationId" text, name text, permissions text, description text);
            CREATE TABLE workspace (id text primary key, name text, "organizationId" text, description text, "updatedDate" text);
            CREATE TABLE organization_user (
                "organizationId" text, "userId" text, "roleId" text, status text, "updatedDate" text,
                primary key ("organizationId", "userId")
            );
            CREATE TABLE workspace_user (
                "workspaceId" text, "userId" text, "roleId" text, status text, "updatedBy" text, "updatedDate" text,
                primary key ("workspaceId", "userId")
            );
            CREATE TABLE identity_local_session (
                id text primary key, userId text, token text, expiresAt text, absoluteExpiresAt text,
                createdDate text, permissionVersion integer not null default 0
            );
            INSERT INTO "user" (id, name, email, status) VALUES ('${OWNER}', 'Owner', 'owner@example.com', 'active');
            INSERT INTO role (id, name, permissions) VALUES ('role-owner', 'owner', '[]'), ('role-member', 'member', '[]');
            INSERT INTO workspace (id, name, "organizationId") VALUES ('${TEAM}', 'Default Workspace', '${ORG}'), ('${TEAM_B}', 'Other', '${ORG}');
            INSERT INTO organization_user ("organizationId", "userId", "roleId", status) VALUES ('${ORG}', '${OWNER}', 'role-owner', 'active');
            INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES
                ('${TEAM}', '${OWNER}', 'role-owner', 'active'),
                ('${TEAM_B}', '${OWNER}', 'role-owner', 'active');
        `)
        setup.close()
        const run = (workspaceId: string) =>
            new Promise<{ ok: boolean; status?: number; message?: string }>((resolve, reject) => {
                const worker = new Worker(
                    `
                    const { workerData, parentPort } = require('worker_threads')
                    require('ts-node').register({
                        transpileOnly: true,
                        compilerOptions: { module: 'commonjs', esModuleInterop: true, experimentalDecorators: true, strict: false }
                    })
                    const { DatabaseSync } = require('node:sqlite')
                    const { deleteWorkspaceUser } = require(workerData.entry)
                    const db = new DatabaseSync(workerData.file)
                    db.exec('PRAGMA busy_timeout = 8000')
                    const query = async (statement, params = []) => {
                        const prepared = db.prepare(statement)
                        if (/^\\s*(select|with)\\b/i.test(statement)) return prepared.all(...params)
                        prepared.run(...params)
                        return []
                    }
                    const sql = {
                        type: 'sqlite',
                        query,
                        transaction: async (fn) => {
                            db.exec('BEGIN IMMEDIATE')
                            try {
                                const result = await fn(query)
                                db.exec('COMMIT')
                                return result
                            } catch (error) {
                                try { db.exec('ROLLBACK') } catch (rollbackError) { /* already closed */ }
                                throw error
                            }
                        }
                    }
                    deleteWorkspaceUser(sql, workerData.actor, workerData.workspaceId, workerData.userId)
                        .then(() => parentPort.postMessage({ ok: true }))
                        .catch((error) => parentPort.postMessage({ ok: false, status: error.status, message: error.message }))
                    `,
                    {
                        eval: true,
                        workerData: {
                            file,
                            entry: join(__dirname, 'directory.ts'),
                            workspaceId,
                            userId: OWNER,
                            actor: { id: OWNER, organizationId: ORG, workspaceId: TEAM }
                        }
                    }
                )
                worker.on('message', resolve)
                worker.on('error', reject)
            })
        const [first, second] = await Promise.all([run(TEAM), run(TEAM_B)])
        const ok = [first, second].filter((item) => item.ok)
        const denied = [first, second].filter((item) => !item.ok && item.status === 409)
        expect(ok).toHaveLength(1)
        expect(denied).toHaveLength(1)
        const check = new DatabaseSync(file)
        const left = check.prepare('SELECT "workspaceId" AS workspaceId FROM workspace_user').all()
        const stillOwner = check.prepare('SELECT "roleId" AS roleId FROM organization_user').all()
        check.close()
        expect(left).toHaveLength(1)
        expect(stillOwner).toEqual([{ roleId: 'role-owner' }])
    })
})
