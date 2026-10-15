/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Tests for the permission gate in docs/identity/phase0-spec.md sections 5, 7.3, and 10.
 */
import express, { Request } from 'express'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { requireAnyPermission, requireOwner, requirePermission, setTeamPermissionLookup } from './rbac'
import { TeamAccess, teamAccess } from './sqlStore'

const hits = { n: 0 }

function fakeDb(type: string, rows: Record<string, unknown>[]) {
    const calls: { sql: string; params: unknown[] }[] = []
    const dataSource = {
        options: { type },
        query: async (sql: string, params: unknown[] = []) => {
            calls.push({ sql, params })
            return rows
        }
    }
    return { dataSource: dataSource as unknown as DataSource, calls }
}

function appFor(user: object | null) {
    const app = express()
    app.use((req, _res, next) => {
        if (user) (req as Request).user = user as Express.User
        next()
    })
    const mark = (_req: Request, res: express.Response) => {
        hits.n += 1
        res.json({ ok: true })
    }
    app.get('/need-both', requirePermission('chatflows:view', 'chatflows:update'), mark)
    app.get('/need-one', requireAnyPermission('apikeys:create,apikeys:update'), mark)
    return request(app)
}

describe('teamAccess', () => {
    it('returns no grant when the user has no row', async () => {
        const { dataSource, calls } = fakeDb('sqlite', [])
        await expect(teamAccess(dataSource, 'user-1', 'team-b')).resolves.toEqual({ owner: false, permissions: null })
        expect(calls[0].params).toEqual(['team-b', 'user-1'])
        expect(calls[0].sql).toContain('"workspace_user"')
        expect(calls[0].sql).toContain('"organization_user"')
        expect(calls[0].sql).toContain('"workspace"')
        expect(calls[0].sql).toContain('organizationId')
        expect(calls[0].sql).not.toContain('user-1')
        expect(calls).toHaveLength(1)
    })

    it('reads a JSON permission string when the user, org, and team are active', async () => {
        const { dataSource } = fakeDb('sqlite', [
            {
                userStatus: 'ACTIVE',
                orgStatus: 'active',
                orgRoleName: 'member',
                teamId: 'team-a',
                teamStatus: 'Active',
                permissions: '["chatflows:view"," credentials:view "]'
            }
        ])
        await expect(teamAccess(dataSource, 'user-1', 'team-a')).resolves.toEqual({
            owner: false,
            permissions: ['chatflows:view', 'credentials:view']
        })
    })

    it('allows an invited team, and refuses disable, an unknown status, a non-active user, and a demoted owner role', async () => {
        const inactive = fakeDb('sqlite', [
            {
                userStatus: 'inactive',
                orgStatus: 'active',
                orgRoleName: 'owner',
                teamId: 'team-a',
                teamStatus: 'active',
                permissions: '["chatflows:view"]'
            }
        ])
        await expect(teamAccess(inactive.dataSource, 'user-1', 'team-a')).resolves.toEqual({ owner: false, permissions: null })

        const invited = fakeDb('postgres', [
            {
                userStatus: 'active',
                orgStatus: 'active',
                orgRoleName: 'member',
                teamId: 'team-a',
                teamStatus: 'invited',
                permissions: '["chatflows:view"]'
            }
        ])
        await expect(teamAccess(invited.dataSource, 'user-1', 'team-a')).resolves.toEqual({
            owner: false,
            permissions: ['chatflows:view']
        })
        expect(invited.calls[0].sql).toContain('$1')
        expect(invited.calls[0].sql).toContain('$2')

        const disabled = fakeDb('sqlite', [
            {
                userStatus: 'active',
                orgStatus: 'active',
                orgRoleName: 'member',
                teamId: 'team-a',
                teamStatus: 'disable',
                permissions: '["chatflows:view"]'
            }
        ])
        await expect(teamAccess(disabled.dataSource, 'user-1', 'team-a')).resolves.toEqual({ owner: false, permissions: null })

        const unknown = fakeDb('sqlite', [
            {
                userStatus: 'active',
                orgStatus: 'active',
                orgRoleName: 'member',
                teamId: 'team-a',
                teamStatus: 'nope',
                permissions: '["chatflows:view"]'
            }
        ])
        await expect(teamAccess(unknown.dataSource, 'user-1', 'team-a')).resolves.toEqual({ owner: false, permissions: null })

        const orgDisabled = fakeDb('sqlite', [
            {
                userStatus: 'active',
                orgStatus: 'disable',
                orgRoleName: 'member',
                teamId: 'team-a',
                teamStatus: 'active',
                permissions: '["chatflows:view"]'
            }
        ])
        await expect(teamAccess(orgDisabled.dataSource, 'user-1', 'team-a')).resolves.toEqual({ owner: false, permissions: null })

        const demoted = fakeDb('mysql', [
            {
                userStatus: 'active',
                orgStatus: 'active',
                orgRoleName: 'member',
                teamId: 'team-a',
                teamStatus: 'active',
                permissions: '["credentials:view"]'
            }
        ])
        await expect(teamAccess(demoted.dataSource, 'user-1', 'team-a')).resolves.toEqual({
            owner: false,
            permissions: ['credentials:view']
        })
        expect(demoted.calls[0].sql).toContain('`workspace_user`')
    })

    it('marks an active org owner even when the team membership is missing', async () => {
        const { dataSource } = fakeDb('sqlite', [
            { userStatus: 'active', orgStatus: 'active', orgRoleName: 'owner', teamStatus: null, permissions: null }
        ])
        await expect(teamAccess(dataSource, 'owner', 'team-b')).resolves.toEqual({ owner: true, permissions: null })
    })

    it('does not treat an owner of another organization as owner of this team', async () => {
        const { DatabaseSync } = require('node:sqlite') as {
            DatabaseSync: new (path: string) => {
                exec(sql: string): void
                prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] }
            }
        }
        const db = new DatabaseSync(':memory:')
        db.exec(`
            CREATE TABLE "user" (id text primary key, status text);
            CREATE TABLE "workspace" (id text primary key, name text, "organizationId" text);
            CREATE TABLE "role" (id text primary key, "organizationId" text, name text, permissions text);
            CREATE TABLE "organization_user" (
                "organizationId" text, "userId" text, "roleId" text, status text,
                primary key ("organizationId", "userId")
            );
            CREATE TABLE "workspace_user" (
                "workspaceId" text, "userId" text, "roleId" text, status text,
                primary key ("workspaceId", "userId")
            );
            INSERT INTO "user" (id, status) VALUES ('user-1', 'active');
            INSERT INTO "role" (id, "organizationId", name, permissions) VALUES
                ('role-owner-a', 'org-a', 'owner', '[]'),
                ('role-member-b', 'org-b', 'member', '[]'),
                ('role-team-a', 'org-a', 'admin', '["chatflows:delete"]'),
                ('role-team-b', 'org-b', 'viewer', '["chatflows:view"]');
            INSERT INTO "workspace" (id, name, "organizationId") VALUES
                ('team-a', 'Alpha', 'org-a'),
                ('team-b', 'Beta', 'org-b');
            INSERT INTO "organization_user" ("organizationId", "userId", "roleId", status) VALUES
                ('org-a', 'user-1', 'role-owner-a', 'active'),
                ('org-b', 'user-1', 'role-member-b', 'active');
            INSERT INTO "workspace_user" ("workspaceId", "userId", "roleId", status) VALUES
                ('team-a', 'user-1', 'role-team-a', 'active'),
                ('team-b', 'user-1', 'role-team-b', 'active');
        `)
        const dataSource = {
            options: { type: 'sqlite' },
            query: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params)
        } as unknown as DataSource
        await expect(teamAccess(dataSource, 'user-1', 'team-b')).resolves.toEqual({
            owner: false,
            permissions: ['chatflows:view']
        })
        await expect(teamAccess(dataSource, 'user-1', 'team-a')).resolves.toEqual({
            owner: true,
            permissions: ['chatflows:delete']
        })
        setTeamPermissionLookup({
            accessFor: (userId, workspaceId) => teamAccess(dataSource, userId, workspaceId)
        })
        try {
            const owned = express()
            owned.use((req, _res, next) => {
                ;(req as Request).user = { id: 'user-1', activeWorkspaceId: 'team-b' } as Express.User
                next()
            })
            owned.get('/owned', requireOwner(), (_req, res) => {
                res.json({ ok: true })
            })
            const denied = await request(owned).get('/owned')
            expect(denied.status).toBe(403)
            expect(denied.body).toEqual({ message: 'Forbidden' })

            const home = express()
            home.use((req, _res, next) => {
                ;(req as Request).user = { id: 'user-1', activeWorkspaceId: 'team-a' } as Express.User
                next()
            })
            home.get('/owned', requireOwner(), (_req, res) => {
                res.json({ ok: true })
            })
            expect((await request(home).get('/owned')).status).toBe(200)
        } finally {
            setTeamPermissionLookup(null)
        }
    })
})

