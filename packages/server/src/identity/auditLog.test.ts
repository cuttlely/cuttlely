/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

jest.mock('../DataSource', () => ({
    getDataSource: () => {
        throw new Error('database is not used when the audit reader is installed')
    }
}))

import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import express, { Request } from 'express'
import request from 'supertest'
import { appendHistory } from '../settings/history'
import { redactAudit, recordAudit, pageAudit, AuditQueryError } from './auditLog'
import { identityAuditRouter, setAuditReaderForTests } from './auditRoutes'
import { Sql } from './directory'
import { setTeamPermissionLookup } from './rbac'

const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
        exec(sql: string): void
        prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[]; run(...params: unknown[]): unknown }
    }
}

const ORG = 'org-1'
const OTHER_ORG = 'org-2'
const TEAM_A = 'team-a'
const TEAM_B = 'team-b'
const OWNER = 'owner-1'
const MEMBER = 'member-1'
const PASSWORD = 'pw-example-not-real'
const TOKEN = 'tok-example-not-real'
const SECRET = 'sec-example-not-real'
const QUESTION = 'How many buns did the bakery sell?'
const NOW = Date.parse('2026-10-15T12:00:00.000Z')

function memorySql(): { sql: Sql; db: InstanceType<typeof DatabaseSync> } {
    const db = new DatabaseSync(':memory:')
    db.exec(`
        CREATE TABLE audit_event (
            id text primary key,
            type text not null,
            organizationId text not null,
            workspaceId text,
            userId text,
            actorId text,
            summary text not null,
            detail text,
            createdAt integer not null
        );
        CREATE TABLE workspace_user (workspaceId text, userId text, status text);
        INSERT INTO workspace_user (workspaceId, userId, status) VALUES ('${TEAM_A}', '${MEMBER}', 'active');
        INSERT INTO workspace_user (workspaceId, userId, status) VALUES ('${TEAM_A}', '${OWNER}', 'active');
    `)
    const sql: Sql = {
        type: 'sqlite',
        async query(text, params = []) {
            const stmt = db.prepare(text)
            if (/^\s*(insert|update|delete|create)/i.test(text)) {
                stmt.run(...params)
                return []
            }
            return stmt.all(...params)
        },
        async transaction(fn) {
            return fn((text, params) => sql.query(text, params))
        }
    }
    return { sql, db }
}

function dump(db: InstanceType<typeof DatabaseSync>): string {
    return JSON.stringify(db.prepare('SELECT * FROM audit_event').all())
}

describe('audit redaction', () => {
    it('drops passwords, tokens, secret values, and question text', () => {
        const redacted = redactAudit({
            type: 'sign_in_failure',
            summary: `Sign-in failed ${PASSWORD} ${TOKEN}`,
            detail: {
                method: 'local',
                password: PASSWORD,
                token: TOKEN,
                secret: SECRET,
                question: QUESTION,
                nested: { apiKey: SECRET, questionText: QUESTION, method: 'local' }
            }
        })
        const encoded = JSON.stringify(redacted)
        expect(encoded).not.toContain(PASSWORD)
        expect(encoded).not.toContain(TOKEN)
        expect(encoded).not.toContain(SECRET)
        expect(encoded).not.toContain(QUESTION)
        expect(redacted.summary).toBe('Sign-in failed')
        expect(redacted.detail).toEqual({ method: 'local', nested: { method: 'local' } })
    })

    it('stores none of those values on a row', async () => {
        const { sql, db } = memorySql()
        await recordAudit(
            sql,
            {
                type: 'reset',
                organizationId: ORG,
                workspaceId: TEAM_A,
                userId: MEMBER,
                actorId: OWNER,
                summary: `Password reset ${PASSWORD}`,
                detail: { action: 'completed', password: PASSWORD, token: TOKEN, secret: SECRET, question: QUESTION }
            },
            NOW
        )
        const stored = dump(db)
        expect(stored).not.toContain(PASSWORD)
        expect(stored).not.toContain(TOKEN)
        expect(stored).not.toContain(SECRET)
        expect(stored).not.toContain(QUESTION)
        expect(stored).toContain('Password reset')
        expect(stored).toContain('completed')
    })
})

