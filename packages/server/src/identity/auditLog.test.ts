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
import { randomBytes } from 'crypto'
import express, { Request } from 'express'
import request from 'supertest'
import { appendHistory } from '../settings/history'
import { AUDIT_TYPES, redactAudit, recordAudit, pageAudit, organizationsForUser, AuditQueryError, oidcLinkAuditDetail } from './auditLog'
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
    it('keeps every registered audit type within the database limit', () => {
        expect(AUDIT_TYPES).toContain('auth_config_warning_ack')
        expect(AUDIT_TYPES).toEqual(expect.arrayContaining(['scim_group', 'scim_mapping']))
        expect(AUDIT_TYPES.every((type) => type.length <= 32)).toBe(true)
    })
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
                ip: '203.0.113.5',
                userAgent: 'SpyBrowser',
                email: 'nobody@example.com',
                nested: { apiKey: SECRET, questionText: QUESTION, method: 'local' }
            }
        })
        const encoded = JSON.stringify(redacted)
        expect(encoded).not.toContain(PASSWORD)
        expect(encoded).not.toContain(TOKEN)
        expect(encoded).not.toContain(SECRET)
        expect(encoded).not.toContain(QUESTION)
        expect(encoded).not.toContain('203.0.113.5')
        expect(encoded).not.toContain('SpyBrowser')
        expect(encoded).not.toContain('nobody@example.com')
        expect(redacted.summary).toBe('Sign-in failed')
        expect(redacted.detail).toEqual({ method: 'local', nested: { method: 'local' } })
    })

    it('drops camelCase and compound address keys', () => {
        const addresses = {
            ipAddress: '203.0.113.10',
            clientIp: '203.0.113.11',
            clientAddress: '203.0.113.12',
            remoteAddress: '203.0.113.13',
            remoteAddr: '203.0.113.14',
            xForwardedFor: '203.0.113.15',
            forwardedFor: '203.0.113.16',
            IPAddress: '203.0.113.17',
            'X-Forwarded-For': '203.0.113.18'
        }
        const redacted = redactAudit({
            type: 'sign_in_failure',
            summary: 'Sign-in failed',
            detail: { method: 'local', description: 'bakery route', ...addresses }
        })
        const encoded = JSON.stringify(redacted)
        for (const value of Object.values(addresses)) expect(encoded).not.toContain(value)
        expect(redacted.detail).toEqual({ method: 'local', description: 'bakery route' })
    })

    it('omits an unmatched OIDC subject while retaining a matched one', () => {
        const input = {
            issuer: 'https://id.example',
            subject: 'provider-subject',
            basis: null,
            outcome: 'unknown'
        }
        expect(oidcLinkAuditDetail({ ...input, matchedUser: null })).toEqual({
            issuer: 'https://id.example',
            subject: null,
            matchedUser: null,
            basis: null,
            outcome: 'unknown'
        })
        expect(oidcLinkAuditDetail({ ...input, matchedUser: 'user-1' }).subject).toBe('provider-subject')
    })

    it('removes a SCIM bearer value while retaining its display prefix', () => {
        const clear = `cuttlely_scim_${randomBytes(24).toString('base64url')}`
        const redacted = redactAudit({
            type: 'scim_token',
            summary: `SCIM credential changed ${clear}`,
            detail: { bearerCredential: clear, displayPrefix: 'cuttlely_scim_clear-v…', operation: 'rotated' }
        })
        expect(JSON.stringify(redacted)).not.toContain(clear)
        expect(redacted.detail).toEqual({ displayPrefix: 'cuttlely_scim_clear-v…', operation: 'rotated' })
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
        const hidden = await pageAudit(
            sql,
            { organizationId: ORG, workspaceId: TEAM_A, owner: false },
            { type: 'setting_change', limit: 10, historyDir: dir, now: NOW, retentionDays: 90 }
        )
        expect(hidden.events).toEqual([])
        const page = await pageAudit(
            sql,
            { organizationId: ORG, workspaceId: TEAM_A, owner: true },
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

    it('hides a sign-in that matched no account from every organization except the server owner', async () => {
        const { sql } = memorySql()
        const dir = mkdtempSync(join(tmpdir(), 'cuttlely-audit-'))
        await recordAudit(
            sql,
            {
                type: 'sign_in_failure',
                organizationId: '',
                workspaceId: null,
                userId: null,
                actorId: null,
                summary: 'Sign-in failed for nobody@example.com',
                detail: { method: 'local', ip: '203.0.113.9', userAgent: 'SpyBrowser', email: 'nobody@example.com' },
                at: NOW
            },
            NOW
        )
        const scope = { workspaceId: TEAM_A, owner: true as const, historyDir: dir, now: NOW, retentionDays: 90, limit: 10 }
        const orgOwner = await pageAudit(sql, { organizationId: ORG, workspaceId: TEAM_A, owner: true }, scope)
        const otherOwner = await pageAudit(sql, { organizationId: OTHER_ORG, workspaceId: 'team-z', owner: true }, scope)
        const serverOwner = await pageAudit(sql, { organizationId: ORG, workspaceId: TEAM_A, owner: true, serverOwner: true }, scope)
        expect(orgOwner.events).toEqual([])
        expect(otherOwner.events).toEqual([])
        expect(serverOwner.events).toHaveLength(1)
        const encoded = JSON.stringify(serverOwner.events[0])
        expect(encoded).not.toContain('203.0.113.9')
        expect(encoded).not.toContain('SpyBrowser')
        expect(encoded).not.toContain('nobody@example.com')
        expect(serverOwner.events[0].userId).toBeNull()
    })

    it('pages database and settings rows that share a timestamp without a duplicate or a skip', async () => {
        const { sql } = memorySql()
        const dir = mkdtempSync(join(tmpdir(), 'cuttlely-audit-'))
        const at = NOW
        const stamp = new Date(at).toISOString()
        await sql.query(
            `INSERT INTO audit_event (id, type, organizationId, workspaceId, userId, actorId, summary, detail, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
            ['db-a', 'invite', ORG, TEAM_A, MEMBER, OWNER, 'Invite issued', at]
        )
        await sql.query(
            `INSERT INTO audit_event (id, type, organizationId, workspaceId, userId, actorId, summary, detail, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
            ['db-b', 'invite', ORG, TEAM_A, MEMBER, OWNER, 'Invite issued', at]
        )
        appendHistory(dir, { kind: 'save', actorId: OWNER, at: stamp, changes: [{ key: 'LOG_LEVEL', from: 'a', to: 'b' }] }, 10)
        appendHistory(dir, { kind: 'save', actorId: OWNER, at: stamp, changes: [{ key: 'LOG_LEVEL', from: 'b', to: 'c' }] }, 10)
        const seen: string[] = []
        let cursor: string | null = null
        for (let page = 0; page < 6; page += 1) {
            const result = await pageAudit(
                sql,
                { organizationId: ORG, workspaceId: TEAM_A, owner: true },
                { limit: 1, cursor, historyDir: dir, now: NOW, retentionDays: 90 }
            )
            if (!result.events.length) break
            seen.push(result.events[0].id)
            cursor = result.nextCursor
            if (!cursor) break
        }
        expect(seen).toEqual(['db-b', 'db-a', 'history:2', 'history:1'])
        expect(new Set(seen).size).toBe(seen.length)
    })

    it('quotes camelCase aliases so a driver that folds them still returns the row', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'cuttlely-audit-'))
        const seen: string[] = []
        const folding: Sql = {
            type: 'postgres',
            async query(text) {
                seen.push(text)
                if (/^\s*delete/i.test(text)) return []
                if (!/from\s+"audit_event"/i.test(text)) return []
                const row: Record<string, unknown> = {}
                const data: Record<string, unknown> = {
                    id: 'row-1',
                    type: 'sign_in_success',
                    userId: 'user-9',
                    actorId: 'user-9',
                    workspaceId: null,
                    summary: 'Signed in',
                    detail: null,
                    createdAt: NOW
                }
                for (const match of text.matchAll(/\bAS\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)/g)) {
                    const token = match[1]
                    if (token.startsWith('"')) {
                        const name = token.slice(1, -1)
                        row[name] = data[name]
                    } else {
                        row[token.toLowerCase()] = data[token]
                    }
                }
                return [row]
            },
            async transaction(fn) {
                return fn((text, params) => folding.query(text, params))
            }
        }
        const page = await pageAudit(
            folding,
            { organizationId: ORG, workspaceId: TEAM_A, owner: true },
            { limit: 5, historyDir: dir, now: NOW, retentionDays: 90 }
        )
        expect(
            seen.some((text) => text.includes('AS "createdAt"') && text.includes('AS "userId"') && text.includes('AS "workspaceId"'))
        ).toBe(true)
        expect(page.events).toEqual([
            expect.objectContaining({ id: 'row-1', type: 'sign_in_success', userId: 'user-9', at: new Date(NOW).toISOString() })
        ])

        const orgSql: Sql = {
            type: 'postgres',
            async query(text) {
                seen.push(text)
                const row: Record<string, unknown> = {}
                for (const match of text.matchAll(/\bAS\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)/g)) {
                    const token = match[1]
                    if (token.startsWith('"')) row[token.slice(1, -1)] = ORG
                    else row[token.toLowerCase()] = ORG
                }
                return [row]
            },
            async transaction(fn) {
                return fn((text, params) => orgSql.query(text, params))
            }
        }
        await expect(organizationsForUser(orgSql, 'user-9')).resolves.toEqual([ORG])
        expect(seen.some((text) => text.includes('AS "organizationId"'))).toBe(true)
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
        await recordAudit(
            sql,
            {
                type: 'sign_in_failure',
                organizationId: '',
                workspaceId: null,
                userId: null,
                actorId: null,
                summary: 'Sign-in failed',
                detail: { method: 'local', ip: '203.0.113.8', email: 'nobody@example.com' },
                at: NOW - 2
            },
            NOW
        )
        appendHistory(dir, { kind: 'save', actorId: OWNER, changes: [{ key: 'LOG_LEVEL', from: 'info', to: 'debug' }] }, 10)
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
        expect(allowed.body.events.some((event: { type: string }) => event.type === 'setting_change')).toBe(true)
        expect(allowed.body.events.some((event: { workspaceId: string }) => event.workspaceId === TEAM_B)).toBe(true)
        expect(JSON.stringify(allowed.body)).not.toContain('203.0.113.8')
        expect(JSON.stringify(allowed.body)).not.toContain('nobody@example.com')
        const team = await request(app(auditor)).get('/api/v1/audit')
        expect(team.status).toBe(200)
        expect(team.body.events.some((event: { workspaceId: string }) => event.workspaceId === TEAM_B)).toBe(false)
        expect(team.body.events.some((event: { type: string }) => event.type === 'invite')).toBe(true)
        expect(team.body.events.some((event: { type: string }) => event.type === 'setting_change')).toBe(false)
        const other = { id: 'other-owner', activeOrganizationId: OTHER_ORG, activeWorkspaceId: 'team-z' }
        const foreign = await request(app(other)).get('/api/v1/audit')
        expect(foreign.status).toBe(200)
        expect(foreign.body.events.every((event: { type: string }) => event.type === 'setting_change')).toBe(true)
        expect(foreign.body.events.some((event: { type: string }) => event.type === 'invite' || event.type === 'role_change')).toBe(false)
    })

    it('uses the gate body when the session has no user or organization', async () => {
        const missingOrg = await request(app({ id: OWNER })).get('/api/v1/audit')
        expect(missingOrg.status).toBe(401)
        expect(missingOrg.body).toEqual({ error: 'Unauthorized Access' })
        const missingUser = await request(app({ id: '', permissions: ['audit:view'], activeOrganizationId: ORG })).get('/api/v1/audit')
        expect(missingUser.status).toBe(401)
        expect(missingUser.body).toEqual({ error: 'Unauthorized Access' })
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

    it('returns an error when the permission lookup fails', async () => {
        let calls = 0
        setTeamPermissionLookup({
            accessFor: async () => {
                calls += 1
                if (calls > 1) throw new Error('database down')
                return { owner: true, permissions: null }
            }
        })
        const owner = { id: OWNER, activeOrganizationId: ORG, activeWorkspaceId: TEAM_A }
        const response = await request(app(owner)).get('/api/v1/audit')
        expect(response.status).toBe(500)
        expect(response.body).toEqual({ message: 'The audit log could not be read' })
    })
})

