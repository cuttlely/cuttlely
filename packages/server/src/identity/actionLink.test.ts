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
        throw new Error('database is not used when the permission gate refuses')
    }
}))

import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { mkdtempSync, readFileSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import express from 'express'
import request from 'supertest'
import { resetAccountLinksForTests } from '../settings/accountLinks'
import { writeSettingsFile } from '../settings/store'
import {
    LINK_INVALID,
    INVITE_NEEDS_AUTHKIT,
    MAIL_FAILED,
    MAIL_REQUIRED,
    PASSWORD_SAVED,
    TOO_MANY_LINKS,
    LinkDeps,
    acceptLocalPassword,
    actionLinkMetrics,
    actionTtlMs,
    linkClock,
    linkDbTime,
    inviteAccount,
    resetLocalLink,
    sendSmtp,
    smtpReady
} from './actionLink'
import { DirectoryActor, Sql } from './directory'
import { identityUsersRouter, registerInvite } from './directoryRoutes'
import { verifyPassword } from './password'
import { LoginRateLimit } from './rateLimit'
import { setTeamPermissionLookup } from './rbac'
import { addIdentityActionLinks } from './schemaMigration'

const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
        exec(sql: string): void
        prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[]; run(...params: unknown[]): { changes?: number } }
    }
}

const ORG = 'org-1'
const OWNER = 'owner-1'
const TEAM = 'team-1'
const ROLE = 'role-member'
const NOW = Date.parse('2026-10-15T00:00:00.000Z')
const GOOD = 'Sup3r-Secret!'

