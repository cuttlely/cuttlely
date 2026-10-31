/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import type { DataSource, QueryRunner } from 'typeorm'
import type { IdentityStore } from './store'
import type { UserRow } from './types'
import type { OidcConfiguration } from './oidcStore'
import { addOidcProvider } from './schemaMigration'
import { oidcFailureLogDetail, oidcLinkAuditDetail } from './auditLog'
import {
    consumeOidcTransaction,
    createOidcTransaction,
    createProviderLink,
    findProviderLink,
    isEntraAuthorityIssuer,
    migrateLegacyProviderLinks,
    oidcConfigurationFingerprint,
    oidcProviderKey,
    providerLinkMigrationComplete,
    readOidcConfiguration,
    recordOidcTestFailure,
    recordOidcTestResult,
    resolveOidcUser,
    saveOidcDraft,
    testedOidcDraftDiffersFromActive,
    validatedOidcIssuer
} from './oidcStore'

const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
        exec(sql: string): void
        close(): void
        prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[]; run(...params: unknown[]): unknown }
    }
}

function database(): { source: DataSource; rows(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>; close(): void } {
    const db = new DatabaseSync(':memory:')
    db.exec(`
        CREATE TABLE "user" (id text PRIMARY KEY, email text, "externalId" text, status text);
        CREATE TABLE identity_authentication_switch_stage (id text PRIMARY KEY);
    `)
    let active = false
    const run = async (sql: string, params: unknown[] = []) => {
        const statement = db.prepare(sql)
        if (/^\s*(select|pragma|with)\b/i.test(sql)) return statement.all(...params)
        statement.run(...params)
        return []
    }
    const runner = {
        connection: { options: { type: 'sqlite' } },
        connect: async () => undefined,
        release: async () => undefined,
        query: run,
        startTransaction: async () => {
            db.exec('BEGIN IMMEDIATE')
            active = true
        },
        commitTransaction: async () => {
            db.exec('COMMIT')
            active = false
        },
        rollbackTransaction: async () => {
            db.exec('ROLLBACK')
            active = false
        },
        get isTransactionActive() {
            return active
        }
    } as unknown as QueryRunner
    const source = { options: { type: 'sqlite' }, createQueryRunner: () => runner, query: run } as unknown as DataSource
    return { source, rows: run, close: () => db.close() }
}

interface CapturedCall {
    sql: string
    params: unknown[]
}

function capturedSource(
    type: 'mysql' | 'mariadb',
    answer: (sql: string, params: unknown[]) => unknown = () => []
): { source: DataSource; calls: CapturedCall[] } {
    const calls: CapturedCall[] = []
    let active = false
    const runner = {
        connection: { options: { type } },
        connect: async () => undefined,
        release: async () => undefined,
        async query(sql: string, params: unknown[] = []) {
            calls.push({ sql, params })
            return answer(sql, params)
        },
        startTransaction: async () => {
            active = true
        },
        commitTransaction: async () => {
            active = false
        },
        rollbackTransaction: async () => {
            active = false
        },
        get isTransactionActive() {
            return active
        }
    } as unknown as QueryRunner
    return {
        source: { options: { type }, createQueryRunner: () => runner } as unknown as DataSource,
        calls
    }
}

function user(id: string, email: string, status = 'active'): UserRow {
    return { id, email, name: email.split('@')[0], externalId: null, credential: null, status }
}

function store(users: UserRow[], accepted: 'accepted' | 'invalid' = 'invalid'): IdentityStore {
    return {
        countUsers: async () => users.length,
        findUsersByEmail: async (email: string) => users.filter((candidate) => candidate.email.toLowerCase() === email.toLowerCase()),
        sessionFor: async (id: string) => {
            const found = users.find((candidate) => candidate.id === id)
            return found ? ({ id: found.id, email: found.email, name: found.name, status: found.status, workspaceId: null } as never) : null
        },
        acceptInvite: async () => accepted,
        createOwner: async () => {
            throw new Error('not used')
        }
    } as unknown as IdentityStore
}

describe('provider-scoped identity links', () => {
    describe.each(['mysql', 'mariadb'] as const)('%s statements', (dialect) => {
        it('locks and consumes an authorization transaction once', async () => {
            const db = capturedSource(dialect, (sql) => {
                if (sql.startsWith('SELECT `envelope`')) {
                    return [[{ envelope: 'sealed-envelope', expiresAt: new Date(11_000), consumedAt: null }], []]
                }
                return { affectedRows: 1 }
            })

            await expect(consumeOidcTransaction(db.source, 'state-hash', 2_000)).resolves.toBe('sealed-envelope')
            const select = db.calls.find((call) => call.sql.startsWith('SELECT `envelope`'))
            expect(select?.sql).toContain('FROM `identity_oidc_transaction` WHERE `stateHash` = ? FOR UPDATE')
            expect(select?.params).toEqual(['state-hash'])
            const update = db.calls.find((call) => call.sql.startsWith('UPDATE `identity_oidc_transaction`'))
            expect(update?.sql).toContain('SET `consumedAt` = ? WHERE `stateHash` = ? AND `consumedAt` IS NULL')
            expect(update?.params[1]).toBe('state-hash')
        })

        it('uses MySQL-family upserts for legacy links and their migration marker', async () => {
            let providerReads = 0
            const db = capturedSource(dialect, (sql) => {
                if (sql.includes('FROM `user` WHERE `externalId` IS NOT NULL')) {
                    return [[{ id: 'user-1', email: 'ada@example.com', externalId: 'subject-1' }], []]
                }
                if (sql.startsWith('SELECT * FROM `identity_provider_link_migration`')) return [[], []]
                if (sql.includes('FROM `identity_provider_link` WHERE `providerKey` = ? AND `subject` = ?')) {
                    providerReads += 1
                    return providerReads === 1 ? [[], []] : [[{ userId: 'user-1' }], []]
                }
                return { affectedRows: 1 }
            })

            await expect(
                migrateLegacyProviderLinks(db.source, {
                    activeMethod: 'workos',
                    providerKey: 'workos-provider',
                    warningKind: null
                })
            ).resolves.toEqual({ complete: true, migrated: 1, inert: 0, error: null })

            const link = db.calls.find(
                (call) => call.sql.startsWith('INSERT INTO `identity_provider_link`') && call.sql.includes('ON DUPLICATE KEY UPDATE')
            )
            expect(link?.sql).toContain('ON DUPLICATE KEY UPDATE `providerKey` = `providerKey`')
            const marker = db.calls.find((call) => call.sql.startsWith('INSERT INTO `identity_provider_link_migration`'))
            expect(marker?.sql).toContain('ON DUPLICATE KEY UPDATE `providerKey` = VALUES(`providerKey`)')
            expect(marker?.sql).toContain('`completedAt` = VALUES(`completedAt`)')
        })
    })

    it('keeps the exact trimmed issuer including a trailing slash', () => {
        expect(validatedOidcIssuer('  https://id.example/tenant/  ')).toBe('https://id.example/tenant/')
        expect(validatedOidcIssuer('https://id.example/tenant/?query=no')).toBeNull()
    })

    it('consumes a cross-process sign-in transaction once', async () => {
        const db = database()
        await addOidcProvider(db.source.createQueryRunner())
        await createOidcTransaction(db.source, 'state-hash', 'encrypted-envelope', 1_000, 11_000)
        await expect(consumeOidcTransaction(db.source, 'state-hash', 2_000)).resolves.toBe('encrypted-envelope')
        await expect(consumeOidcTransaction(db.source, 'state-hash', 2_001)).resolves.toBeNull()
        db.close()
    })

    it('stores only the client-secret environment variable name and enforces optimistic concurrency', async () => {
        const db = database()
        await addOidcProvider(db.source.createQueryRunner())
        const input = {
            issuer: 'https://id.example',
            clientId: 'client',
            clientSecretEnvVar: 'OIDC_CLIENT_SECRET',
            trustMissingEmailVerification: false,
            privateIssuerHosts: [],
            fingerprint: oidcConfigurationFingerprint({
                issuer: 'https://id.example',
                clientId: 'client',
                clientSecretEnvVar: 'OIDC_CLIENT_SECRET',
                trustMissingEmailVerification: false,
                privateIssuerHosts: []
            }),
            discovery: null,
            health: 'unchecked' as const,
            healthError: null,
            checkedAt: null
        }
        const saved = await saveOidcDraft(db.source, input, 0)
        expect(saved).toMatchObject({ version: 1, clientSecretEnvVar: 'OIDC_CLIENT_SECRET' })
        await expect(saveOidcDraft(db.source, input, 0)).rejects.toThrow('OIDC_CONFIG_CHANGED')
        expect(await readOidcConfiguration(db.source, 'draft')).toMatchObject({ fingerprint: input.fingerprint, version: 1 })
        expect(JSON.stringify(await db.rows('SELECT * FROM identity_oidc_configuration'))).not.toContain('client-secret-value')
        db.close()
    })

    it('migrates legacy subjects once and preserves their original field', async () => {
        const db = database()
        const runner = db.source.createQueryRunner()
        await addOidcProvider(runner)
        await runner.query('INSERT INTO "user" (id, email, "externalId", status) VALUES (?, ?, ?, ?)', [
            'user-1',
            'Ada@Example.com',
            'subject-1',
            'active'
        ])
        const first = await migrateLegacyProviderLinks(db.source, {
            activeMethod: 'workos',
            providerKey: 'workos-provider',
            warningKind: null
        })
        const second = await migrateLegacyProviderLinks(db.source, {
            activeMethod: 'workos',
            providerKey: 'workos-provider',
            warningKind: null
        })
        expect(first).toEqual({ complete: true, migrated: 1, inert: 0, error: null })
        expect(second).toEqual({ complete: true, migrated: 1, inert: 0, error: null })
        expect(await findProviderLink(db.source, 'workos-provider', 'subject-1')).toMatchObject({
            userId: 'user-1',
            emailAtLink: 'ada@example.com',
            assuranceBasis: 'workos_legacy'
        })
        expect(await db.rows('SELECT "externalId" AS value FROM "user"')).toEqual([{ value: 'subject-1' }])
        expect(await providerLinkMigrationComplete(db.source)).toBe(true)
        db.close()
    })

    it('keeps the legacy migration marker stable after OIDC activation', async () => {
        const db = database()
        const runner = db.source.createQueryRunner()
        await addOidcProvider(runner)
        await runner.query('INSERT INTO "user" (id, email, "externalId", status) VALUES (?, ?, ?, ?)', [
            'user-1',
            'ada@example.com',
            'subject-1',
            'active'
        ])
        await migrateLegacyProviderLinks(db.source, {
            activeMethod: 'workos',
            providerKey: 'workos-provider',
            warningKind: null
        })
        const before = await db.rows('SELECT * FROM identity_provider_link_migration')

        await expect(
            migrateLegacyProviderLinks(db.source, { activeMethod: 'oidc', providerKey: 'oidc-provider', warningKind: null })
        ).resolves.toEqual({ complete: true, migrated: 1, inert: 0, error: null })
        expect(await db.rows('SELECT * FROM identity_provider_link_migration')).toEqual(before)
        db.close()
    })

    it('pauses legacy migration when the provider fingerprint requires review', async () => {
        const db = database()
        const runner = db.source.createQueryRunner()
        await addOidcProvider(runner)
        await runner.query('INSERT INTO "user" (id, email, "externalId", status) VALUES (?, ?, ?, ?)', [
            'user-1',
            'ada@example.com',
            'subject-1',
            'active'
        ])
        const result = await migrateLegacyProviderLinks(db.source, {
            activeMethod: 'workos',
            providerKey: 'workos-provider',
            warningKind: 'workos-client-mismatch'
        })
        expect(result.complete).toBe(false)
        expect(await findProviderLink(db.source, 'workos-provider', 'subject-1')).toBeNull()
        expect(await providerLinkMigrationComplete(db.source)).toBe(false)
        db.close()
    })

    it('records unattributable legacy WorkOS subjects as inert without blocking OIDC', async () => {
        const db = database()
        const runner = db.source.createQueryRunner()
        await addOidcProvider(runner)
        await runner.query('INSERT INTO "user" (id, email, "externalId", status) VALUES (?, ?, ?, ?)', [
            'user-1',
            'ada@example.com',
            'workos-subject',
            'active'
        ])
        await expect(
            migrateLegacyProviderLinks(db.source, { activeMethod: 'local', providerKey: null, warningKind: null })
        ).resolves.toEqual({
            complete: true,
            migrated: 0,
            inert: 1,
            error: null
        })
        expect(await providerLinkMigrationComplete(db.source)).toBe(true)
        expect(await db.rows('SELECT "inertCount" AS value FROM identity_provider_link_migration')).toEqual([{ value: 1 }])
        db.close()
    })

    it('uses a durable subject link before profile email and refuses duplicate subjects', async () => {
        const db = database()
        await addOidcProvider(db.source.createQueryRunner())
        const users = [user('user-1', 'ada@example.com')]
        expect(
            await createProviderLink(db.source, {
                providerKey: 'provider',
                subject: 'subject',
                userId: 'user-1',
                emailAtLink: 'ada@example.com',
                assuranceBasis: 'email_verified'
            })
        ).toBe('linked')
        expect(
            await createProviderLink(db.source, {
                providerKey: 'provider',
                subject: 'subject',
                userId: 'other',
                emailAtLink: 'other@example.com',
                assuranceBasis: 'email_verified'
            })
        ).toBe('conflict')
        await expect(
            resolveOidcUser(
                db.source,
                store(users),
                { providerKey: 'provider', subject: 'subject', issuer: 'https://id.example' },
                { trustMissing: false }
            )
        ).resolves.toMatchObject({ ok: true, user: { id: 'user-1' }, basis: 'email_verified' })
        db.close()
    })

    it.each([
        ['verified email', { emailVerified: true }, false, 'email_verified'],
        ['Entra domain ownership', { xmsEdov: true }, false, 'xms_edov'],
        ['trusted absent claim', {}, true, 'issuer_trusted']
    ])('links one active mailbox using %s', async (_name, claims, trustMissing, basis) => {
        const db = database()
        await addOidcProvider(db.source.createQueryRunner())
        const issuer = basis === 'xms_edov' ? 'https://login.microsoftonline.com/tenant/v2.0' : 'https://id.example'
        await expect(
            resolveOidcUser(
                db.source,
                store([user('user-1', 'ada@example.com')]),
                { providerKey: 'provider', subject: `subject-${basis}`, issuer, email: 'Ada@Example.com', ...claims },
                { trustMissing }
            )
        ).resolves.toMatchObject({ ok: true, basis })
        db.close()
    })

    it('checks an active mailbox without creating its subject link', async () => {
        const db = database()
        await addOidcProvider(db.source.createQueryRunner())
        await expect(
            resolveOidcUser(
                db.source,
                store([user('user-1', 'ada@example.com')]),
                {
                    providerKey: 'provider',
                    subject: 'subject',
                    issuer: 'https://id.example',
                    email: 'ada@example.com',
                    emailVerified: true
                },
                { trustMissing: false, linkIdentity: false }
            )
        ).resolves.toMatchObject({ ok: true, user: { id: 'user-1' }, basis: 'email_verified' })
        await expect(findProviderLink(db.source, 'provider', 'subject')).resolves.toBeNull()
        db.close()
    })

    it.each(['login.microsoftonline.com', 'login.microsoftonline.us', 'login.chinacloudapi.cn', 'login.partner.microsoftonline.cn'])(
        'accepts xms_edov from the HTTPS Entra authority host %s',
        async (host) => {
            const db = database()
            await addOidcProvider(db.source.createQueryRunner())
            await expect(
                resolveOidcUser(
                    db.source,
                    store([user('user-1', 'ada@example.com')]),
                    {
                        providerKey: `provider-${host}`,
                        subject: `subject-${host}`,
                        issuer: `https://${host}/tenant/v2.0`,
                        email: 'ada@example.com',
                        xmsEdov: true
                    },
                    { trustMissing: false }
                )
            ).resolves.toMatchObject({ ok: true, basis: 'xms_edov' })
            db.close()
        }
    )

    it.each(['https://login.microsoftonline.com.example/tenant', 'http://login.microsoftonline.com/tenant'])(
        'does not accept xms_edov from %s',
        async (issuer) => {
            const db = database()
            await addOidcProvider(db.source.createQueryRunner())
            await expect(
                resolveOidcUser(
                    db.source,
                    store([user('user-1', 'ada@example.com')]),
                    { providerKey: 'provider', subject: 'subject', issuer, email: 'ada@example.com', xmsEdov: true },
                    { trustMissing: false }
                )
            ).resolves.toMatchObject({ ok: false, reason: 'email_not_assured' })
            db.close()
        }
    )

    it('keeps explicit email_verified=false authoritative for an Entra authority', async () => {
        const db = database()
        await addOidcProvider(db.source.createQueryRunner())
        await expect(
            resolveOidcUser(
                db.source,
                store([user('user-1', 'ada@example.com')]),
                {
                    providerKey: 'provider',
                    subject: 'subject',
                    issuer: 'https://login.microsoftonline.us/tenant',
                    email: 'ada@example.com',
                    emailVerified: false,
                    xmsEdov: true
                },
                { trustMissing: true }
            )
        ).resolves.toMatchObject({ ok: false, reason: 'email_not_assured' })
        db.close()
    })

    it('matches Entra authorities by HTTPS host only', () => {
        expect(isEntraAuthorityIssuer('https://login.partner.microsoftonline.cn/tenant')).toBe(true)
        expect(isEntraAuthorityIssuer('https://login.partner.microsoftonline.cn.example/tenant')).toBe(false)
        expect(isEntraAuthorityIssuer('http://login.partner.microsoftonline.cn/tenant')).toBe(false)
    })

    it.each([
        ['explicit false', [user('user-1', 'ada@example.com')], { emailVerified: false }, true, 'email_not_assured'],
        [
            'a present malformed assurance claim',
            [user('user-1', 'ada@example.com')],
            { emailVerificationPresent: true },
            true,
            'email_not_assured'
        ],
        ['missing assurance', [user('user-1', 'ada@example.com')], {}, false, 'email_not_assured'],
        [
            'ambiguous mailbox',
            [user('user-1', 'ada@example.com'), user('user-2', 'ada@example.com')],
            { emailVerified: true },
            false,
            'ambiguous'
        ],
        ['inactive user', [user('user-1', 'ada@example.com', 'disabled')], { emailVerified: true }, false, 'inactive']
    ])('refuses %s', async (_name, users, claims, trustMissing, reason) => {
        const db = database()
        await addOidcProvider(db.source.createQueryRunner())
        await expect(
            resolveOidcUser(
                db.source,
                store(users),
                { providerKey: 'provider', subject: 'subject', issuer: 'https://id.example', email: 'ada@example.com', ...claims },
                { trustMissing }
            )
        ).resolves.toMatchObject({ ok: false, reason })
        db.close()
    })

    it('refuses an invitation with an explicit false verification claim before consuming it', async () => {
        const db = database()
        await addOidcProvider(db.source.createQueryRunner())
        const acceptInvite = jest.fn(async () => 'accepted' as const)
        const pending = store([user('user-1', 'ada@example.com', 'invited')]) as IdentityStore
        pending.acceptInvite = acceptInvite
        await expect(
            resolveOidcUser(
                db.source,
                pending,
                {
                    providerKey: 'provider',
                    subject: 'subject',
                    issuer: 'https://id.example',
                    email: 'ada@example.com',
                    emailVerified: false
                },
                { trustMissing: true, invitationToken: 'one-time-token' }
            )
        ).resolves.toMatchObject({ ok: false, reason: 'email_not_assured' })
        expect(acceptInvite).not.toHaveBeenCalled()
        db.close()
    })

    it('passes the first-owner provider link into the owner transaction', async () => {
        const db = database()
        await addOidcProvider(db.source.createQueryRunner())
        const created = user('owner-1', 'owner@example.com')
        const createOwner = jest.fn(async () => created)
        const empty = store([]) as IdentityStore
        empty.createOwner = createOwner
        await expect(
            resolveOidcUser(
                db.source,
                empty,
                {
                    providerKey: 'provider',
                    subject: 'subject',
                    issuer: 'https://id.example',
                    email: 'owner@example.com',
                    emailVerified: true
                },
                { trustMissing: false, bootstrapEmail: 'OWNER@example.com', now: 42 }
            )
        ).resolves.toMatchObject({ ok: true, user: { id: 'owner-1' }, basis: 'email_verified' })
        expect(createOwner).toHaveBeenCalledWith(expect.objectContaining({ email: 'owner@example.com', externalId: null }), {
            now: 42,
            providerLink: {
                providerKey: 'provider',
                subject: 'subject',
                emailAtLink: 'owner@example.com',
                assuranceBasis: 'email_verified'
            }
        })
        db.close()
    })

    it('derives stable identities and includes only specified configuration fields in its fingerprint', () => {
        const base = {
            issuer: 'https://id.example',
            clientId: 'client',
            clientSecretEnvVar: 'OIDC_CLIENT_SECRET',
            trustMissingEmailVerification: false,
            privateIssuerHosts: []
        }
        expect(oidcConfigurationFingerprint(base)).not.toBe(
            oidcConfigurationFingerprint({ ...base, clientSecretEnvVar: 'OTHER_CLIENT_SECRET' })
        )
        expect(oidcConfigurationFingerprint(base)).not.toBe(oidcConfigurationFingerprint({ ...base, privateIssuerHosts: ['127.0.0.1'] }))
        expect(oidcConfigurationFingerprint({ ...base, privateIssuerHosts: ['EXAMPLE.internal.', '127.0.0.1'] })).toBe(
            oidcConfigurationFingerprint({ ...base, privateIssuerHosts: ['127.0.0.1', 'example.internal'] })
        )
        expect(oidcProviderKey('installation-a', base.issuer, base.clientId)).not.toBe(
            oidcProviderKey('installation-b', base.issuer, base.clientId)
        )
    })

    it('reports only a ready, tested runtime snapshot change', () => {
        const active: OidcConfiguration = {
            slot: 'active',
            issuer: 'https://id.example',
            clientId: 'client',
            clientSecretEnvVar: 'OIDC_CLIENT_SECRET',
            trustMissingEmailVerification: false,
            privateIssuerHosts: [],
            fingerprint: 'fingerprint',
            discovery: { authorization_endpoint: 'https://id.example/old' },
            health: 'ready',
            healthError: null,
            checkedAt: '2026-10-30T12:00:00.000Z',
            testedFingerprint: 'fingerprint',
            testedAt: '2026-10-30T12:00:00.000Z',
            testResult: null,
            version: 1
        }
        const draft: OidcConfiguration = {
            ...active,
            slot: 'draft',
            checkedAt: '2026-10-31T12:00:00.000Z',
            testedAt: '2026-10-31T12:00:00.000Z',
            testResult: { identityAccepted: true },
            version: 2
        }
        expect(testedOidcDraftDiffersFromActive(draft, active)).toBe(false)
        expect(
            testedOidcDraftDiffersFromActive({ ...draft, discovery: { authorization_endpoint: 'https://id.example/refreshed' } }, active)
        ).toBe(true)
        expect(testedOidcDraftDiffersFromActive({ ...draft, testedFingerprint: null }, active)).toBe(false)
        expect(testedOidcDraftDiffersFromActive({ ...draft, testResult: null }, active)).toBe(false)
    })

    it('clears the tested fingerprint when an identity test fails', async () => {
        const db = database()
        await addOidcProvider(db.source.createQueryRunner())
        const saved = await saveOidcDraft(
            db.source,
            {
                issuer: 'https://id.example',
                clientId: 'client',
                clientSecretEnvVar: 'OIDC_CLIENT_SECRET',
                trustMissingEmailVerification: false,
                privateIssuerHosts: [],
                fingerprint: 'fingerprint',
                discovery: {},
                health: 'ready',
                healthError: null,
                checkedAt: '2026-10-31T12:00:00.000Z'
            },
            0
        )
        await recordOidcTestResult(db.source, saved.fingerprint, { identityAccepted: true })
        expect((await readOidcConfiguration(db.source, 'draft'))?.testedFingerprint).toBe(saved.fingerprint)

        await recordOidcTestFailure(db.source, saved.fingerprint, { passed: false, reason: 'No matching user.' })
        const failed = await readOidcConfiguration(db.source, 'draft')
        expect(failed?.testedFingerprint).toBeNull()
        expect(failed?.testResult).toEqual({ passed: false, reason: 'No matching user.' })
        db.close()
    })

    it('keeps authorization and token material out of logs and audit detail', () => {
        const detail = oidcLinkAuditDetail({
            issuer: 'https://id.example',
            subject: 'subject',
            matchedUser: 'user-1',
            basis: 'email_verified',
            outcome: 'linked'
        })
        const serialized = JSON.stringify(detail)
        for (const value of ['authorization-code', 'pkce-verifier', 'client-secret-value', 'bearer-access-token']) {
            expect(serialized).not.toContain(value)
        }
        expect(detail).toEqual({
            issuer: 'https://id.example',
            subject: 'subject',
            matchedUser: 'user-1',
            basis: 'email_verified',
            outcome: 'linked'
        })

        const failure = Object.assign(new Error('authorization-code pkce-verifier client-secret-value bearer-access-token'), {
            name: 'OidcError',
            category: 'response',
            code: 'authorization-code',
            verifier: 'pkce-verifier',
            accessToken: 'bearer-access-token'
        })
        expect(JSON.stringify(oidcFailureLogDetail(failure))).toBe('{"category":"response","kind":"OidcError"}')
    })
})
