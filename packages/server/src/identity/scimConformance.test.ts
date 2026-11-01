/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { readFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import express from 'express'
import request from 'supertest'
import { resetAuthSecretsForTests } from './authSecrets'
import { deleteOrganizationUser, Sql } from './directory'

let activeSql: Sql
jest.mock('./production', () => ({ applicationSql: () => activeSql }))

import { createScimToken, identityScimRouter } from './scim'

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

interface FixtureRequest {
    name: string
    method: 'get' | 'post' | 'put' | 'patch' | 'delete'
    path: string
    body?: unknown
    capture?: string
    status: number
}

interface Fixture {
    source: string
    description: string
    requests: FixtureRequest[]
}

function memoryStore(): { sql: Sql; db: MemoryDatabase } {
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
        CREATE TABLE identity_scim_configuration (id integer primary key, organizationId text, activeTokenId text, previousTokenId text);
        INSERT INTO identity_scim_configuration (id) VALUES (1);
        CREATE TABLE identity_scim_token (
            id text primary key, organizationId text, tokenHmac text unique, displayPrefix text, status text,
            createdAt text, createdBy text, lastUsedAt text, overlapEndsAt text, revokedAt text
        );
        CREATE TABLE user (
            id text primary key, name text, email text unique, credential text, status text,
            externalId text, createdBy text, updatedBy text, createdDate text default CURRENT_TIMESTAMP,
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
        CREATE TABLE workspace (id text primary key, organizationId text, name text);
        CREATE TABLE workspace_user (
            workspaceId text, userId text, roleId text, status text, createdBy text, updatedBy text,
            primary key (workspaceId, userId)
        );
        CREATE TABLE identity_action_link (userId text, purpose text, usedAt text, consumeId text, organizationId text);
        CREATE TABLE identity_provider_link (providerKey text, subject text, userId text);
        CREATE TABLE identity_local_session (id text, userId text);
        CREATE TABLE apikey (id text, ownerUserId text, disabledAt text);
        CREATE TABLE identity_personal_token (id text, ownerUserId text, tokenHash text, disabledAt text);
        CREATE TABLE identity_scim_user (
            id text primary key, organizationId text, userId text unique, externalId text,
            userName text, normalizedUserName text, displayName text, givenName text, familyName text,
            workEmail text, deletedAt text, createdAt text, updatedAt text,
            unique (organizationId, normalizedUserName), unique (organizationId, externalId)
        );
        CREATE TABLE identity_scim_group (
            id text primary key, organizationId text, externalId text, displayName text, normalizedDisplayName text,
            deletedAt text, createdAt text, updatedAt text, unique (organizationId, externalId),
            unique (organizationId, normalizedDisplayName)
        );
        CREATE TABLE identity_scim_group_member (groupId text, scimUserId text, createdAt text, primary key (groupId, scimUserId));
        CREATE TABLE identity_scim_mapping (
            id text primary key, organizationId text, groupId text unique, workspaceId text, roleId text, createdAt text, createdBy text
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
        INSERT INTO role (id, name, permissions) VALUES ('role-member', 'member', '[]'), ('role-owner', 'owner', '["authentication:manage"]');
        INSERT INTO user (id, name, email, status, createdBy, updatedBy)
            VALUES ('owner-1', 'Owner', 'owner@example.com', 'active', 'owner-1', 'owner-1');
        INSERT INTO organization_user (organizationId, userId, roleId, status, createdBy, updatedBy)
            VALUES ('org-1', 'owner-1', 'role-owner', 'active', 'owner-1', 'owner-1');
    `)
    return { sql, db }
}

function app() {
    const server = express()
    server.use('/api/v1/scim/v2', identityScimRouter)
    return server
}

function replaceValues(value: unknown, captured: Record<string, string>): unknown {
    if (typeof value === 'string') {
        return Object.entries(captured).reduce((result, [key, replacement]) => result.replaceAll(`{{${key}}}`, replacement), value)
    }
    if (Array.isArray(value)) return value.map((item) => replaceValues(item, captured))
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, replaceValues(item, captured)])
        )
    }
    return value
}

function fixture(provider: 'okta' | 'entra'): Fixture {
    return JSON.parse(readFileSync(join(__dirname, 'scim', 'fixtures', provider, 'provisioning-sequence.json'), 'utf8')) as Fixture
}

describe('published SCIM request fixtures', () => {
    beforeAll(() => {
        process.env.TOKEN_HASH_SECRET = randomBytes(32).toString('hex')
        resetAuthSecretsForTests()
    })

    afterAll(() => {
        delete process.env.TOKEN_HASH_SECRET
        resetAuthSecretsForTests()
    })

    it.each(['okta', 'entra'] as const)('replays the %s sequence against the router', async (provider) => {
        const { sql, db } = memoryStore()
        activeSql = sql
        const token = await createScimToken(sql, { id: 'owner-1', organizationId: 'org-1' })
        const captured: Record<string, string> = {}
        let internalUserId = ''
        let supportedUserFields: Record<string, unknown> | undefined
        for (const step of fixture(provider).requests) {
            const path = replaceValues(step.path, captured) as string
            const body = replaceValues(step.body, captured)
            let call = request(app())[step.method](`/api/v1/scim/v2${path}`).set('Authorization', `Bearer ${token.clear}`)
            if (step.body !== undefined) call = call.set('Content-Type', 'application/scim+json').send(body as object)
            const response = await call
            expect({ name: step.name, status: response.status }).toEqual({ name: step.name, status: step.status })
            expect(response.headers['x-correlation-id']).toEqual(expect.any(String))
            if (step.capture) captured[step.capture] = response.body.id
            if (step.capture === 'userId') {
                supportedUserFields = {
                    userName: response.body.userName,
                    externalId: response.body.externalId,
                    displayName: response.body.displayName,
                    name: response.body.name,
                    emails: response.body.emails,
                    active: response.body.active
                }
                internalUserId = String(db.prepare('SELECT userId FROM identity_scim_user WHERE id = ?').get(response.body.id)?.userId)
                db.prepare('INSERT INTO identity_local_session VALUES (?, ?)').run(`${provider}-session`, internalUserId)
                db.prepare('INSERT INTO apikey VALUES (?, ?, NULL)').run(`${provider}-key`, internalUserId)
                db.prepare('INSERT INTO identity_personal_token VALUES (?, ?, ?, NULL)').run(
                    `${provider}-personal`,
                    internalUserId,
                    'stored-digest'
                )
                const at = new Date().toISOString()
                db.prepare('INSERT INTO workspace VALUES (?, ?, ?)').run(`${provider}-team`, 'org-1', `${provider} fixture team`)
                db.prepare('INSERT INTO identity_scim_group VALUES (?, ?, ?, ?, ?, NULL, ?, ?)').run(
                    `${provider}-mapped-group`,
                    'org-1',
                    `${provider}-mapped-external`,
                    `${provider} mapped group`,
                    `${provider} mapped group`,
                    at,
                    at
                )
                db.prepare('INSERT INTO identity_scim_group_member VALUES (?, ?, ?)').run(`${provider}-mapped-group`, response.body.id, at)
                db.prepare('INSERT INTO identity_scim_mapping VALUES (?, ?, ?, ?, ?, ?, ?)').run(
                    `${provider}-mapping`,
                    'org-1',
                    `${provider}-mapped-group`,
                    `${provider}-team`,
                    'role-member',
                    at,
                    'owner-1'
                )
                db.prepare('INSERT INTO workspace_user VALUES (?, ?, ?, ?, ?, ?)').run(
                    `${provider}-team`,
                    internalUserId,
                    'role-member',
                    'active',
                    'owner-1',
                    'owner-1'
                )
                db.prepare('INSERT INTO identity_scim_assignment VALUES (?, ?, ?, ?, ?)').run(
                    `${provider}-mapping`,
                    internalUserId,
                    `${provider}-team`,
                    'role-member',
                    at
                )
            }
            if (step.name === 'connection probe') expect(response.body).toMatchObject({ totalResults: 0, Resources: [] })
            if (step.name.startsWith('ignore ')) expect(response.body).toMatchObject(supportedUserFields || {})
            if (step.name === 'list groups without members') {
                expect(response.body.Resources[0]).not.toHaveProperty('members')
            }
            if (step.name.includes('add group member') || step.name.includes('add members array')) {
                expect(
                    db.prepare('SELECT COUNT(*) AS count FROM identity_scim_group_member WHERE groupId = ?').get(captured.groupId)
                ).toMatchObject({
                    count: 1
                })
            }
            if (step.name.includes('remove selected group member') || step.name.includes('remove members array')) {
                expect(
                    db.prepare('SELECT COUNT(*) AS count FROM identity_scim_group_member WHERE groupId = ?').get(captured.groupId)
                ).toMatchObject({
                    count: 0
                })
            }
        }
        expect(db.prepare('SELECT COUNT(*) AS count FROM identity_local_session WHERE userId = ?').get(internalUserId)).toMatchObject({
            count: 0
        })
        expect(db.prepare('SELECT disabledAt FROM apikey WHERE ownerUserId = ?').get(internalUserId)).toMatchObject({
            disabledAt: expect.any(String)
        })
        expect(db.prepare('SELECT disabledAt FROM identity_personal_token WHERE ownerUserId = ?').get(internalUserId)).toMatchObject({
            disabledAt: expect.any(String)
        })
        expect(db.prepare('SELECT COUNT(*) AS count FROM identity_scim_assignment WHERE userId = ?').get(internalUserId)).toMatchObject({
            count: 0
        })
        expect(db.prepare('SELECT COUNT(*) AS count FROM workspace_user WHERE userId = ?').get(internalUserId)).toMatchObject({ count: 0 })
        if (provider === 'okta') {
            expect(db.prepare('SELECT deletedAt FROM identity_scim_group WHERE id = ?').get(captured.groupId)).toMatchObject({
                deletedAt: expect.any(String)
            })
        } else {
            expect(db.prepare('SELECT deletedAt FROM identity_scim_user WHERE id = ?').get(captured.userId)).toMatchObject({
                deletedAt: expect.any(String)
            })
        }
        db.close()
    })
})

describe('RFC 7644 route conformance', () => {
    let db: MemoryDatabase
    let bearer: string

    beforeAll(async () => {
        process.env.TOKEN_HASH_SECRET = randomBytes(32).toString('hex')
        resetAuthSecretsForTests()
        const store = memoryStore()
        activeSql = store.sql
        db = store.db
        bearer = (await createScimToken(activeSql, { id: 'owner-1', organizationId: 'org-1' })).clear
    })

    afterAll(() => {
        db.close()
        delete process.env.TOKEN_HASH_SECRET
        resetAuthSecretsForTests()
    })

    const authorized = () => request(app())

    it('authenticates before parsing and records parser errors in SCIM form', async () => {
        const unauthenticated = await request(app())
            .post('/api/v1/scim/v2/Users')
            .set('Content-Type', 'application/scim+json')
            .send('{"userName":')
        expect(unauthenticated.status).toBe(401)
        expect(unauthenticated.headers['x-correlation-id']).toEqual(expect.any(String))

        const malformed = await authorized()
            .post('/api/v1/scim/v2/Users')
            .set('Authorization', `Bearer ${bearer}`)
            .set('Content-Type', 'application/scim+json')
            .send('{"userName":')
        expect(malformed.status).toBe(400)
        expect(malformed.body).toMatchObject({ status: '400', scimType: 'invalidSyntax' })
        expect(malformed.headers['x-correlation-id']).toEqual(expect.any(String))

        const oversized = await authorized()
            .post('/api/v1/scim/v2/Users')
            .set('Authorization', `Bearer ${bearer}`)
            .set('Content-Type', 'application/scim+json')
            .send(JSON.stringify({ userName: `${'x'.repeat(300_000)}@example.com` }))
        expect(oversized.status).toBe(413)
        expect(oversized.body).toMatchObject({ status: '413' })
        expect(oversized.headers['x-correlation-id']).toEqual(expect.any(String))

        await new Promise((resolve) => setImmediate(resolve))
        const parserErrors = db
            .prepare("SELECT category, detail FROM identity_scim_diagnostic WHERE outcome = 'failed' ORDER BY completedAt DESC")
            .all()
        expect(parserErrors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ category: 'request', detail: 'The JSON request body is invalid.' }),
                expect.objectContaining({ category: 'request', detail: 'The SCIM request body is too large.' })
            ])
        )
        expect(JSON.stringify(parserErrors)).not.toContain('x'.repeat(100))
    })

    it('records parsed failed user mutations under their operation categories', async () => {
        const failedUpdate = await authorized()
            .put('/api/v1/scim/v2/Users/10000000-0000-4000-8000-000000000010')
            .set('Authorization', `Bearer ${bearer}`)
            .send({ userName: 'missing-update@example.test', displayName: 'Missing Update' })
        expect(failedUpdate.status).toBe(404)
        const failedDeactivation = await authorized()
            .patch('/api/v1/scim/v2/Users/10000000-0000-4000-8000-000000000011')
            .set('Authorization', `Bearer ${bearer}`)
            .send({ Operations: [{ op: 'Replace', path: 'active', value: false }] })
        expect(failedDeactivation.status).toBe(404)

        await new Promise((resolve) => setImmediate(resolve))
        const category = (correlationId: string) =>
            db.prepare('SELECT category FROM identity_scim_diagnostic WHERE correlationId = ?').get(correlationId)
        expect(category(String(failedUpdate.headers['x-correlation-id']))).toMatchObject({ category: 'usersUpdated' })
        expect(category(String(failedDeactivation.headers['x-correlation-id']))).toMatchObject({ category: 'usersDisabled' })
    })

    it('serves discovery documents and rejects unsupported operations in SCIM envelopes', async () => {
        const resourceTypes = await authorized().get('/api/v1/scim/v2/ResourceTypes').set('Authorization', `Bearer ${bearer}`)
        expect(resourceTypes.status).toBe(200)
        expect(resourceTypes.body.Resources.map((item: { id: string }) => item.id)).toEqual(['User', 'Group'])
        const schemas = await authorized().get('/api/v1/scim/v2/Schemas').set('Authorization', `Bearer ${bearer}`)
        expect(schemas.body.totalResults).toBe(2)
        const bulk = await authorized()
            .post('/api/v1/scim/v2/Bulk')
            .set('Authorization', `Bearer ${bearer}`)
            .type('application/scim+json')
            .send({})
        expect(bulk.status).toBe(501)
        expect(bulk.body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error'])
        const unsupported = await authorized()
            .post('/api/v1/scim/v2/ServiceProviderConfig')
            .set('Authorization', `Bearer ${bearer}`)
            .type('application/scim+json')
            .send({})
        expect(unsupported.status).toBe(501)
    })

    it('enforces authentication and content type and includes correlation ids on errors', async () => {
        const unauthenticated = await authorized().get('/api/v1/scim/v2/Users')
        expect(unauthenticated.status).toBe(401)
        expect(unauthenticated.headers['x-correlation-id']).toEqual(expect.any(String))
        expect(unauthenticated.body.detail).toContain(unauthenticated.headers['x-correlation-id'])
        const media = await authorized()
            .post('/api/v1/scim/v2/Users')
            .set('Authorization', `Bearer ${bearer}`)
            .type('text/plain')
            .send('{}')
        expect(media.status).toBe(415)
    })

    it.each([
        ['filter', '/api/v1/scim/v2/Users?filter=a&filter=b'],
        ['attributes', '/api/v1/scim/v2/Users?attributes=x&attributes=y']
    ])('returns invalidValue for a repeated %s query parameter', async (_name, path) => {
        const response = await authorized().get(path).set('Authorization', `Bearer ${bearer}`)
        expect(response.status).toBe(400)
        expect(response.body).toMatchObject({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
            status: '400',
            scimType: 'invalidValue'
        })
    })

    it('creates a new resource after SCIM deletion and direct organization removal', async () => {
        const userName = 'reprovisioned@example.test'
        const externalId = 'directory-user-17'
        const created = await authorized()
            .post('/api/v1/scim/v2/Users')
            .set('Authorization', `Bearer ${bearer}`)
            .type('application/scim+json')
            .send({ userName, externalId })
        expect(created.status).toBe(201)
        const oldResourceId = String(created.body.id)
        const oldUserId = String(db.prepare('SELECT userId FROM identity_scim_user WHERE id = ?').get(oldResourceId)?.userId)

        const deleted = await authorized().delete(`/api/v1/scim/v2/Users/${oldResourceId}`).set('Authorization', `Bearer ${bearer}`)
        expect(deleted.status).toBe(204)

        const at = '2026-11-01T12:00:00.000Z'
        db.prepare('INSERT INTO identity_scim_group VALUES (?, ?, ?, ?, ?, NULL, ?, ?)').run(
            'leftover-group',
            'org-1',
            'leftover-group-external',
            'Leftover Group',
            'leftover group',
            at,
            at
        )
        db.prepare('INSERT INTO identity_scim_group_member VALUES (?, ?, ?)').run('leftover-group', oldResourceId, at)
        db.prepare('INSERT INTO workspace VALUES (?, ?, ?)').run('leftover-team', 'org-1', 'Leftover Team')
        db.prepare('INSERT INTO identity_scim_mapping VALUES (?, ?, ?, ?, ?, ?, ?)').run(
            'leftover-mapping',
            'org-1',
            'leftover-group',
            'leftover-team',
            'role-member',
            at,
            'owner-1'
        )
        db.prepare('INSERT INTO identity_scim_assignment VALUES (?, ?, ?, ?, ?)').run(
            'leftover-mapping',
            oldUserId,
            'leftover-team',
            'role-member',
            at
        )

        await deleteOrganizationUser(
            activeSql,
            { id: 'owner-1', organizationId: 'org-1', workspaceId: null, owner: true },
            'org-1',
            oldUserId
        )
        expect(db.prepare('SELECT id FROM identity_scim_user WHERE id = ?').get(oldResourceId)).toBeUndefined()
        expect(db.prepare('SELECT groupId FROM identity_scim_group_member WHERE scimUserId = ?').get(oldResourceId)).toBeUndefined()
        expect(db.prepare('SELECT mappingId FROM identity_scim_assignment WHERE userId = ?').get(oldUserId)).toBeUndefined()

        const recreated = await authorized()
            .post('/api/v1/scim/v2/Users')
            .set('Authorization', `Bearer ${bearer}`)
            .type('application/scim+json')
            .send({ userName, externalId })
        expect(recreated.status).toBe(201)
        expect(recreated.body.id).not.toBe(oldResourceId)
        expect(db.prepare('SELECT userId FROM identity_scim_user WHERE id = ?').get(recreated.body.id)?.userId).not.toBe(oldUserId)
    })

    it('covers filtering, pagination, patch paths, idempotency, conflicts, membership, and deactivation', async () => {
        const create = (name: string, externalId: string) =>
            authorized()
                .post('/api/v1/scim/v2/Users')
                .set('Authorization', `Bearer ${bearer}`)
                .type('application/scim+json')
                .send({ userName: name, externalId, active: true })
        const first = await create('first@example.com', 'first-id')
        const second = await create('second@example.com', 'second-id')
        expect([first.status, second.status]).toEqual([201, 201])
        const conflict = await create('first@example.com', 'another-id')
        expect(conflict.status).toBe(409)
        const page = await authorized()
            .get(
                '/api/v1/scim/v2/Users?filter=externalId%20eq%20%22first-id%22%20or%20externalId%20eq%20%22second-id%22&startIndex=2&count=1'
            )
            .set('Authorization', `Bearer ${bearer}`)
        expect(page.body).toMatchObject({ totalResults: 2, startIndex: 2, itemsPerPage: 1 })
        const invalid = await authorized()
            .get('/api/v1/scim/v2/Users?filter=emails%20eq%20%22first%40example.com%22')
            .set('Authorization', `Bearer ${bearer}`)
        expect(invalid.status).toBe(400)
        expect(invalid.body.scimType).toBe('invalidFilter')

        const group = await authorized()
            .post('/api/v1/scim/v2/Groups')
            .set('Authorization', `Bearer ${bearer}`)
            .type('application/scim+json')
            .send({ displayName: 'Conformance Group', externalId: 'group-id', members: [{ value: first.body.id }] })
        expect(group.status).toBe(201)
        const repeated = await authorized()
            .post('/api/v1/scim/v2/Groups')
            .set('Authorization', `Bearer ${bearer}`)
            .type('application/scim+json')
            .send({ displayName: 'Conformance Group', externalId: 'group-id', members: [{ value: first.body.id }] })
        expect(repeated.status).toBe(409)
        const replace = await authorized()
            .patch(`/api/v1/scim/v2/Groups/${group.body.id}`)
            .set('Authorization', `Bearer ${bearer}`)
            .type('application/scim+json')
            .send({
                schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
                Operations: [{ op: 'Replace', path: 'members', value: [{ value: second.body.id }] }]
            })
        expect(replace.body.members).toEqual([expect.objectContaining({ value: second.body.id })])
        const disabled = await authorized()
            .patch(`/api/v1/scim/v2/Users/${second.body.id}`)
            .set('Authorization', `Bearer ${bearer}`)
            .type('application/scim+json')
            .send({
                Operations: [
                    { op: 'Replace', path: 'active', value: 'False' },
                    { op: 'Add', path: 'title', value: 'Engineer' }
                ]
            })
        expect(disabled.status).toBe(200)
        expect(disabled.body.active).toBe(false)
    })
})