describe('audit list', () => {
    it('filters by type and user, pages with a cursor, and drops rows older than the retention', async () => {
        const { sql } = memorySql()
        const dir = mkdtempSync(join(tmpdir(), 'cuttlely-audit-'))
        await recordAudit(
            sql,
            {
                type: 'sign_in_success',
                organizationId: ORG,
                workspaceId: null,
                userId: MEMBER,
                actorId: MEMBER,
                summary: 'Signed in',
                detail: { method: 'local' },
                at: NOW - 1000
            },
            NOW
        )
        await recordAudit(
            sql,
            {
                type: 'sign_in_failure',
                organizationId: ORG,
                workspaceId: null,
                userId: MEMBER,
                actorId: MEMBER,
                summary: 'Sign-in failed',
                detail: { method: 'local' },
                at: NOW - 500
            },
            NOW
        )
        await recordAudit(
            sql,
            {
                type: 'role_change',
                organizationId: ORG,
                workspaceId: TEAM_B,
                userId: 'other-user',
                actorId: OWNER,
                summary: 'Role changed',
                detail: { fromRoleId: 'a', toRoleId: 'b' },
                at: NOW
            },
            NOW
        )
        await recordAudit(
            sql,
            {
                type: 'sign_in_failure',
                organizationId: ORG,
                workspaceId: null,
                userId: MEMBER,
                actorId: null,
                summary: 'Sign-in failed',
                detail: { method: 'local' },
                at: NOW - 10 * 24 * 60 * 60 * 1000
            },
            NOW
        )

        const failures = await pageAudit(
            sql,
            { organizationId: ORG, workspaceId: TEAM_A, owner: true },
            { type: 'sign_in_failure', user: MEMBER, limit: 10, historyDir: dir, now: NOW, retentionDays: 2 }
        )
        expect(failures.events.map((event) => event.type)).toEqual(['sign_in_failure'])
        expect(failures.events[0].userId).toBe(MEMBER)
        expect(JSON.stringify(failures)).not.toContain(PASSWORD)

        const page = await pageAudit(
            sql,
            { organizationId: ORG, workspaceId: TEAM_A, owner: true },
            { limit: 1, historyDir: dir, now: NOW, retentionDays: 2 }
        )
        expect(page.events).toHaveLength(1)
        expect(page.nextCursor).toBeTruthy()
        const next = await pageAudit(
            sql,
            { organizationId: ORG, workspaceId: TEAM_A, owner: true },
            { limit: 1, cursor: page.nextCursor, historyDir: dir, now: NOW, retentionDays: 2 }
        )
        expect(next.events).toHaveLength(1)
        expect(next.events[0].id).not.toBe(page.events[0].id)
        await expect(
            pageAudit(
                sql,
                { organizationId: ORG, workspaceId: TEAM_A, owner: true },
                { limit: 1, cursor: 'not-a-cursor', historyDir: dir, now: NOW, retentionDays: 2 }
            )
        ).rejects.toBeInstanceOf(AuditQueryError)
    })

    it('keeps another team and another organization out of a team audit view', async () => {
        const { sql } = memorySql()
        const dir = mkdtempSync(join(tmpdir(), 'cuttlely-audit-'))
        await recordAudit(
            sql,
            {
                type: 'role_change',
                organizationId: ORG,
                workspaceId: TEAM_A,
                userId: MEMBER,
                actorId: OWNER,
                summary: 'Role changed',
                detail: { fromRoleId: 'viewer', toRoleId: 'builder' },
                at: NOW
            },
            NOW
        )
        await recordAudit(
            sql,
            {
                type: 'role_change',
                organizationId: ORG,
                workspaceId: TEAM_B,
                userId: 'stranger',
                actorId: OWNER,
                summary: 'Role changed',
                detail: { fromRoleId: 'viewer', toRoleId: 'admin' },
                at: NOW - 1
            },
            NOW
        )
        await recordAudit(
            sql,
            {
                type: 'sign_in_success',
                organizationId: ORG,
                workspaceId: null,
                userId: MEMBER,
                actorId: MEMBER,
                summary: 'Signed in',
                detail: { method: 'local' },
                at: NOW - 2
            },
            NOW
        )
        await recordAudit(
            sql,
            {
                type: 'user_disable',
                organizationId: OTHER_ORG,
                workspaceId: TEAM_A,
                userId: MEMBER,
                actorId: 'owner-2',
                summary: 'User disabled',
                detail: { disabled: true },
                at: NOW - 3
            },
            NOW
        )

        const team = await pageAudit(
            sql,
            { organizationId: ORG, workspaceId: TEAM_A, owner: false },
            { limit: 20, historyDir: dir, now: NOW, retentionDays: 90 }
        )
        const types = team.events.map((event) => `${event.type}:${event.workspaceId || ''}`)
        expect(types).toContain('role_change:' + TEAM_A)
        expect(types).toContain('sign_in_success:')
        expect(types.join(' ')).not.toContain(TEAM_B)
        expect(team.events.some((event) => event.summary === 'User disabled')).toBe(false)

        const owner = await pageAudit(
            sql,
            { organizationId: ORG, workspaceId: TEAM_A, owner: true },
            { limit: 20, historyDir: dir, now: NOW, retentionDays: 90 }
        )
        expect(owner.events.map((event) => event.workspaceId)).toEqual(expect.arrayContaining([TEAM_A, TEAM_B]))
        expect(owner.events.some((event) => event.summary === 'User disabled')).toBe(false)
    })

    it('joins a settings change and hides secret values and question text', async () => {
        const { sql } = memorySql()
        const dir = mkdtempSync(join(tmpdir(), 'cuttlely-audit-'))
        appendHistory(
            dir,
            {
                kind: 'save',
                actorId: OWNER,
                changes: [
                    { key: 'LOG_LEVEL', from: 'info', to: 'debug' },
                    { key: 'WORKOS_API_KEY', from: '', to: SECRET },
                    { key: 'SAMPLE_QUESTION', from: '', to: QUESTION },
                    { key: 'SMTP_PASSWORD', secret: 'changed' }
                ]
            },
            10
        )
        const page = await pageAudit(
            sql,
            { organizationId: ORG, workspaceId: TEAM_A, owner: false },
            { type: 'setting_change', limit: 10, historyDir: dir, now: NOW, retentionDays: 90 }
        )
        const encoded = JSON.stringify(page)
        expect(page.events).toHaveLength(1)
        expect(page.events[0].type).toBe('setting_change')
        expect(encoded).toContain('LOG_LEVEL')
        expect(encoded).toContain('debug')
        expect(encoded).not.toContain(SECRET)
        expect(encoded).not.toContain(QUESTION)
        expect(encoded).not.toContain(PASSWORD)
        expect(encoded).not.toContain(TOKEN)
    })

    it('pages settings changes with newer rows first', async () => {
        const { sql } = memorySql()
        const dir = mkdtempSync(join(tmpdir(), 'cuttlely-audit-'))
        appendHistory(
            dir,
            { kind: 'save', actorId: OWNER, changes: [{ key: 'LOG_LEVEL', from: 'a', to: 'b' }], at: '2026-10-01T00:00:00.000Z' },
            10
        )
        appendHistory(
            dir,
            { kind: 'save', actorId: OWNER, changes: [{ key: 'LOG_LEVEL', from: 'b', to: 'c' }], at: '2026-10-10T00:00:00.000Z' },
            10
        )
        await recordAudit(
            sql,
            {
                type: 'invite',
                organizationId: ORG,
                workspaceId: TEAM_A,
                userId: MEMBER,
                actorId: OWNER,
                summary: 'Invite issued',
                detail: { mailed: false },
                at: Date.parse('2026-10-05T00:00:00.000Z')
            },
            NOW
        )
        const page = await pageAudit(
            sql,
            { organizationId: ORG, workspaceId: TEAM_A, owner: true },
            { limit: 2, historyDir: dir, now: NOW, retentionDays: 90 }
        )
        expect(page.events.map((event) => event.at)).toEqual(['2026-10-10T00:00:00.000Z', '2026-10-05T00:00:00.000Z'])
        expect(page.nextCursor).toBeTruthy()
        const next = await pageAudit(
            sql,
            { organizationId: ORG, workspaceId: TEAM_A, owner: true },
            { limit: 2, cursor: page.nextCursor, historyDir: dir, now: NOW, retentionDays: 90 }
        )
        expect(next.events.map((event) => event.at)).toEqual(['2026-10-01T00:00:00.000Z'])
    })
})