const livePg = process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD ? it : it.skip

livePg('reads a stored audit row through postgres with quoted aliases', async () => {
    const pg = require('pg') as {
        Client: new (config: Record<string, unknown>) => {
            connect(): Promise<void>
            query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
            end(): Promise<void>
        }
    }
    const password = process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD
    const client = new pg.Client({ host: '127.0.0.1', user: 'postgres', password, database: 'postgres' })
    await client.connect()
    const name = `cuttlely_audit_${process.pid}`
    await client.query(`DROP DATABASE IF EXISTS ${name}`)
    await client.query(`CREATE DATABASE ${name}`)
    await client.end()
    const db = new pg.Client({ host: '127.0.0.1', user: 'postgres', password, database: name })
    await db.connect()
    try {
        await db.query(`CREATE TABLE audit_event (
            id varchar(255) PRIMARY KEY,
            type varchar(32) NOT NULL,
            "organizationId" varchar(255) NOT NULL,
            "workspaceId" varchar(255) NULL,
            "userId" varchar(255) NULL,
            "actorId" varchar(255) NULL,
            summary varchar(200) NOT NULL,
            detail text NULL,
            "createdAt" bigint NOT NULL
        )`)
        await db.query(`CREATE TABLE workspace_user ("workspaceId" varchar(255), "userId" varchar(255))`)
        const sql: Sql = {
            type: 'postgres',
            async query(text, params = []) {
                let index = 0
                const rewritten = text.replace(/\?/g, () => `$${++index}`)
                const result = await db.query(rewritten, params)
                return result.rows
            },
            async transaction(fn) {
                return fn((text, params) => sql.query(text, params))
            }
        }
        await recordAudit(
            sql,
            {
                type: 'sign_in_success',
                organizationId: ORG,
                workspaceId: null,
                userId: 'user-9',
                actorId: 'user-9',
                summary: 'Signed in',
                detail: { method: 'local' },
                at: NOW
            },
            NOW
        )
        const page = await pageAudit(
            sql,
            { organizationId: ORG, workspaceId: TEAM_A, owner: true },
            { limit: 5, historyDir: mkdtempSync(join(tmpdir(), 'cuttlely-audit-pg-')), now: NOW, retentionDays: 90 }
        )
        expect(page.events).toEqual([
            expect.objectContaining({ type: 'sign_in_success', userId: 'user-9', at: new Date(NOW).toISOString() })
        ])
    } finally {
        await db.end()
        const drop = new pg.Client({ host: '127.0.0.1', user: 'postgres', password, database: 'postgres' })
        await drop.connect()
        await drop.query(`DROP DATABASE IF EXISTS ${name}`)
        await drop.end()
    }
})