describe('requirePermission', () => {
    const memberships = new Map<string, TeamAccess>()

    beforeEach(() => {
        hits.n = 0
        memberships.clear()
        setTeamPermissionLookup({
            async accessFor(userId, workspaceId) {
                return memberships.get(`${userId}|${workspaceId}`) || { owner: false, permissions: null }
            }
        })
    })

    afterEach(() => setTeamPermissionLookup(null))

    it('rejects a comma when the route is defined', () => {
        expect(() => requirePermission('chatflows:view,chatflows:update')).toThrow(/requireAnyPermission/)
    })

    it('requires every permission, leaves the session list alone, and a comma-separated any-of list requires one', async () => {
        memberships.set('user-1|team-a', { owner: false, permissions: ['chatflows:view'] })
        const user = { id: 'user-1', activeWorkspaceId: 'team-a', permissions: ['stale:kept'], isOrganizationAdmin: true }
        expect((await appFor(user).get('/need-both')).status).toBe(403)
        expect(hits.n).toBe(0)
        expect(user.permissions).toEqual(['stale:kept'])
        memberships.set('user-1|team-a', { owner: false, permissions: ['chatflows:view', 'chatflows:update'] })
        const allowed = await appFor(user).get('/need-both')
        expect(allowed.status).toBe(200)
        expect(user.permissions).toEqual(['stale:kept'])
        const key = { permissions: ['apikeys:update'], isOrganizationAdmin: true, activeWorkspaceId: 'team-a' }
        expect((await appFor(key).get('/need-one')).status).toBe(200)
        expect(key.permissions).toEqual(['apikeys:update'])
    })

    it('answers 401 with no user, 403 for a missing team, and 500 when the lookup throws', async () => {
        expect((await appFor(null).get('/need-one')).body).toEqual({ message: 'Unauthorized' })
        const homeless = { id: 'user-1', permissions: ['apikeys:create'], isOrganizationAdmin: false }
        expect((await appFor(homeless).get('/need-one')).status).toBe(403)
        setTeamPermissionLookup({
            async accessFor() {
                throw new Error('database down')
            }
        })
        const user = { id: 'user-1', activeWorkspaceId: 'team-a', permissions: ['apikeys:create'], isOrganizationAdmin: false }
        const failed = await appFor(user).get('/need-one')
        expect(failed.status).toBe(500)
        expect(failed.body).toEqual({ message: 'Permission check failed' })
    })

    it('does not treat a snapshot from another team, or a demoted owner flag, as a grant', async () => {
        memberships.set('user-1|team-a', { owner: false, permissions: ['apikeys:create'] })
        memberships.set('user-1|team-b', { owner: false, permissions: null })
        const user = {
            id: 'user-1',
            activeWorkspaceId: 'team-b',
            permissions: ['apikeys:create', 'apikeys:update'],
            isOrganizationAdmin: true
        }
        const denied = await appFor(user).get('/need-one')
        expect(denied.status).toBe(403)
        expect(denied.body).toEqual({ message: 'Forbidden' })
        expect(user.permissions).toEqual(['apikeys:create', 'apikeys:update'])
        expect(hits.n).toBe(0)
    })

    it('lets a database owner through when the session still says they are not', async () => {
        memberships.set('owner|team-b', { owner: true, permissions: null })
        const user = { id: 'owner', activeWorkspaceId: 'team-b', permissions: [], isOrganizationAdmin: false }
        expect((await appFor(user).get('/need-one')).status).toBe(200)
        expect(user.permissions).toEqual([])
        expect(hits.n).toBe(1)
    })
})
