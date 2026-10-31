/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */

let mockDataSource: import('typeorm').DataSource
let mockSql: import('./directory').Sql
let mockStore: import('./sqlStore').SqlIdentityStore
let mockNow = Date.parse('2026-10-31T12:00:00.000Z')
let mockBuildContext: (req: import('express').Request) => Promise<import('./handlers').AuthContext>

jest.mock('./production', () => ({
    applicationDataSource: () => mockDataSource,
    applicationSql: () => mockSql,
    identityStore: () => mockStore,
    buildAuthContext: (req: import('express').Request) => mockBuildContext(req),
    refreshAuthenticationView: async () => undefined
}))
jest.mock('../utils/logger', () => {
    const quiet = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), verbose: jest.fn() }
    return { __esModule: true, default: quiet }
})

import cookieParser from 'cookie-parser'
import express, { Request } from 'express'
import request from 'supertest'
import type { DataSource, QueryRunner } from 'typeorm'
import { LOCAL_SESSION_COOKIE } from './constants'
import { sqlFromDataSource } from './directory'
import { identityAuthenticationRouter, resetAuthenticationRouteLimitsForTests } from './authenticationRoutes'
import { refreshAuthenticationState } from './authenticationState'
import { identityAuthRouter } from './http'
import { hashPassword } from './password'
import { LoginRateLimit } from './rateLimit'
import { setTeamPermissionLookup } from './rbac'
import {
    addAuditLog,
    addAuthenticationState,
    addAuthenticationSwitchStage,
    addIdentityLoginGuards,
    addIdentitySignIn,
    addLocalDirectory,
    addSessionConvergence,
    addWorkosSessionId
} from './schemaMigration'
import { SqlIdentityStore } from './sqlStore'
import type { AuthContext } from './handlers'
import type { WorkosPort } from './types'

const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
        exec(sql: string): void
        close(): void
        prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[]; run(...params: unknown[]): unknown }
    }
}

const OWNER = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION = '22222222-2222-4222-8222-222222222222'
const WORKSPACE = '33333333-3333-4333-8333-333333333333'
const OWNER_ROLE = '44444444-4444-4444-8444-444444444444'
const MEMBER_ROLE = '55555555-5555-4555-8555-555555555555'
const OWNER_EMAIL = 'owner@maple-lab.example'
const OWNER_PASSWORD = 'Maple-Lab-42!'

type TestDatabase = {
    close(): void
    run(statement: string, params?: unknown[]): Promise<Record<string, unknown>[]>
}

function workosPort(): WorkosPort {
    return {
        authorizationUrl: () => 'https://identity.example/authorize',
        authenticate: async () => {
            throw new Error('not used')
        },
        authenticateSession: async () => ({ authenticated: false, reason: 'not used' }),
        refresh: async () => ({ authenticated: false, reason: 'not used' }),
        logoutUrl: async () => 'https://identity.example/logout',
        setExternalId: async () => undefined
    }
}