function memoryDb() {
    const db = new DatabaseSync(':memory:')
    db.exec(`
        CREATE TABLE "user" (
            id text primary key, name text, email text unique, credential text, status text,
            "externalId" text, "ssoProvider" text, "ssoSubjectId" text,
            "createdBy" text, "updatedBy" text, "createdDate" text, "updatedDate" text
        );
        CREATE TABLE organization (id text primary key, name text);
        CREATE TABLE role (
            id text primary key, "organizationId" text, name text, description text, permissions text
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
            "workspaceId" text, "userId" text, "roleId" text, status text,
            "createdBy" text, "updatedBy" text, "updatedDate" text,
            primary key ("workspaceId", "userId")
        );
        CREATE TABLE identity_local_session (
            id text primary key, userId text, token text, expiresAt text, absoluteExpiresAt text
        );
        CREATE TABLE identity_action_link (
            id text primary key, tokenHash text unique, purpose text, organizationId text, workspaceId text,
            userId text, expiresAt text, usedAt text, consumeId text, createdBy text, createdDate text
        );
        CREATE TABLE identity_action_audit (
            id text primary key, action text, purpose text, organizationId text, workspaceId text,
            userId text, actorId text, result text, reason text, createdDate text
        );
        INSERT INTO organization (id, name) VALUES ('${ORG}', 'Bakery');
        INSERT INTO "user" (id, name, email, status) VALUES ('${OWNER}', 'Owner', 'owner@example.com', 'active');
        INSERT INTO role (id, name, permissions) VALUES ('${ROLE}', 'member', '[]');
        INSERT INTO role (id, "organizationId", name, permissions) VALUES ('role-owner', '${ORG}', 'owner', '[]');
        INSERT INTO role (id, "organizationId", name, permissions) VALUES ('role-wide', '${ORG}', 'wide', '["chatflows:delete"]');
        INSERT INTO role (id, "organizationId", name, permissions) VALUES ('role-same', '${ORG}', 'same', '["users:manage"]');
        INSERT INTO workspace (id, name, "organizationId") VALUES ('${TEAM}', 'Shop', '${ORG}');
        INSERT INTO workspace (id, name, "organizationId") VALUES ('team-2', 'Kitchen', '${ORG}');
        INSERT INTO organization_user ("organizationId", "userId", "roleId", status) VALUES ('${ORG}', '${OWNER}', 'role-owner', 'active');
        INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES ('${TEAM}', '${OWNER}', '${ROLE}', 'active');
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

const owner: DirectoryActor = { id: OWNER, organizationId: ORG, workspaceId: TEAM, owner: true, permissions: [] }
const manager: DirectoryActor = {
    id: 'manager-1',
    organizationId: ORG,
    workspaceId: TEAM,
    owner: false,
    permissions: ['users:manage', 'workspace:add-user']
}

function inviteBody(email = 'ada@example.com', roleId = ROLE) {
    return {
        user: { name: 'Ada Lovelace', email, credential: 'Throwaway-1!' },
        workspace: { id: TEAM },
        role: { id: roleId }
    }
}

function clockRows(rows: Record<string, unknown>[], asNumber: boolean): Record<string, unknown>[] {
    return rows.map((row) => {
        const next = { ...row }
        for (const key of Object.keys(next)) {
            if (typeof next[key] !== 'string' || !/(At|Date)$/.test(key)) continue
            const parsed = Date.parse(String(next[key]))
            if (Number.isNaN(parsed)) continue
            next[key] = asNumber ? parsed : new Date(parsed)
        }
        return next
    })
}

/** Select results look like Postgres or MySQL: datetime columns come back as Date, or as epoch milliseconds. */
function dateReturning(sql: Sql, asNumber = false): Sql {
    const present = async (statement: string, params: unknown[] = []) => {
        const rows = await sql.query(statement, params)
        if (!/^\s*select/i.test(statement)) return rows
        return clockRows(rows, asNumber)
    }
    return {
        ...sql,
        query: present,
        transaction: (fn) => sql.transaction(async (_query) => fn(async (statement, params = []) => present(statement, params)))
    }
}

function numberReturning(sql: Sql): Sql {
    return dateReturning(sql, true)
}

function deps(
    extra: Partial<LinkDeps> & {
        mail?: boolean
        sent?: { to: string; subject: string; text: string }[]
        failMail?: boolean
        now?: number
        env?: NodeJS.ProcessEnv
    } = {}
): LinkDeps {
    const sent = extra.sent || []
    return {
        now: () => extra.now ?? NOW,
        env: extra.env || {},
        origin: () => 'https://bakery.example',
        mailReady: () => extra.mail === true,
        send: async (message) => {
            if (extra.failMail) throw new Error('mail send failed')
            sent.push(message)
        },
        rateLimit: extra.rateLimit || new LoginRateLimit(),
        activeMethod: extra.activeMethod || (() => undefined)
    }
}

function tokenOf(link: string): string {
    const url = new URL(link)
    expect(url.search).toBe('')
    expect(url.pathname).toBe('/local-accept')
    expect(url.hash.startsWith('#token=')).toBe(true)
    return decodeURIComponent(url.hash.slice('#token='.length))
}

function dump(db: InstanceType<typeof DatabaseSync>): string {
    const links = db.prepare('SELECT * FROM identity_action_link').all()
    const audits = db.prepare('SELECT * FROM identity_action_audit').all()
    const users = db.prepare('SELECT id, email, credential, status FROM "user"').all()
    return JSON.stringify({ links, audits, users })
}

describe('invite and reset links', () => {
    it('keeps the existing invite response when link is omitted', async () => {
        const { sql, db } = memoryDb()
        const sent: { to: string; subject: string; text: string }[] = []
        const created = await inviteAccount(sql, manager, inviteBody(), deps({ sent, mail: false }))
        expect(created).toEqual({ id: expect.any(String) })
        expect(created).not.toHaveProperty('link')
        expect(sent).toEqual([])
        const row = db.prepare('SELECT credential, status FROM "user" WHERE email = ?').all('ada@example.com')
        expect(row).toEqual([{ credential: null, status: 'invited' }])
        expect(db.prepare('SELECT id FROM identity_action_link').all()).toEqual([])
    })

    it('returns a fragment link once when link is true, and does not store the raw token', async () => {
        const { sql, db } = memoryDb()
        const created = await inviteAccount(sql, manager, { ...inviteBody(), link: true }, deps())
        expect(created.link?.startsWith('https://bakery.example/local-accept#token=')).toBe(true)
        const raw = tokenOf(created.link || '')
        expect(raw.length).toBeGreaterThan(20)
        expect(dump(db)).not.toContain(raw)
        expect(dump(db)).not.toContain('Throwaway-1!')
        const stored = db.prepare('SELECT tokenHash, purpose, workspaceId, usedAt FROM identity_action_link').all()
        expect(stored).toEqual([
            { tokenHash: createHash('sha256').update(raw).digest('hex'), purpose: 'invite', workspaceId: TEAM, usedAt: null }
        ])
        const audits = db.prepare('SELECT action, reason FROM identity_action_audit').all()
        expect(audits).toEqual([{ action: 'link_issued', reason: 'issued' }])
    })

    it('covers mail on, mail off, link true, link false, and the default', async () => {
        const { sql, db } = memoryDb()
        const sent: { to: string; subject: string; text: string }[] = []
        await expect(
            inviteAccount(sql, manager, { ...inviteBody('a@example.com'), link: false }, deps({ mail: false }))
        ).rejects.toMatchObject({
            status: 400,
            message: MAIL_REQUIRED
        })
        expect(db.prepare('SELECT id FROM "user" WHERE email = ?').all('a@example.com')).toEqual([])

        const mailed = await inviteAccount(sql, manager, { ...inviteBody('b@example.com'), link: false }, deps({ mail: true, sent }))
        expect(mailed).toEqual({ id: expect.any(String), mailed: true })
        expect(mailed).not.toHaveProperty('link')
        expect(sent).toHaveLength(1)
        expect(sent[0].to).toBe('b@example.com')
        expect(sent[0].text).toContain('#token=')
        expect(dump(db)).not.toContain(sent[0].text.split('#token=')[1].trim())

        sent.length = 0
        const shown = await inviteAccount(sql, manager, { ...inviteBody('c@example.com'), link: true }, deps({ mail: true, sent }))
        expect(shown.link).toContain('#token=')
        expect(shown.mailed).toBe(true)
        expect(sent[0].text).toContain(tokenOf(shown.link || ''))

        const quiet = await inviteAccount(sql, manager, { ...inviteBody('d@example.com'), link: true }, deps({ mail: false, sent }))
        expect(quiet).toEqual({ id: expect.any(String), link: expect.stringContaining('#token=') })
        expect(sent).toHaveLength(1)
    })

    it('lets workspace:add-user send an invite link only into their own team, and refuses a role they cannot grant', async () => {
        const { sql } = memoryDb()
        const adder: DirectoryActor = { ...manager, permissions: ['workspace:add-user'] }
        const linked = await inviteAccount(sql, adder, { ...inviteBody(), link: true }, deps())
        expect(linked.link).toContain('#token=')
        await expect(
            inviteAccount(sql, adder, { ...inviteBody('kitchen@example.com'), workspace: { id: 'team-2' }, link: true }, deps())
        ).rejects.toMatchObject({ status: 403 })
        await expect(
            inviteAccount(sql, adder, { ...inviteBody('kitchen@example.com'), workspace: { id: 'team-2' } }, deps())
        ).rejects.toMatchObject({ status: 404 })
        await expect(
            inviteAccount(sql, adder, { ...inviteBody('wide-adder@example.com'), link: true, role: { id: 'role-wide' } }, deps())
        ).rejects.toMatchObject({ status: 403, message: 'You cannot grant this role' })
        const lookingOnly: DirectoryActor = { ...manager, permissions: ['chatflows:view'] }
        await expect(inviteAccount(sql, lookingOnly, { ...inviteBody('nobody@example.com'), link: true }, deps())).rejects.toMatchObject({
            status: 403
        })
        const plain = await inviteAccount(sql, adder, inviteBody('kept@example.com'), deps())
        expect(plain).toEqual({ id: expect.any(String) })
        await expect(
            inviteAccount(sql, manager, { ...inviteBody('wide@example.com'), link: true, role: { id: 'role-wide' } }, deps())
        ).rejects.toMatchObject({
            status: 403,
            message: 'You cannot grant this role'
        })
        const granted = await inviteAccount(
            sql,
            owner,
            { ...inviteBody('wide-ok@example.com'), link: true, role: { id: 'role-wide' } },
            deps()
        )
        expect(granted.link).toContain('#token=')
        const owned = await inviteAccount(sql, owner, { ...inviteBody('own@example.com'), role: { id: 'role-owner' } }, deps())
        expect(owned.id).toEqual(expect.any(String))
    })

    it('with AuthKit on, gives workspace:add-user the invite link for their own team and nothing beyond it', async () => {
        const { sql, db } = memoryDb()
        const env = { WORKOS_API_KEY: 'sk_test_example', WORKOS_CLIENT_ID: 'client_example' }
        const adder: DirectoryActor = { ...manager, permissions: ['workspace:add-user'] }
        const created = await inviteAccount(sql, adder, inviteBody('ada@example.com'), deps({ env }))
        expect(created.link).toContain('#token=')
        expect(db.prepare('SELECT status FROM "user" WHERE email = ?').all('ada@example.com')).toEqual([{ status: 'invited' }])
        await expect(
            inviteAccount(sql, adder, { ...inviteBody('kitchen@example.com'), workspace: { id: 'team-2' } }, deps({ env }))
        ).rejects.toMatchObject({ status: 403 })
        await expect(
            inviteAccount(sql, adder, { ...inviteBody('wide@example.com'), role: { id: 'role-wide' } }, deps({ env }))
        ).rejects.toMatchObject({ status: 403, message: 'You cannot grant this role' })
        await expect(
            inviteAccount(sql, adder, { ...inviteBody('boss@example.com'), role: { id: 'role-owner' } }, deps({ env }))
        ).rejects.toMatchObject({ status: 403 })
        expect(
            db
                .prepare('SELECT email FROM "user" WHERE email IN (?, ?, ?)')
                .all('kitchen@example.com', 'wide@example.com', 'boss@example.com')
        ).toEqual([])
    })

    it('uses the durable active method for omitted links across OIDC and local method switches', async () => {
        const { sql, db } = memoryDb()
        const oidc = await inviteAccount(sql, manager, inviteBody('oidc@example.com'), deps({ activeMethod: () => 'oidc' }))
        expect(oidc.link).toContain('#token=')
        expect(db.prepare('SELECT COUNT(*) AS count FROM identity_action_link').all()).toEqual([{ count: 1 }])
        await expect(
            acceptLocalPassword(
                sql,
                { body: { token: tokenOf(oidc.link || ''), password: GOOD }, query: {}, ip: '203.0.113.50', now: NOW },
                deps({ activeMethod: () => 'local' })
            )
        ).resolves.toMatchObject({ status: 200, body: { message: PASSWORD_SAVED } })

        const local = await inviteAccount(
            sql,
            manager,
            inviteBody('local@example.com'),
            deps({
                env: { WORKOS_API_KEY: 'sk_test_example', WORKOS_CLIENT_ID: 'client_example' },
                activeMethod: () => 'local'
            })
        )
        expect(local).toEqual({ id: expect.any(String) })
        expect(local).not.toHaveProperty('link')
        expect(db.prepare('SELECT COUNT(*) AS count FROM identity_action_link').all()).toEqual([{ count: 1 }])

        const sent: { to: string; subject: string; text: string }[] = []
        const mailed = await inviteAccount(
            sql,
            manager,
            { ...inviteBody('mailed@example.com'), link: false },
            deps({ activeMethod: () => 'oidc', mail: true, sent })
        )
        expect(mailed).toEqual({ id: expect.any(String), mailed: true })
        expect(sent).toEqual([
            expect.objectContaining({ to: 'mailed@example.com', subject: 'Join Cuttlely', text: expect.stringContaining('#token=') })
        ])
    })

    it('blocks password invite acceptance for OIDC before and inside the transaction without consuming the link', async () => {
        const { sql, db } = memoryDb()
        const first = await inviteAccount(sql, owner, { ...inviteBody('first@example.com'), link: true }, deps())
        const precheck = await acceptLocalPassword(
            sql,
            { body: { token: tokenOf(first.link || ''), password: GOOD }, query: {}, ip: '203.0.113.51', now: NOW },
            deps({ activeMethod: () => 'oidc' })
        )
        expect(precheck).toEqual({ type: 'json', status: 400, body: { message: INVITE_NEEDS_AUTHKIT } })

        const second = await inviteAccount(sql, owner, { ...inviteBody('second@example.com'), link: true }, deps())
        let reads = 0
        const recheck = await acceptLocalPassword(
            sql,
            { body: { token: tokenOf(second.link || ''), password: GOOD }, query: {}, ip: '203.0.113.52', now: NOW },
            deps({ activeMethod: () => (++reads === 1 ? 'local' : 'oidc') })
        )
        expect(recheck).toEqual({ type: 'json', status: 400, body: { message: INVITE_NEEDS_AUTHKIT } })
        expect(reads).toBe(2)
        expect(
            db
                .prepare('SELECT email, credential, status FROM "user" WHERE email IN (?, ?) ORDER BY email')
                .all('first@example.com', 'second@example.com')
        ).toEqual([
            { email: 'first@example.com', credential: null, status: 'invited' },
            { email: 'second@example.com', credential: null, status: 'invited' }
        ])
        expect(db.prepare('SELECT "usedAt" AS "usedAt", "consumeId" AS "consumeId" FROM identity_action_link').all()).toEqual([
            { usedAt: null, consumeId: null },
            { usedAt: null, consumeId: null }
        ])
    })

    it('uses the configured lifetime and falls back when the setting is unusable', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        expect(actionTtlMs('invite', {})).toBe(72 * 60 * 60 * 1000)
        expect(actionTtlMs('invite', { INVITE_TOKEN_EXPIRY_IN_HOURS: '2' })).toBe(2 * 60 * 60 * 1000)
        expect(actionTtlMs('invite', { INVITE_TOKEN_EXPIRY_IN_HOURS: '0' })).toBe(72 * 60 * 60 * 1000)
        expect(actionTtlMs('invite', { INVITE_TOKEN_EXPIRY_IN_HOURS: '-3' })).toBe(72 * 60 * 60 * 1000)
        expect(actionTtlMs('invite', { INVITE_TOKEN_EXPIRY_IN_HOURS: 'nope' })).toBe(72 * 60 * 60 * 1000)
        expect(actionTtlMs('invite', { INVITE_TOKEN_EXPIRY_IN_HOURS: '9999' })).toBe(168 * 60 * 60 * 1000)
        expect(actionTtlMs('reset', {})).toBe(60 * 60 * 1000)
        expect(actionTtlMs('reset', { PASSWORD_RESET_TOKEN_EXPIRY_IN_MINS: '10' })).toBe(10 * 60 * 1000)
        expect(actionTtlMs('reset', { PASSWORD_RESET_TOKEN_EXPIRY_IN_MINS: '1' })).toBe(5 * 60 * 1000)
        expect(actionTtlMs('reset', { PASSWORD_RESET_TOKEN_EXPIRY_IN_MINS: '0' })).toBe(60 * 60 * 1000)
        const warnings = warn.mock.calls.map((call) => String(call[0])).join('\n')
        expect(warnings).toContain('INVITE_TOKEN_EXPIRY_IN_HOURS')
        expect(warnings).not.toContain('nope')
        expect(warnings).not.toContain('9999')
        warn.mockRestore()
    })

    it('follows invite delivery when the request omits link, and an explicit link still wins', async () => {
        const { sql } = memoryDb()
        const omitted = await inviteAccount(sql, owner, inviteBody('omit@example.com'), deps())
        expect(omitted).toEqual({ id: expect.any(String) })
        expect(omitted.link).toBeUndefined()
        const copied = await inviteAccount(sql, owner, inviteBody('copy@example.com'), deps({ env: { INVITE_DELIVERY: 'link' } }))
        expect(copied.link).toContain('#token=')
        await expect(
            inviteAccount(sql, owner, inviteBody('mail@example.com'), deps({ env: { INVITE_DELIVERY: 'email' } }))
        ).rejects.toMatchObject({ status: 400 })
        const sent: { to: string; subject: string; text: string }[] = []
        const explicit = await inviteAccount(
            sql,
            owner,
            { ...inviteBody('explicit@example.com'), link: false },
            deps({ env: { INVITE_DELIVERY: 'link' }, mail: true, sent })
        )
        expect(explicit.link).toBeUndefined()
        expect(explicit.mailed).toBe(true)
        expect(sent).toHaveLength(1)
    })

    it('uses a saved lifetime ahead of the environment', () => {
        const data = mkdtempSync(join(tmpdir(), 'cuttlely-link-settings-'))
        writeSettingsFile(
            join(data, 'settings'),
            { INVITE_TOKEN_EXPIRY_IN_HOURS: '24' },
            { key: 'test-key-not-a-real-secret-0123456789abcdef' }
        )
        resetAccountLinksForTests()
        expect(actionTtlMs('invite', { CUTTLELY_DATA_DIR: data, INVITE_TOKEN_EXPIRY_IN_HOURS: '10' })).toBe(24 * 60 * 60 * 1000)
    })

    it('stores the configured expiry', async () => {
        const { sql, db } = memoryDb()
        await inviteAccount(sql, owner, { ...inviteBody(), link: true }, deps({ env: { INVITE_TOKEN_EXPIRY_IN_HOURS: '2' } }))
        const row = db.prepare('SELECT expiresAt FROM identity_action_link').all()[0]
        expect(row.expiresAt).toBe(new Date(NOW + 2 * 60 * 60 * 1000).toISOString())
    })

    it('invalidates an older link only for the same user, purpose, and workspace', async () => {
        const { sql, db } = memoryDb()
        db.exec(`
            INSERT INTO "user" (id, name, email, status) VALUES ('member-1', 'Ada', 'ada@example.com', 'active');
            INSERT INTO organization_user ("organizationId", "userId", "roleId", status) VALUES ('${ORG}', 'member-1', '${ROLE}', 'active');
            INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES ('${TEAM}', 'member-1', '${ROLE}', 'active');
        `)
        const first = await resetLocalLink(sql, owner, 'member-1', { link: true }, deps())
        const invite = await inviteAccount(sql, owner, { ...inviteBody('bee@example.com'), link: true }, deps())
        const second = await resetLocalLink(sql, owner, 'member-1', { link: true }, deps())
        const rows = db.prepare('SELECT purpose, userId, usedAt, consumeId FROM identity_action_link ORDER BY createdDate').all()
        const resetRows = rows.filter((row) => row.purpose === 'reset' && row.userId === 'member-1')
        expect(resetRows).toHaveLength(2)
        expect(resetRows[0].usedAt).toBe(new Date(NOW).toISOString())
        expect(resetRows[0].consumeId).toBe('superseded')
        expect(resetRows[1].usedAt).toBeNull()
        const inviteRow = rows.find((row) => row.userId !== 'member-1')
        expect(inviteRow?.usedAt).toBeNull()
        const stale = await acceptLocalPassword(
            sql,
            { body: { token: tokenOf(first.link || ''), password: GOOD }, query: {}, ip: '203.0.113.8', now: NOW },
            deps()
        )
        expect(stale).toMatchObject({ status: 400, body: { message: LINK_INVALID } })
        expect(invite.link).toBeTruthy()
        expect(second.link).toBeTruthy()
    })

    it('accepts a token once, refuses expiry, reuse, a weak password, and a query token', async () => {
        const { sql, db } = memoryDb()
        const created = await inviteAccount(sql, owner, { ...inviteBody(), link: true }, deps())
        const raw = tokenOf(created.link || '')
        const weak = await acceptLocalPassword(
            sql,
            { body: { token: raw, password: 'short' }, query: { token: 'other-value' }, ip: '203.0.113.9', now: NOW },
            deps()
        )
        expect(weak).toMatchObject({ status: 400 })
        const weakMessage = (weak.type === 'json' && weak.body && (weak.body as { message: string }).message) || ''
        expect(weakMessage).not.toBe(LINK_INVALID)
        const unknown = await acceptLocalPassword(
            sql,
            { body: { token: 'missing-token-value', password: 'short' }, query: {}, ip: '203.0.113.90', now: NOW },
            deps()
        )
        const unknownMessage = (unknown.type === 'json' && unknown.body && (unknown.body as { message: string }).message) || ''
        expect(unknownMessage).toBe(weakMessage)
        expect(db.prepare('SELECT usedAt FROM identity_action_link').all()).toEqual([{ usedAt: null }])
        expect(db.prepare('SELECT usedAt FROM identity_action_link').all()).toEqual([{ usedAt: null }])
        const ok = await acceptLocalPassword(
            sql,
            { body: { token: raw, password: GOOD }, query: { token: 'ignored-query-token' }, ip: '203.0.113.9', now: NOW },
            deps()
        )
        expect(ok).toMatchObject({ status: 200, body: { message: PASSWORD_SAVED } })
        const credential = db.prepare('SELECT credential FROM "user" WHERE email = ?').all('ada@example.com')[0].credential as string
        expect(credential.startsWith('scrypt$')).toBe(true)
        expect(await verifyPassword(GOOD, credential)).toBe(true)
        expect(dump(db)).not.toContain(raw)
        expect(dump(db)).not.toContain('ignored-query-token')
        const again = await acceptLocalPassword(
            sql,
            { body: { token: raw, password: GOOD }, query: {}, ip: '203.0.113.10', now: NOW },
            deps()
        )
        expect(again).toMatchObject({ status: 400, body: { message: LINK_INVALID } })
        const late = await inviteAccount(sql, owner, { ...inviteBody('late@example.com'), link: true }, deps())
        const expired = await acceptLocalPassword(
            sql,
            { body: { token: tokenOf(late.link || ''), password: GOOD }, query: {}, ip: '203.0.113.11', now: NOW + 72 * 60 * 60 * 1000 },
            deps()
        )
        expect(expired).toMatchObject({ status: 400, body: { message: LINK_INVALID } })
        expect(db.prepare("SELECT reason FROM identity_action_audit WHERE reason = 'expired'").all().length).toBeGreaterThan(0)
    })

    it('lets only one of two concurrent accepts set the password', async () => {
        const { sql, db } = memoryDb()
        const created = await inviteAccount(sql, owner, { ...inviteBody(), link: true }, deps())
        const raw = tokenOf(created.link || '')
        let waiting = 0
        const query = async (statement: string, params: unknown[] = []) => {
            if (/^\s*update/i.test(statement) && statement.includes('consumeId') && statement.includes('tokenHash')) {
                waiting += 1
                await new Promise<void>((resolve) => setImmediate(resolve))
            }
            const prepared = db.prepare(statement)
            if (/^\s*select/i.test(statement)) return prepared.all(...params)
            prepared.run(...params)
            return []
        }
        const racing: Sql = { type: 'sqlite', query, transaction: async (fn) => fn(query) }
        const input = { body: { token: raw, password: GOOD }, query: {}, ip: '203.0.113.12', now: NOW }
        const [left, right] = await Promise.all([acceptLocalPassword(racing, input, deps()), acceptLocalPassword(racing, input, deps())])
        const statuses = [left, right].map((item) => (item.type === 'json' ? item.status : 0)).sort()
        expect(waiting).toBeGreaterThan(0)
        expect(statuses).toEqual([200, 400])
        expect(db.prepare('SELECT credential FROM "user" WHERE email = ?').all('ada@example.com')[0].credential).toMatch(/^scrypt\$/)
    })

    it('refuses reset for another workspace, the owner, SSO, a service account, a disabled user, and a higher role', async () => {
        const { sql, db } = memoryDb()
        db.exec(`
            INSERT INTO "user" (id, name, email, status, "externalId", "ssoProvider")
                VALUES ('ada', 'Ada', 'ada@example.com', 'active', NULL, NULL);
            INSERT INTO "user" (id, name, email, status, "externalId")
                VALUES ('sso', 'Sam', 'sam@example.com', 'active', 'workos-1');
            INSERT INTO "user" (id, name, email, status) VALUES ('svc', 'Bot', 'bot@example.com', 'service');
            INSERT INTO "user" (id, name, email, status) VALUES ('off', 'Off', 'off@example.com', 'active');
            INSERT INTO "user" (id, name, email, status) VALUES ('wide', 'Wide', 'wide@example.com', 'active');
            INSERT INTO "user" (id, name, email, status) VALUES ('peer', 'Peer', 'peer@example.com', 'active');
            INSERT INTO "user" (id, name, email, status) VALUES ('other', 'Other', 'other@example.com', 'active');
            INSERT INTO organization_user ("organizationId", "userId", "roleId", status) VALUES
                ('${ORG}', 'ada', '${ROLE}', 'active'),
                ('${ORG}', 'sso', '${ROLE}', 'active'),
                ('${ORG}', 'svc', '${ROLE}', 'active'),
                ('${ORG}', 'off', '${ROLE}', 'disable'),
                ('${ORG}', 'wide', 'role-wide', 'active'),
                ('${ORG}', 'peer', 'role-same', 'active'),
                ('${ORG}', 'other', '${ROLE}', 'active');
            INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES
                ('${TEAM}', 'ada', '${ROLE}', 'active'),
                ('${TEAM}', 'sso', '${ROLE}', 'active'),
                ('${TEAM}', 'svc', '${ROLE}', 'active'),
                ('${TEAM}', 'off', '${ROLE}', 'active'),
                ('${TEAM}', 'wide', 'role-wide', 'active'),
                ('${TEAM}', 'peer', 'role-same', 'active'),
                ('team-2', 'other', '${ROLE}', 'active');
        `)
        await expect(resetLocalLink(sql, owner, 'other', {}, deps())).rejects.toMatchObject({ status: 404, message: 'User not found' })
        await expect(resetLocalLink(sql, owner, 'missing', {}, deps())).rejects.toMatchObject({ status: 404, message: 'User not found' })
        await expect(resetLocalLink(sql, owner, OWNER, {}, deps())).rejects.toMatchObject({ status: 403 })
        await expect(resetLocalLink(sql, owner, 'sso', {}, deps())).rejects.toMatchObject({ status: 403 })
        await expect(resetLocalLink(sql, owner, 'svc', {}, deps())).rejects.toMatchObject({ status: 403 })
        await expect(resetLocalLink(sql, owner, 'off', {}, deps())).rejects.toMatchObject({ status: 403 })
        await expect(resetLocalLink(sql, manager, 'wide', {}, deps())).rejects.toMatchObject({
            status: 403,
            message: 'You cannot reset this account.'
        })
        const peer = await resetLocalLink(sql, manager, 'peer', {}, deps())
        expect(peer.link).toContain('#token=')
        await expect(resetLocalLink(sql, owner, 'ada', { link: false }, deps({ mail: false }))).rejects.toMatchObject({
            status: 400,
            message: MAIL_REQUIRED
        })
    })

    it('fails a reset that cannot be delivered, and emails one that can', async () => {
        const { sql, db } = memoryDb()
        db.exec(`
            INSERT INTO "user" (id, name, email, status) VALUES ('ada', 'Ada', 'ada@example.com', 'active');
            INSERT INTO organization_user ("organizationId", "userId", "roleId", status) VALUES ('${ORG}', 'ada', '${ROLE}', 'active');
            INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES ('${TEAM}', 'ada', '${ROLE}', 'active');
        `)
        await expect(resetLocalLink(sql, owner, 'ada', { link: false }, deps({ mail: false }))).rejects.toMatchObject({
            status: 400,
            message: MAIL_REQUIRED
        })
        expect(db.prepare('SELECT id FROM identity_action_link').all()).toEqual([])
        const sent: { to: string; subject: string; text: string }[] = []
        const mailed = await resetLocalLink(sql, owner, 'ada', { link: false }, deps({ mail: true, sent }))
        expect(mailed).toEqual({ mailed: true })
        expect(sent[0].to).toBe('ada@example.com')
        expect(sent[0].text).toContain('#token=')
        await expect(resetLocalLink(sql, owner, 'ada', { link: false }, deps({ mail: true, failMail: true }))).rejects.toMatchObject({
            status: 502,
            message: MAIL_FAILED
        })
    })

    it('marks only the reset token whose email failed', async () => {
        const { sql, db } = memoryDb()
        db.exec(`
            INSERT INTO "user" (id, name, email, status) VALUES ('ada', 'Ada', 'ada@example.com', 'active');
            INSERT INTO organization_user ("organizationId", "userId", "roleId", status) VALUES ('${ORG}', 'ada', '${ROLE}', 'active');
            INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES ('${TEAM}', 'ada', '${ROLE}', 'active');
            INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES ('team-2', 'ada', '${ROLE}', 'active');
        `)
        const kept = await resetLocalLink(sql, owner, 'ada', { link: true }, deps())
        const otherTeam: DirectoryActor = { ...owner, workspaceId: 'team-2' }
        await expect(resetLocalLink(sql, otherTeam, 'ada', { link: false }, deps({ mail: true, failMail: true }))).rejects.toMatchObject({
            status: 502,
            message: MAIL_FAILED
        })
        const rows = db.prepare('SELECT workspaceId, usedAt, consumeId FROM identity_action_link').all() as {
            workspaceId: string
            usedAt: string | null
            consumeId: string | null
        }[]
        expect(rows).toHaveLength(2)
        expect(rows.find((row) => row.workspaceId === TEAM)).toMatchObject({ usedAt: null, consumeId: null })
        expect(rows.find((row) => row.workspaceId === 'team-2')).toMatchObject({ consumeId: 'unsent' })
        expect(rows.find((row) => row.workspaceId === 'team-2')?.usedAt).toBeTruthy()
        const saved = await acceptLocalPassword(
            sql,
            { body: { token: tokenOf(kept.link || ''), password: GOOD }, query: {}, ip: '203.0.113.40', now: NOW },
            deps()
        )
        expect(saved).toMatchObject({ status: 200, body: { message: PASSWORD_SAVED } })
    })

    it('keeps the previous reset link when the email is not sent, and replaces it only after a send', async () => {
        const { sql, db } = memoryDb()
        db.exec(`
            INSERT INTO "user" (id, name, email, status) VALUES ('ada', 'Ada', 'ada@example.com', 'active');
            INSERT INTO organization_user ("organizationId", "userId", "roleId", status) VALUES ('${ORG}', 'ada', '${ROLE}', 'active');
            INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES ('${TEAM}', 'ada', '${ROLE}', 'active');
        `)
        const first = await resetLocalLink(sql, owner, 'ada', { link: true }, deps())
        await expect(resetLocalLink(sql, owner, 'ada', { link: false }, deps({ mail: true, failMail: true }))).rejects.toMatchObject({
            status: 502,
            message: MAIL_FAILED
        })
        const rows = db.prepare('SELECT consumeId, usedAt FROM identity_action_link').all() as {
            consumeId: string | null
            usedAt: string | null
        }[]
        expect(rows).toHaveLength(2)
        expect(rows.filter((row) => row.consumeId === 'superseded')).toEqual([])
        expect(rows.filter((row) => row.usedAt === null)).toHaveLength(1)
        expect(rows.filter((row) => row.consumeId === 'unsent')).toHaveLength(1)
        const still = await acceptLocalPassword(
            sql,
            { body: { token: tokenOf(first.link || ''), password: GOOD }, query: {}, ip: '203.0.113.44', now: NOW },
            deps()
        )
        expect(still).toMatchObject({ status: 200, body: { message: PASSWORD_SAVED } })

        db.exec(`
            INSERT INTO "user" (id, name, email, status) VALUES ('bea', 'Bea', 'bea@example.com', 'active');
            INSERT INTO organization_user ("organizationId", "userId", "roleId", status) VALUES ('${ORG}', 'bea', '${ROLE}', 'active');
            INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES ('${TEAM}', 'bea', '${ROLE}', 'active');
        `)
        const older = await resetLocalLink(sql, owner, 'bea', { link: true }, deps())
        const sent: { to: string; subject: string; text: string }[] = []
        const mailed = await resetLocalLink(sql, owner, 'bea', { link: false }, deps({ mail: true, sent }))
        expect(mailed).toEqual({ mailed: true })
        const replaced = await acceptLocalPassword(
            sql,
            { body: { token: tokenOf(older.link || ''), password: GOOD }, query: {}, ip: '203.0.113.45', now: NOW },
            deps()
        )
        expect(replaced).toMatchObject({ status: 400, body: { message: LINK_INVALID } })
        const link = sent[0].text.split('\n').find((line) => line.includes('#token=')) || ''
        const saved = await acceptLocalPassword(
            sql,
            { body: { token: tokenOf(link), password: GOOD }, query: {}, ip: '203.0.113.46', now: NOW },
            deps()
        )
        expect(saved).toMatchObject({ status: 200, body: { message: PASSWORD_SAVED } })
    })

    it('rejects a dropped SMTP session and a session that never replies', async () => {
        const crashes: unknown[] = []
        const onCrash = (error: unknown) => crashes.push(error)
        process.on('uncaughtException', onCrash)
        const message = { to: 'ada@example.com', subject: 'Set your Cuttlely password', text: 'Open this one-time link.\n' }
        const dropped = createServer((socket) => {
            socket.write('220 ready\r\n')
            socket.on('data', (buf) => {
                if (/^EHLO/i.test(buf.toString())) socket.write('250 hello\r\n')
                else socket.destroy()
            })
        })
        const silent = createServer((socket) => {
            socket.write('220 ready\r\n')
        })
        try {
            await new Promise<void>((resolve) => dropped.listen(0, '127.0.0.1', () => resolve()))
            await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()))
            const droppedPort = (dropped.address() as { port: number }).port
            const silentPort = (silent.address() as { port: number }).port
            const env = (port: number) => ({
                SMTP_HOST: '127.0.0.1',
                SMTP_PORT: String(port),
                SENDER_EMAIL: 'baker@example.com',
                SMTP_SECURE: 'false'
            })
            await expect(sendSmtp(message, env(droppedPort), 300)).rejects.toThrow('mail send failed')
            await expect(sendSmtp(message, env(silentPort), 200)).rejects.toThrow('mail send failed')
            await new Promise((resolve) => setImmediate(resolve))
            expect(crashes).toEqual([])
        } finally {
            process.off('uncaughtException', onCrash)
            dropped.close()
            silent.close()
        }
    })

    it('reads a MySQL expiry as UTC in Auckland and Los Angeles', () => {
        const server = join(__dirname, '..', '..')
        const script = `
            const { linkClock, linkDbTime } = require('./src/identity/actionLink')
            const issued = Date.parse('2026-10-15T03:00:00.000Z')
            const expires = issued + 60 * 60 * 1000
            const wall = linkDbTime('mysql', expires)
            const fromString = linkClock(wall, 'mysql')
            if (fromString !== expires) {
                console.error('string', process.env.TZ, wall, fromString, expires)
                process.exit(2)
            }
            const match = /^(\\d{4})-(\\d{2})-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2})$/.exec(wall)
            const driverDate = new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6])
            if (linkClock(driverDate, 'mysql') !== expires) {
                console.error('date', process.env.TZ, linkClock(driverDate, 'mysql'), expires)
                process.exit(3)
            }
            if (fromString <= issued) {
                console.error('expired', process.env.TZ)
                process.exit(4)
            }
            if (linkClock(new Date(expires), 'postgres') !== expires) process.exit(5)
            if (linkClock(linkDbTime('sqlite', expires), 'sqlite') !== expires) process.exit(6)
        `
        for (const tz of ['Pacific/Auckland', 'America/Los_Angeles']) {
            const result = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
                cwd: server,
                env: { ...process.env, TZ: tz },
                encoding: 'utf8'
            })
            if (result.status !== 0) throw new Error(`${tz}\n${result.stdout}\n${result.stderr}`)
            expect(result.status).toBe(0)
        }
    })

    it('reads an expiry returned as a Date or a number, and refuses an expired one', async () => {
        expect(linkDbTime('sqlite', NOW)).toBe(new Date(NOW).toISOString())
        expect(linkDbTime('postgres', NOW)).toEqual(new Date(NOW))
        expect(linkDbTime('mysql', NOW)).toBe('2026-10-15 00:00:00')
        expect(linkDbTime('mariadb', NOW)).toBe('2026-10-15 00:00:00')
        expect(String(linkDbTime('mysql', NOW))).not.toMatch(/[TZ]/)
        expect(linkClock(new Date(NOW))).toBe(NOW)
        expect(linkClock(NOW)).toBe(NOW)
        expect(linkClock(new Date(NOW).toISOString())).toBe(NOW)
        expect(linkClock('not-a-time')).toBe(0)
        expect(linkClock('2026-10-15 04:00:00', 'mysql')).toBe(Date.parse('2026-10-15T04:00:00.000Z'))
        expect(linkClock(new Date(2026, 9, 15, 4, 0, 0), 'mysql')).toBe(Date.parse('2026-10-15T04:00:00.000Z'))

        const { sql, db } = memoryDb()
        const created = await inviteAccount(sql, owner, { ...inviteBody(), link: true }, deps())
        const raw = tokenOf(created.link || '')
        const dated = dateReturning(sql)
        const expired = await acceptLocalPassword(
            dated,
            { body: { token: raw, password: GOOD }, query: {}, ip: '203.0.113.41', now: NOW + 72 * 60 * 60 * 1000 },
            deps()
        )
        expect(expired).toMatchObject({ status: 400, body: { message: LINK_INVALID } })
        expect(db.prepare('SELECT usedAt FROM identity_action_link').all()).toEqual([{ usedAt: null }])

        const numbered = numberReturning(sql)
        const stillExpired = await acceptLocalPassword(
            numbered,
            { body: { token: raw, password: GOOD }, query: {}, ip: '203.0.113.42', now: NOW + 72 * 60 * 60 * 1000 },
            deps()
        )
        expect(stillExpired).toMatchObject({ status: 400, body: { message: LINK_INVALID } })
        const fresh = await inviteAccount(sql, owner, { ...inviteBody('dated@example.com'), link: true }, deps())
        const saved = await acceptLocalPassword(
            dateReturning(sql),
            { body: { token: tokenOf(fresh.link || ''), password: GOOD }, query: {}, ip: '203.0.113.43', now: NOW },
            deps()
        )
        expect(saved).toMatchObject({ status: 200, body: { message: PASSWORD_SAVED } })
    })

    it('ends every local session only after a reset password is saved', async () => {
        const { sql, db } = memoryDb()
        db.exec(`
            INSERT INTO "user" (id, name, email, credential, status) VALUES ('ada', 'Ada', 'ada@example.com', 'old-hash', 'active');
            INSERT INTO organization_user ("organizationId", "userId", "roleId", status) VALUES ('${ORG}', 'ada', '${ROLE}', 'active');
            INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES ('${TEAM}', 'ada', '${ROLE}', 'active');
            INSERT INTO identity_local_session (id, userId, token, expiresAt, absoluteExpiresAt)
                VALUES ('sess-1', 'ada', 'digest-1', '2099-01-01', '2099-01-08');
            INSERT INTO identity_local_session (id, userId, token, expiresAt, absoluteExpiresAt)
                VALUES ('sess-2', 'ada', 'digest-2', '2099-01-01', '2099-01-08');
        `)
        const issued = await resetLocalLink(sql, owner, 'ada', {}, deps())
        expect(db.prepare('SELECT id FROM identity_local_session').all()).toHaveLength(2)
        const saved = await acceptLocalPassword(
            sql,
            { body: { token: tokenOf(issued.link || ''), password: GOOD }, query: {}, ip: '203.0.113.20', now: NOW },
            deps()
        )
        expect(saved).toMatchObject({ status: 200 })
        expect(db.prepare('SELECT id FROM identity_local_session').all()).toEqual([])
        const reasons = db
            .prepare('SELECT action FROM identity_action_audit')
            .all()
            .map((row) => row.action)
        expect(reasons).toEqual(expect.arrayContaining(['link_issued', 'token_consumed', 'password_set', 'sessions_revoked']))
        expect(dump(db)).not.toContain(tokenOf(issued.link || ''))
    })

    it('refuses a token after the user leaves that workspace', async () => {
        const { sql, db } = memoryDb()
        const created = await inviteAccount(sql, owner, { ...inviteBody(), link: true }, deps())
        db.exec(`DELETE FROM workspace_user WHERE "userId" != '${OWNER}'`)
        const refused = await acceptLocalPassword(
            sql,
            { body: { token: tokenOf(created.link || ''), password: GOOD }, query: {}, ip: '203.0.113.21', now: NOW },
            deps()
        )
        expect(refused).toMatchObject({ status: 400, body: { message: LINK_INVALID } })
        expect(JSON.stringify(refused)).not.toContain('ada@example.com')
    })

    it('rate limits repeated invalid tokens', async () => {
        const { sql } = memoryDb()
        const limit = new LoginRateLimit()
        const attempt = () =>
            acceptLocalPassword(
                sql,
                { body: { token: 'not-a-real-token', password: GOOD }, query: {}, ip: '203.0.113.30', now: NOW },
                deps({ rateLimit: limit })
            )
        for (let i = 0; i < 10; i += 1) expect(await attempt()).toMatchObject({ status: 400 })
        expect(await attempt()).toMatchObject({ status: 429, body: { message: TOO_MANY_LINKS } })
    })

    it('drops an expired or used link on the next issue', async () => {
        const { sql, db } = memoryDb()
        db.exec(`
            INSERT INTO identity_action_link (id, tokenHash, purpose, organizationId, workspaceId, userId, expiresAt, usedAt, createdBy, createdDate)
            VALUES ('old', 'abc', 'invite', '${ORG}', '${TEAM}', '${OWNER}', '2000-01-01T00:00:00.000Z', NULL, '${OWNER}', '2000-01-01T00:00:00.000Z');
        `)
        await inviteAccount(sql, owner, { ...inviteBody(), link: true }, deps())
        const ids = db
            .prepare('SELECT id FROM identity_action_link')
            .all()
            .map((row) => row.id)
        expect(ids).not.toContain('old')
    })

    it('does not treat SMTP host alone as the sign-in mail flag, and sends when both host and sender are set', async () => {
        expect(smtpReady({})).toBe(false)
        expect(smtpReady({ SMTP_HOST: 'smtp.example.com' })).toBe(false)
        expect(smtpReady({ SMTP_HOST: 'smtp.example.com', SENDER_EMAIL: 'baker@example.com' })).toBe(true)
        const messages: string[] = []
        const server = createServer((socket) => {
            socket.write('220 ready\r\n')
            socket.on('data', (buf) => {
                const line = buf.toString()
                messages.push(line)
                if (/^EHLO/i.test(line)) socket.write('250 hello\r\n')
                else if (/^MAIL/i.test(line)) socket.write('250 ok\r\n')
                else if (/^RCPT/i.test(line)) socket.write('250 ok\r\n')
                else if (/^DATA/i.test(line)) socket.write('354 go\r\n')
                else if (line.includes('\r\n.\r\n')) socket.write('250 queued\r\n')
                else if (/^QUIT/i.test(line)) {
                    socket.write('221 bye\r\n')
                    socket.end()
                } else socket.write('250 ok\r\n')
            })
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        await sendSmtp(
            { to: 'ada@example.com', subject: 'Set your Cuttlely password', text: 'Open this one-time link.\n' },
            { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SENDER_EMAIL: 'baker@example.com', SMTP_SECURE: 'false' }
        )
        server.close()
        expect(messages.join('')).toContain('ada@example.com')
        expect(messages.join('')).not.toContain('exampletoken')
    })

    it('migration creates the link and audit tables', async () => {
        const sql: string[] = []
        const runner = {
            connection: { options: { type: 'sqlite' } },
            async query(text: string) {
                sql.push(text)
                return []
            }
        }
        await addIdentityActionLinks(runner as never)
        expect(sql.some((line) => line.includes('identity_action_link'))).toBe(true)
        expect(sql.some((line) => line.includes('identity_action_audit'))).toBe(true)
        expect(sql.some((line) => line.includes('IDX_identity_action_link_token'))).toBe(true)
    })

    it('counts outcomes without storing an address', () => {
        const counts = actionLinkMetrics()
        expect(Object.keys(counts).sort()).toEqual(['accepted', 'expired', 'issued', 'resetFailed'])
        expect(JSON.stringify(counts)).not.toContain('@')
    })
})

describe('link routes', () => {
    afterEach(() => setTeamPermissionLookup(null))

    it('denies invite and reset without a session or without users:manage', async () => {
        setTeamPermissionLookup({
            async accessFor() {
                return { owner: false, permissions: ['chatflows:view'] }
            }
        })
        const users = express()
        users.use(express.json())
        users.use((req, _res, next) => {
            const header = req.header('x-test-user')
            if (header === 'member') {
                req.user = {
                    id: 'member-1',
                    activeOrganizationId: ORG,
                    activeWorkspaceId: TEAM,
                    permissions: ['chatflows:view']
                } as Express.User
            }
            next()
        })
        const account = express.Router()
        registerInvite(account)
        users.use('/users', identityUsersRouter)
        users.use('/account', account)
        const http = request(users)
        expect((await http.post('/users/ada/reset-link').send({})).status).toBe(401)
        expect((await http.post('/users/ada/reset-link').set('x-test-user', 'member').send({})).status).toBe(403)
        expect((await http.post('/account/invite').send({})).status).toBe(401)
        expect((await http.post('/account/invite').set('x-test-user', 'member').send({})).status).toBe(403)
        const whitelist = readFileSync(join(__dirname, '../utils/constants.ts'), 'utf8')
        expect(whitelist).toContain("'/api/v1/auth/local/accept'")
    })
})
