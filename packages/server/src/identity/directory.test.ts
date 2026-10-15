/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Tests for email-only user create and team membership.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import {
    DirectoryError,
    Sql,
    createEmailUser,
    createRole,
    deleteOrganizationUser,
    listOrganizationUsers,
    switchWorkspace,
    updateOrganizationUser
} from './directory'
import { catalogKeys } from './permissionsCatalog'
import { signInOptionsBody } from './signInOptions'
import { IdentityStore } from './store'
import { SessionUser } from './types'

const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
        exec(sql: string): void
        prepare(sql: string): {
            all(...params: unknown[]): Record<string, unknown>[]
            run(...params: unknown[]): unknown
        }
    }
}

const ORG = 'org-1'
const OWNER = 'owner-1'
const TEAM = 'team-1'
const ROLE = 'role-member'

function memorySql(): { sql: Sql; db: InstanceType<typeof DatabaseSync> } {
    const db = new DatabaseSync(':memory:')
    db.exec(`
        CREATE TABLE "user" (
            id text primary key, name text, email text unique, credential text, status text,
            "externalId" text, "createdBy" text, "updatedBy" text, "createdDate" text, "updatedDate" text
        );
        CREATE TABLE organization (id text primary key, name text);
        CREATE TABLE role (
            id text primary key, "organizationId" text, name text, description text, permissions text,
            "createdBy" text, "updatedBy" text
        );
        CREATE TABLE workspace (
            id text primary key, name text, description text, "organizationId" text,
            "createdBy" text, "updatedBy" text, "updatedDate" text
        );
        CREATE TABLE organization_user (
            "organizationId" text, "userId" text, "roleId" text, status text, "createdBy" text, "updatedBy" text,
            "updatedDate" text,
            primary key ("organizationId", "userId")
        );
        CREATE TABLE workspace_user (
            "workspaceId" text, "userId" text, "roleId" text, status text, "lastLogin" text,
            "createdBy" text, "updatedBy" text, primary key ("workspaceId", "userId")
        );
        CREATE TABLE chat_flow (id text, "workspaceId" text);
        INSERT INTO organization (id, name) VALUES ('${ORG}', 'Cuttlely');
        INSERT INTO "user" (id, name, email, credential, status, "createdBy", "updatedBy")
            VALUES ('${OWNER}', 'Owner', 'owner@example.com', 'hash', 'active', '${OWNER}', '${OWNER}');
        INSERT INTO role (id, "organizationId", name, permissions) VALUES ('${ROLE}', NULL, 'member', '[]');
        INSERT INTO role (id, "organizationId", name, permissions) VALUES ('role-owner', '${ORG}', 'owner', '[]');
        INSERT INTO workspace (id, name, "organizationId", "createdBy", "updatedBy")
            VALUES ('${TEAM}', 'Default Workspace', '${ORG}', '${OWNER}', '${OWNER}');
        INSERT INTO organization_user ("organizationId", "userId", "roleId", status, "createdBy", "updatedBy")
            VALUES ('${ORG}', '${OWNER}', 'role-owner', 'active', '${OWNER}', '${OWNER}');
        INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status, "createdBy", "updatedBy")
            VALUES ('${TEAM}', '${OWNER}', '${ROLE}', 'active', '${OWNER}', '${OWNER}');
        CREATE TABLE identity_local_session (
            id text primary key, userId text, token text, expiresAt text, absoluteExpiresAt text
        );
    `)
    const query = async (statement: string, params: unknown[] = []) => {
        const prepared = db.prepare(statement)
        if (/^\s*select/i.test(statement)) return prepared.all(...params)
        prepared.run(...params)
        return []
    }
    const sql: Sql = {
        type: 'sqlite',
        query,
        transaction: async (fn) => {
            db.exec('BEGIN')
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

const actor = { id: OWNER, organizationId: ORG, workspaceId: TEAM }

describe('directory users', () => {
    it('creates an active email-only user and does not store a password', async () => {
        const { sql, db } = memorySql()
        const created = await createEmailUser(sql, actor, {
            user: { name: 'Ada Lovelace', email: 'ada@example.com', credential: 'Throwaway-1!' },
            workspace: { id: TEAM },
            role: { id: ROLE }
        })
        const rows = db.prepare('SELECT email, status, credential FROM "user" WHERE id = ?').all(created.id)
        expect(rows).toEqual([{ email: 'ada@example.com', status: 'active', credential: null }])
        const org = db.prepare('SELECT status FROM organization_user WHERE "userId" = ?').all(created.id)
        const team = db.prepare('SELECT status FROM workspace_user WHERE "userId" = ?').all(created.id)
        expect(org).toEqual([{ status: 'active' }])
        expect(team).toEqual([{ status: 'active' }])
        const listed = await listOrganizationUsers(sql, actor, ORG)
        expect(listed.find((row) => row.user.email === 'ada@example.com')).toMatchObject({
            status: 'active',
            isOrgOwner: false,
            user: { email: 'ada@example.com' }
        })
        await expect(
            createEmailUser(sql, actor, {
                user: { name: 'Ada', email: 'Ada@example.com', credential: 'Another-2!' },
                workspace: { id: TEAM },
                role: { id: ROLE }
            })
        ).rejects.toMatchObject({ status: 409 })
        expect(db.prepare('SELECT credential FROM "user" WHERE email = ?').all('ada@example.com')).toEqual([{ credential: null }])
        await deleteOrganizationUser(sql, actor, ORG, created.id)
        const removed = db.prepare('SELECT email, status, credential, "externalId" AS externalId FROM "user" WHERE id = ?').all(created.id)
        expect(removed[0]).toMatchObject({ status: 'deleted', credential: null, externalId: null })
        expect(String(removed[0].email)).not.toBe('ada@example.com')
    })

    it('opens an invited team for the caller', async () => {
        const { sql, db } = memorySql()
        db.exec(
            `INSERT INTO workspace (id, name, "organizationId", "createdBy", "updatedBy") VALUES ('team-2', 'Field', '${ORG}', '${OWNER}', '${OWNER}')`
        )
        db.exec(
            `INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status, "createdBy", "updatedBy") VALUES ('team-2', '${OWNER}', '${ROLE}', 'invited', '${OWNER}', '${OWNER}')`
        )
        const store = {
            async touchLastLogin() {
                return undefined
            },
            async sessionFor(userId: string, preferredWorkspaceId?: string | null): Promise<SessionUser | null> {
                return { id: userId, activeWorkspaceId: preferredWorkspaceId || null } as SessionUser
            }
        }
        const session = await switchWorkspace(sql, store as unknown as IdentityStore, actor, 'team-2')
        expect(session.activeWorkspaceId).toBe('team-2')
        expect(db.prepare('SELECT status FROM workspace_user WHERE "workspaceId" = ?').all('team-2')).toEqual([{ status: 'active' }])
    })

    it('rejects a permission that is not in the catalog', async () => {
        const { sql } = memorySql()
        await expect(
            createRole(sql, actor, {
                name: 'editor',
                organizationId: ORG,
                permissions: JSON.stringify(['credentials:share'])
            })
        ).rejects.toBeInstanceOf(DirectoryError)
        expect(catalogKeys()).not.toContain('credentials:share')
        expect(catalogKeys()).toContain('datasets:view')
        expect(catalogKeys()).toContain('evaluators:view')
        expect(catalogKeys()).toContain('evaluations:view')
        expect(catalogKeys()).toContain('evaluations:run')
        expect(catalogKeys()).toContain('users:manage')
        expect(catalogKeys()).toContain('chatflows:view')
    })

    it('ends local sessions when a user is disabled', async () => {
        const { sql, db } = memorySql()
        db.exec(`
            INSERT INTO "user" (id, name, email, credential, status, "createdBy", "updatedBy")
                VALUES ('member-1', 'Member', 'member@example.com', 'hash', 'active', '${OWNER}', '${OWNER}');
            INSERT INTO organization_user ("organizationId", "userId", "roleId", status, "createdBy", "updatedBy")
                VALUES ('${ORG}', 'member-1', '${ROLE}', 'active', '${OWNER}', '${OWNER}');
            INSERT INTO identity_local_session (id, userId, token, expiresAt, absoluteExpiresAt)
                VALUES ('sess-1', 'member-1', 'digest', '2099-01-01', '2099-01-01');
        `)
        await updateOrganizationUser(sql, actor, {
            userId: 'member-1',
            organizationId: ORG,
            status: 'inactive'
        })
        expect(db.prepare('SELECT id FROM identity_local_session').all()).toEqual([])
        expect(db.prepare('SELECT status FROM organization_user WHERE "userId" = ?').all('member-1')).toEqual([{ status: 'disable' }])
    })
})

describe('sign-in screen contract', () => {
    it('reports AuthKit without the break-glass form unless the flag is exactly true', () => {
        expect(signInOptionsBody({ WORKOS_API_KEY: 'key', WORKOS_CLIENT_ID: 'client' })).toEqual({
            authKit: true,
            localAdmin: false,
            localUsers: false,
            mail: false
        })
        expect(signInOptionsBody({ WORKOS_API_KEY: 'key', WORKOS_CLIENT_ID: 'client', CUTTLELY_LOCAL_ADMIN: 'true' })).toEqual({
            authKit: true,
            localAdmin: true,
            localUsers: false,
            mail: false
        })
        expect(
            signInOptionsBody({
                WORKOS_API_KEY: 'key',
                WORKOS_CLIENT_ID: 'client',
                CUTTLELY_LOCAL_USERS: 'true'
            }).localUsers
        ).toBe(false)
        expect(signInOptionsBody({ CUTTLELY_LOCAL_USERS: 'true' }).localUsers).toBe(true)
        expect(signInOptionsBody({ CUTTLELY_LOCAL_USERS: 'TRUE' }).localUsers).toBe(false)
        expect(signInOptionsBody({})).toEqual({ authKit: false, localAdmin: false, localUsers: false, mail: false })
        expect(signInOptionsBody({ SMTP_HOST: 'smtp.example.com' })).toEqual({
            authKit: false,
            localAdmin: false,
            localUsers: false,
            mail: false
        })
        expect(signInOptionsBody({ SMTP_HOST: '   ' })).toEqual({ authKit: false, localAdmin: false, localUsers: false, mail: false })
    })

    it('puts the WorkOS button on the sign-in page and hides the password form unless local admin is on', () => {
        const source = readFileSync(join(__dirname, '../../../ui/src/views/auth/signIn.jsx'), 'utf8')
        expect(source).toContain('Sign in with WorkOS')
        expect(source).toContain("href='/api/v1/auth/login'")
        expect(source).toContain("id='workos-sign-in'")
        expect(source).toContain('options.authKit')
        expect(source).toContain('options.localAdmin')
        expect(source).toContain("id='break-glass-form'")
        const formAt = source.indexOf("id='break-glass-form'")
        const guardAt = source.lastIndexOf('options.localAdmin', formAt)
        expect(guardAt).toBeGreaterThan(-1)
        expect(source.slice(guardAt, formAt)).toContain('options.localAdmin')
        expect(source).not.toContain('Sign In With Microsoft')
        expect(source).not.toContain('Sign In With Google')
        expect(source).not.toContain('Sign In With Auth0')
        expect(source).not.toContain('Sign In With Github')
        expect(source).toContain('options.mail')
        expect(source).toContain('Forgot password')
        const forgotAt = source.indexOf('Forgot password')
        expect(source.lastIndexOf('options.mail', forgotAt)).toBeGreaterThan(-1)
        expect(source).toContain('isAuthenticated')
        expect(source).not.toContain('logoutSuccess')
        const forgotPage = readFileSync(join(__dirname, '../../../ui/src/views/auth/forgotPassword.jsx'), 'utf8')
        expect(forgotPage).toContain('Password reset email is not set up')
        expect(forgotPage).toContain('response.data?.mail')
    })
})