async function openDatabase(): Promise<TestDatabase> {
    const database = new DatabaseSync(':memory:')
    database.exec(`
        CREATE TABLE organization (id text PRIMARY KEY, name varchar(100));
        CREATE TABLE "user" (
            id text PRIMARY KEY, name varchar(100), email varchar(255) UNIQUE, credential text, status varchar(20),
            "externalId" varchar(255), "createdDate" datetime, "updatedDate" datetime
        );
        CREATE TABLE role (
            id text PRIMARY KEY, "organizationId" text, name varchar(100), description text, permissions text,
            "createdDate" datetime, "updatedDate" datetime
        );
        CREATE TABLE workspace (id text PRIMARY KEY, name varchar(100), "organizationId" text);
        CREATE TABLE organization_user (
            "organizationId" text, "userId" text, "roleId" text, status varchar(20), PRIMARY KEY ("organizationId", "userId")
        );
        CREATE TABLE workspace_user (
            "workspaceId" text, "userId" text, "roleId" text, status varchar(20), "lastLogin" datetime,
            PRIMARY KEY ("workspaceId", "userId")
        );
        CREATE TABLE apikey (id text PRIMARY KEY);
    `)
    const run = async (statement: string, params: unknown[] = []) => {
        const values = params.map((value) => (value instanceof Date ? value.getTime() : value))
        const prepared = database.prepare(statement)
        if (/^\s*(select|with|pragma)\b/i.test(statement)) return prepared.all(...values)
        prepared.run(...values)
        return []
    }
    const runner = (): QueryRunner => {
        let transaction = false
        return {
            connection: { options: { type: 'sqlite' } },
            connect: async () => undefined,
            release: async () => undefined,
            query: run,
            hasColumn: async (table: string, column: string) => {
                const columns = await run(`PRAGMA table_info("${table.replace(/"/g, '""')}")`)
                return columns.some((entry) => entry.name === column)
            },
            startTransaction: async () => {
                database.exec('BEGIN')
                transaction = true
            },
            commitTransaction: async () => {
                database.exec('COMMIT')
                transaction = false
            },
            rollbackTransaction: async () => {
                database.exec('ROLLBACK')
                transaction = false
            },
            get isTransactionActive() {
                return transaction
            }
        } as unknown as QueryRunner
    }
    mockDataSource = {
        options: { type: 'sqlite' },
        createQueryRunner: runner,
        query: run
    } as unknown as DataSource
    const setup = runner()
    await addIdentitySignIn(setup)
    await addIdentityLoginGuards(setup)
    await addLocalDirectory(setup)
    await addAuditLog(setup)
    await addAuthenticationState(setup)
    await addAuthenticationSwitchStage(setup)
    await addSessionConvergence(setup)
    await addWorkosSessionId(setup)
    const credential = await hashPassword(OWNER_PASSWORD)
    await run(
        `INSERT INTO organization (id, name) VALUES (?, ?),
         (?, ?)`,
        [ORGANIZATION, 'Maple Lab', '99999999-9999-4999-8999-999999999999', 'Unused Lab']
    )
    await run(
        `INSERT INTO "user" (id, name, email, credential, status, "createdDate", "updatedDate") VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        [OWNER, 'Test Owner', OWNER_EMAIL, credential, mockNow, mockNow]
    )
    await run(
        `INSERT INTO role (id, "organizationId", name, description, permissions, "createdDate", "updatedDate")
         VALUES (?, ?, 'owner', '', '[]', ?, ?), (?, NULL, 'member', '', '["authentication:manage"]', ?, ?)`,
        [OWNER_ROLE, ORGANIZATION, mockNow, mockNow, MEMBER_ROLE, mockNow, mockNow]
    )
    await run(`INSERT INTO workspace (id, name, "organizationId") VALUES (?, 'Maple Workspace', ?)`, [WORKSPACE, ORGANIZATION])
    await run(`INSERT INTO organization_user ("organizationId", "userId", "roleId", status) VALUES (?, ?, ?, 'active')`, [
        ORGANIZATION,
        OWNER,
        OWNER_ROLE
    ])
    await run(`INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES (?, ?, ?, 'active')`, [
        WORKSPACE,
        OWNER,
        MEMBER_ROLE
    ])
    await run(
        `INSERT INTO identity_authentication_state
         (id, "installationId", "activeMethod", "authenticationEpoch", "authenticationBaselineEpoch", "configurationFingerprint",
          "providerKey", warning, "sessionsEnded", "changedAt", "inferredAt", version)
         VALUES (1, 'integration-installation', 'oidc', 7, 1, 'oidc-fingerprint', 'oidc-provider', NULL, 0, ?, ?, 4)`,
        [mockNow, mockNow]
    )
    await run(`INSERT INTO identity_session_convergence (id, "cutoffAt") VALUES (1, ?)`, [mockNow - 60_000])
    mockSql = sqlFromDataSource(mockDataSource)
    mockStore = new SqlIdentityStore(mockDataSource)
    await refreshAuthenticationState(mockDataSource, true)
    return { close: () => database.close(), run }
}

function cookieValue(response: request.Response): string {
    const header = response.headers['set-cookie'] as unknown as string[] | undefined
    const cookie = header?.find((value) => value.startsWith(`${LOCAL_SESSION_COOKIE}=`))
    expect(cookie).toBeDefined()
    return String(cookie).split(';', 1)[0]
}

function application() {
    const server = express()
    server.use(express.json())
    server.use(cookieParser())
    server.use((req, _res, next) => {
        req.user = {
            id: OWNER,
            activeOrganizationId: ORGANIZATION,
            activeWorkspaceId: WORKSPACE,
            permissions: []
        }
        next()
    })
    server.use('/api/v1/auth', identityAuthRouter)
    server.use('/api/v1/authentication', identityAuthenticationRouter)
    return server
}

describe('OIDC owner recovery method switching', () => {
    let database: TestDatabase
    const savedLocalUsers = process.env.CUTTLELY_LOCAL_USERS
    const savedTokenHashSecret = process.env.TOKEN_HASH_SECRET

    beforeEach(async () => {
        await resetAuthenticationRouteLimitsForTests()
        mockNow = Date.now()
        process.env.CUTTLELY_LOCAL_USERS = 'true'
        process.env.TOKEN_HASH_SECRET = 'made-up-test-auth-state-secret'
        database = await openDatabase()
        const limiter = new LoginRateLimit(5)
        mockBuildContext = async (raw: Request): Promise<AuthContext> => ({
            dataSource: mockDataSource,
            authenticationEpoch: 7,
            activeAuthenticationMethod: 'oidc',
            workosConfigured: false,
            localAdmin: true,
            localUsers: true,
            oidcActive: true,
            oidcSessionSecure: false,
            cookiePasswordOk: false,
            sealedWorkosSessionsAccepted: false,
            secure: false,
            now: mockNow,
            ip: '192.0.2.40',
            socketAddress: '192.0.2.40',
            internal: raw.headers['x-request-from'] === 'internal',
            body: (raw.body || {}) as Record<string, unknown>,
            cookies: (raw.cookies || {}) as Record<string, string | undefined>,
            store: mockStore,
            workos: workosPort(),
            rateLimit: limiter,
            recoveryRateLimit: limiter,
            noteRecoveryAttempt: async () => undefined,
            raiseRecoveryAlert: async () => undefined
        })
        setTeamPermissionLookup({ accessFor: async () => ({ owner: true, permissions: [] }) })
    })

    afterEach(() => {
        setTeamPermissionLookup(null)
        database?.close()
    })

    afterAll(() => {
        if (savedLocalUsers === undefined) delete process.env.CUTTLELY_LOCAL_USERS
        else process.env.CUTTLELY_LOCAL_USERS = savedLocalUsers
        if (savedTokenHashSecret === undefined) delete process.env.TOKEN_HASH_SECRET
        else process.env.TOKEN_HASH_SECRET = savedTokenHashSecret
    })

    it('allows an owner recovery session to stage and apply a switch while OIDC is active', async () => {
        const server = application()
        const login = await request(server)
            .post('/api/v1/auth/recovery/login')
            .set('x-request-from', 'internal')
            .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD })
        expect(login.status).toBe(200)
        const cookie = cookieValue(login)

        const staged = await request(server)
            .post('/api/v1/authentication/stage')
            .set('Cookie', cookie)
            .send({ method: 'local', version: 4 })
        expect(staged.status).toBe(200)

        const applied = await request(server).post('/api/v1/authentication/apply').set('Cookie', cookie).send({
            stage: staged.body.stage,
            stageVersion: staged.body.stageVersion,
            method: 'local',
            stateVersion: 4,
            confirm: 'END SESSIONS'
        })
        expect(applied.status).toBe(200)
        expect(applied.body).toMatchObject({ applied: true, activeMethod: 'local', authenticationEpoch: 8 })
    })

    it('refuses staging with an owner recovery session older than ten minutes', async () => {
        const server = application()
        const login = await request(server)
            .post('/api/v1/auth/recovery/login')
            .set('x-request-from', 'internal')
            .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD })
        expect(login.status).toBe(200)
        const cookie = cookieValue(login)
        await database.run(`UPDATE identity_local_session SET "createdDate" = ?`, [mockNow - 10 * 60 * 1000 - 1])

        const staged = await request(server)
            .post('/api/v1/authentication/stage')
            .set('Cookie', cookie)
            .send({ method: 'local', version: 4 })
        expect(staged.status).toBe(409)
        expect(staged.body).toEqual({ code: 'REAUTH_REQUIRED', message: 'Sign in again before changing the sign-in method.' })
    })
})