describe('GET /api/v1/audit', () => {
    const { sql } = memorySql()
    const dir = mkdtempSync(join(tmpdir(), 'cuttlely-audit-'))

    function app(user: object | null) {
        const server = express()
        server.use((req, _res, next) => {
            if (user) (req as Request).user = user as Express.User
            next()
        })
        server.use('/api/v1/audit', identityAuditRouter)
        return server
    }

    beforeAll(async () => {
        setAuditReaderForTests(sql, dir)
        await recordAudit(
            sql,
            {
                type: 'invite',
                organizationId: ORG,
                workspaceId: TEAM_A,
                userId: MEMBER,
                actorId: OWNER,
                summary: 'Invite issued',
                detail: { mailed: false, password: PASSWORD, token: TOKEN, question: QUESTION },
                at: NOW
            },
            NOW
        )
        await recordAudit(
            sql,
            {
                type: 'role_change',
                organizationId: ORG,
                workspaceId: TEAM_B,
                userId: 'stranger',
                actorId: OWNER,
                summary: 'Role changed',
                detail: { fromRoleId: 'a', toRoleId: 'b' },
                at: NOW - 1
            },
            NOW
        )
    })

    afterAll(() => {
        setAuditReaderForTests(null)
        setTeamPermissionLookup(null)
    })

    beforeEach(() => {
        setTeamPermissionLookup({
            accessFor: async (userId) => {
                if (userId === OWNER) return { owner: true, permissions: null }
                if (userId === 'auditor') return { owner: false, permissions: ['audit:view'] }
                if (userId === 'other-owner') return { owner: true, permissions: null }
                return { owner: false, permissions: ['chatflows:view'] }
            }
        })
    })

    it('lets the owner and audit:view read, and refuses everyone else', async () => {
        const owner = { id: OWNER, activeOrganizationId: ORG, activeWorkspaceId: TEAM_A }
        const auditor = { id: 'auditor', activeOrganizationId: ORG, activeWorkspaceId: TEAM_A }
        const member = { id: MEMBER, activeOrganizationId: ORG, activeWorkspaceId: TEAM_A }
        const apiKey = { permissions: ['audit:view'], activeOrganizationId: ORG, activeWorkspaceId: TEAM_A }
        expect((await request(app(null)).get('/api/v1/audit')).status).toBe(401)
        expect((await request(app(member)).get('/api/v1/audit')).status).toBe(403)
        expect((await request(app(apiKey)).get('/api/v1/audit')).status).toBe(403)
        expect((await request(app(apiKey)).post('/api/v1/audit/login-activity').send({})).status).toBe(404)
        const allowed = await request(app(owner)).get('/api/v1/audit')
        expect(allowed.status).toBe(200)
        expect(allowed.headers['cache-control']).toBe('no-store')
        expect(JSON.stringify(allowed.body)).not.toContain(PASSWORD)
        expect(JSON.stringify(allowed.body)).not.toContain(TOKEN)
        expect(JSON.stringify(allowed.body)).not.toContain(QUESTION)
        expect(allowed.body.events.some((event: { type: string }) => event.type === 'invite')).toBe(true)
        expect(allowed.body.events.some((event: { workspaceId: string }) => event.workspaceId === TEAM_B)).toBe(true)
        const team = await request(app(auditor)).get('/api/v1/audit')
        expect(team.status).toBe(200)
        expect(team.body.events.some((event: { workspaceId: string }) => event.workspaceId === TEAM_B)).toBe(false)
        expect(team.body.events.some((event: { type: string }) => event.type === 'invite')).toBe(true)
        const other = { id: 'other-owner', activeOrganizationId: OTHER_ORG, activeWorkspaceId: 'team-z' }
        const foreign = await request(app(other)).get('/api/v1/audit')
        expect(foreign.status).toBe(200)
        expect(foreign.body.events).toEqual([])
    })

    it('rejects a bad cursor, a bad type, and a bad limit', async () => {
        const owner = { id: OWNER, activeOrganizationId: ORG, activeWorkspaceId: TEAM_A }
        expect((await request(app(owner)).get('/api/v1/audit?cursor=not-a-cursor')).body.code).toBe('INVALID_CURSOR')
        expect((await request(app(owner)).get('/api/v1/audit?type=nope')).body.code).toBe('INVALID_TYPE')
        expect((await request(app(owner)).get('/api/v1/audit?limit=0')).body.code).toBe('INVALID_LIMIT')
        const filtered = await request(app(owner)).get(`/api/v1/audit?type=invite&user=${MEMBER}`)
        expect(filtered.status).toBe(200)
        expect(filtered.body.events).toHaveLength(1)
        expect(filtered.body.events[0].type).toBe('invite')
    })
})
