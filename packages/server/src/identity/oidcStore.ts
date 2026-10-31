/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { createHash } from 'crypto'
import type { DataSource, QueryRunner } from 'typeorm'
import { mailboxKey } from './link'
import type { IdentityStore } from './store'
import type { UserRow } from './types'
import { NotEmptyError } from './types'

export type OidcConfigurationSlot = 'draft' | 'active'

export interface OidcConfiguration {
    slot: OidcConfigurationSlot
    issuer: string
    clientId: string
    clientSecretEnvVar: string
    trustMissingEmailVerification: boolean
    privateIssuerHosts: string[]
    fingerprint: string
    discovery: Record<string, unknown> | null
    health: 'unchecked' | 'ready' | 'error'
    healthError: string | null
    checkedAt: string | null
    testedFingerprint: string | null
    testedAt: string | null
    testResult: Record<string, unknown> | null
    version: number
}

export interface ProviderLink {
    providerKey: string
    subject: string
    userId: string
    emailAtLink: string | null
    assuranceBasis: string
    createdAt: string
}

export interface ProviderLinkMigrationStatus {
    complete: boolean
    migrated: number
    inert: number
    error: string | null
}

const ENTRA_AUTHORITY_HOSTS = new Set([
    'login.microsoftonline.com',
    'login.microsoftonline.us',
    'login.chinacloudapi.cn',
    'login.partner.microsoftonline.cn'
])

export function isEntraAuthorityIssuer(issuer: string): boolean {
    try {
        const parsed = new URL(issuer)
        return parsed.protocol === 'https:' && ENTRA_AUTHORITY_HOSTS.has(parsed.hostname.toLowerCase())
    } catch {
        return false
    }
}

export function validatedOidcIssuer(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const issuer = value.trim()
    if (!issuer) return null
    try {
        const parsed = new URL(issuer)
        if (parsed.search || parsed.hash || parsed.username || parsed.password) return null
        return issuer
    } catch {
        return null
    }
}

type Dialect = 'sqlite' | 'postgres' | 'mysql' | 'mariadb'

function dialect(runner: QueryRunner): Dialect {
    const value = runner.connection.options.type
    return value === 'postgres' || value === 'mysql' || value === 'mariadb' ? value : 'sqlite'
}

function q(d: Dialect, name: string): string {
    return d === 'mysql' || d === 'mariadb' ? '`' + name.replace(/`/g, '``') + '`' : '"' + name.replace(/"/g, '""') + '"'
}

async function query(runner: QueryRunner, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    let index = 0
    const text = dialect(runner) === 'postgres' ? sql.replace(/\?/g, () => `$${++index}`) : sql
    const result = await runner.query(text, params)
    if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0])) return result[0]
    return Array.isArray(result) ? result : []
}

function cell(row: Record<string, unknown>, name: string): unknown {
    const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    return key ? row[key] : undefined
}

function dateValue(runner: QueryRunner, at: number): Date | number {
    return dialect(runner) === 'sqlite' ? at : new Date(at)
}

function iso(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null
    const numeric = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
    const date = new Date(numeric as string | number | Date)
    return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function parseJson<T>(value: unknown, fallback: T): T {
    if (typeof value !== 'string' || !value) return fallback
    try {
        return JSON.parse(value) as T
    } catch {
        return fallback
    }
}

function fromConfiguration(row: Record<string, unknown>): OidcConfiguration {
    return {
        slot: String(cell(row, 'slot')) as OidcConfigurationSlot,
        issuer: String(cell(row, 'issuer') || ''),
        clientId: String(cell(row, 'clientId') || ''),
        clientSecretEnvVar: String(cell(row, 'clientSecretEnvVar') || ''),
        trustMissingEmailVerification: Boolean(
            Number(cell(row, 'trustMissingEmailVerification')) || cell(row, 'trustMissingEmailVerification') === true
        ),
        privateIssuerHosts: parseJson(cell(row, 'privateIssuerHosts'), []),
        fingerprint: String(cell(row, 'fingerprint') || ''),
        discovery: parseJson<Record<string, unknown> | null>(cell(row, 'discovery'), null),
        health: String(cell(row, 'health') || 'unchecked') as OidcConfiguration['health'],
        healthError: cell(row, 'healthError') ? String(cell(row, 'healthError')) : null,
        checkedAt: iso(cell(row, 'checkedAt')),
        testedFingerprint: cell(row, 'testedFingerprint') ? String(cell(row, 'testedFingerprint')) : null,
        testedAt: iso(cell(row, 'testedAt')),
        testResult: parseJson<Record<string, unknown> | null>(cell(row, 'testResult'), null),
        version: Number(cell(row, 'version') || 1)
    }
}

export function oidcConfigurationFingerprint(input: {
    issuer: string
    clientId: string
    clientSecretEnvVar: string
    trustMissingEmailVerification: boolean
    privateIssuerHosts: string[]
}): string {
    const privateIssuerHosts = [
        ...new Set(
            input.privateIssuerHosts
                .map((host) =>
                    host
                        .trim()
                        .toLowerCase()
                        .replace(/^\[|\]$/g, '')
                        .replace(/\.+$/, '')
                )
                .filter(Boolean)
        )
    ].sort()
    return createHash('sha256')
        .update(
            `oidc-config-v2\n${input.issuer}\n${input.clientId}\n${input.clientSecretEnvVar}\n${
                input.trustMissingEmailVerification ? 'true' : 'false'
            }\n${privateIssuerHosts.join('\n')}`
        )
        .digest('hex')
}

function canonicalJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalJson)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, canonicalJson(entry)])
    )
}

export function oidcRuntimeConfigurationDigest(
    input: Pick<
        OidcConfiguration,
        | 'issuer'
        | 'clientId'
        | 'clientSecretEnvVar'
        | 'trustMissingEmailVerification'
        | 'privateIssuerHosts'
        | 'fingerprint'
        | 'discovery'
        | 'health'
        | 'healthError'
    >
): string {
    return createHash('sha256')
        .update(
            JSON.stringify(
                canonicalJson({
                    issuer: input.issuer,
                    clientId: input.clientId,
                    clientSecretEnvVar: input.clientSecretEnvVar,
                    trustMissingEmailVerification: input.trustMissingEmailVerification,
                    privateIssuerHosts: input.privateIssuerHosts,
                    fingerprint: input.fingerprint,
                    discovery: input.discovery,
                    health: input.health,
                    healthError: input.healthError
                })
            )
        )
        .digest('hex')
}

export function testedOidcDraftDiffersFromActive(draft: OidcConfiguration | null, active: OidcConfiguration | null): boolean {
    if (!draft || draft.health !== 'ready' || draft.testedFingerprint !== draft.fingerprint) return false
    return !active || oidcRuntimeConfigurationDigest(draft) !== oidcRuntimeConfigurationDigest(active)
}

export function oidcProviderKey(installationId: string, issuer: string, clientId: string): string {
    const identity = createHash('sha256').update(`oidc-provider-v1\n${issuer}\n${clientId}`).digest('hex')
    return createHash('sha256').update(`oidc\n${installationId}\n${identity}`).digest('hex')
}

export async function readOidcConfiguration(dataSource: DataSource, slot: OidcConfigurationSlot): Promise<OidcConfiguration | null> {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    try {
        const d = dialect(runner)
        const rows = await query(runner, `SELECT * FROM ${q(d, 'identity_oidc_configuration')} WHERE ${q(d, 'slot')} = ?`, [slot])
        return rows[0] ? fromConfiguration(rows[0]) : null
    } finally {
        await runner.release()
    }
}

export async function saveOidcDraft(
    dataSource: DataSource,
    input: Omit<OidcConfiguration, 'slot' | 'testedFingerprint' | 'testedAt' | 'testResult' | 'version'>,
    expectedVersion: number
): Promise<OidcConfiguration> {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    try {
        const d = dialect(runner)
        const locked = d === 'sqlite' ? '' : ' FOR UPDATE'
        const rows = await query(runner, `SELECT * FROM ${q(d, 'identity_oidc_configuration')} WHERE ${q(d, 'slot')} = ?${locked}`, [
            'draft'
        ])
        const current = rows[0] ? fromConfiguration(rows[0]) : null
        if ((current?.version || 0) !== expectedVersion) throw new Error('OIDC_CONFIG_CHANGED')
        const nextVersion = expectedVersion + 1
        const params = [
            input.issuer,
            input.clientId,
            input.clientSecretEnvVar,
            input.trustMissingEmailVerification ? 1 : 0,
            JSON.stringify(input.privateIssuerHosts),
            input.fingerprint,
            input.discovery ? JSON.stringify(input.discovery) : null,
            input.health,
            input.healthError,
            input.checkedAt ? dateValue(runner, new Date(input.checkedAt).getTime()) : null,
            nextVersion
        ]
        if (current) {
            await query(
                runner,
                `UPDATE ${q(d, 'identity_oidc_configuration')} SET ${q(d, 'issuer')} = ?, ${q(d, 'clientId')} = ?, ${q(
                    d,
                    'clientSecretEnvVar'
                )} = ?, ${q(d, 'trustMissingEmailVerification')} = ?, ${q(d, 'privateIssuerHosts')} = ?, ${q(d, 'fingerprint')} = ?, ${q(
                    d,
                    'discovery'
                )} = ?, ${q(d, 'health')} = ?, ${q(d, 'healthError')} = ?, ${q(d, 'checkedAt')} = ?, ${q(
                    d,
                    'testedFingerprint'
                )} = NULL, ${q(d, 'testedAt')} = NULL, ${q(d, 'testResult')} = NULL, ${q(d, 'version')} = ? WHERE ${q(
                    d,
                    'slot'
                )} = 'draft'`,
                params
            )
        } else {
            await query(
                runner,
                `INSERT INTO ${q(d, 'identity_oidc_configuration')} (${q(d, 'slot')}, ${q(d, 'issuer')}, ${q(d, 'clientId')}, ${q(
                    d,
                    'clientSecretEnvVar'
                )}, ${q(d, 'trustMissingEmailVerification')}, ${q(d, 'privateIssuerHosts')}, ${q(d, 'fingerprint')}, ${q(
                    d,
                    'discovery'
                )}, ${q(d, 'health')}, ${q(d, 'healthError')}, ${q(d, 'checkedAt')}, ${q(d, 'testedFingerprint')}, ${q(d, 'testedAt')}, ${q(
                    d,
                    'testResult'
                )}, ${q(d, 'version')}) VALUES ('draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
                params
            )
        }
        await runner.commitTransaction()
        return (await readOidcConfiguration(dataSource, 'draft')) as OidcConfiguration
    } catch (error) {
        if (runner.isTransactionActive) await runner.rollbackTransaction()
        if (/unique|duplicate|23505/i.test(error instanceof Error ? error.message : String(error))) {
            throw new Error('OIDC_CONFIG_CHANGED')
        }
        throw error
    } finally {
        await runner.release()
    }
}

export async function recordOidcTestResult(
    dataSource: DataSource,
    fingerprint: string,
    result: Record<string, unknown>,
    now = Date.now()
): Promise<void> {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    try {
        const d = dialect(runner)
        await query(
            runner,
            `UPDATE ${q(d, 'identity_oidc_configuration')} SET ${q(d, 'testedFingerprint')} = ?, ${q(d, 'testedAt')} = ?, ${q(
                d,
                'testResult'
            )} = ?, ${q(d, 'version')} = ${q(d, 'version')} + 1 WHERE ${q(d, 'slot')} = 'draft' AND ${q(d, 'fingerprint')} = ?`,
            [fingerprint, dateValue(runner, now), JSON.stringify(result), fingerprint]
        )
    } finally {
        await runner.release()
    }
}

export async function createOidcTransaction(
    dataSource: DataSource,
    stateHash: string,
    envelope: string,
    createdAt: number,
    expiresAt: number
): Promise<void> {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    try {
        const d = dialect(runner)
        await query(runner, `DELETE FROM ${q(d, 'identity_oidc_transaction')} WHERE ${q(d, 'expiresAt')} <= ?`, [
            dateValue(runner, createdAt)
        ])
        await query(
            runner,
            `INSERT INTO ${q(d, 'identity_oidc_transaction')} (${q(d, 'stateHash')}, ${q(d, 'envelope')}, ${q(d, 'createdAt')}, ${q(
                d,
                'expiresAt'
            )}, ${q(d, 'consumedAt')}) VALUES (?, ?, ?, ?, NULL)`,
            [stateHash, envelope, dateValue(runner, createdAt), dateValue(runner, expiresAt)]
        )
    } finally {
        await runner.release()
    }
}

export async function consumeOidcTransaction(dataSource: DataSource, stateHash: string, now = Date.now()): Promise<string | null> {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    if (dialect(runner) === 'sqlite') {
        await runner.query('BEGIN IMMEDIATE')
        try {
            const rows = await query(
                runner,
                `SELECT ${q('sqlite', 'envelope')} AS ${q('sqlite', 'envelope')}, ${q('sqlite', 'expiresAt')} AS ${q(
                    'sqlite',
                    'expiresAt'
                )}, ${q('sqlite', 'consumedAt')} AS ${q('sqlite', 'consumedAt')} FROM ${q('sqlite', 'identity_oidc_transaction')} WHERE ${q(
                    'sqlite',
                    'stateHash'
                )} = ?`,
                [stateHash]
            )
            const row = rows[0]
            const expiresAt = row ? new Date(cell(row, 'expiresAt') as string | number | Date).getTime() : 0
            if (!row || cell(row, 'consumedAt') !== null || expiresAt <= now) {
                await runner.query('COMMIT')
                return null
            }
            await query(
                runner,
                `UPDATE ${q('sqlite', 'identity_oidc_transaction')} SET ${q('sqlite', 'consumedAt')} = ? WHERE ${q(
                    'sqlite',
                    'stateHash'
                )} = ? AND ${q('sqlite', 'consumedAt')} IS NULL`,
                [dateValue(runner, now), stateHash]
            )
            await runner.query('COMMIT')
            return String(cell(row, 'envelope'))
        } catch (error) {
            await runner.query('ROLLBACK').catch(() => undefined)
            throw error
        } finally {
            await runner.release()
        }
    }
    await runner.startTransaction()
    try {
        const d = dialect(runner)
        const locked = d === 'sqlite' ? '' : ' FOR UPDATE'
        const rows = await query(
            runner,
            `SELECT ${q(d, 'envelope')} AS ${q(d, 'envelope')}, ${q(d, 'expiresAt')} AS ${q(d, 'expiresAt')}, ${q(d, 'consumedAt')} AS ${q(
                d,
                'consumedAt'
            )} FROM ${q(d, 'identity_oidc_transaction')} WHERE ${q(d, 'stateHash')} = ?${locked}`,
            [stateHash]
        )
        const row = rows[0]
        const expiresAt = row ? new Date(cell(row, 'expiresAt') as string | number | Date).getTime() : 0
        if (!row || cell(row, 'consumedAt') !== null || expiresAt <= now) {
            await runner.commitTransaction()
            return null
        }
        await query(
            runner,
            `UPDATE ${q(d, 'identity_oidc_transaction')} SET ${q(d, 'consumedAt')} = ? WHERE ${q(d, 'stateHash')} = ? AND ${q(
                d,
                'consumedAt'
            )} IS NULL`,
            [dateValue(runner, now), stateHash]
        )
        await runner.commitTransaction()
        return String(cell(row, 'envelope'))
    } catch (error) {
        if (runner.isTransactionActive) await runner.rollbackTransaction()
        throw error
    } finally {
        await runner.release()
    }
}

export async function findProviderLink(dataSource: DataSource, providerKey: string, subject: string): Promise<ProviderLink | null> {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    try {
        const d = dialect(runner)
        const rows = await query(
            runner,
            `SELECT * FROM ${q(d, 'identity_provider_link')} WHERE ${q(d, 'providerKey')} = ? AND ${q(d, 'subject')} = ?`,
            [providerKey, subject]
        )
        if (!rows[0]) return null
        return {
            providerKey,
            subject,
            userId: String(cell(rows[0], 'userId')),
            emailAtLink: cell(rows[0], 'emailAtLink') ? String(cell(rows[0], 'emailAtLink')) : null,
            assuranceBasis: String(cell(rows[0], 'assuranceBasis')),
            createdAt: iso(cell(rows[0], 'createdAt')) || new Date(0).toISOString()
        }
    } finally {
        await runner.release()
    }
}

export async function createProviderLink(
    dataSource: DataSource,
    link: Omit<ProviderLink, 'createdAt'>,
    now = Date.now()
): Promise<'linked' | 'conflict'> {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    try {
        const d = dialect(runner)
        try {
            await query(
                runner,
                `INSERT INTO ${q(d, 'identity_provider_link')} (${q(d, 'providerKey')}, ${q(d, 'subject')}, ${q(d, 'userId')}, ${q(
                    d,
                    'emailAtLink'
                )}, ${q(d, 'assuranceBasis')}, ${q(d, 'createdAt')}) VALUES (?, ?, ?, ?, ?, ?)`,
                [link.providerKey, link.subject, link.userId, link.emailAtLink, link.assuranceBasis, dateValue(runner, now)]
            )
            return 'linked'
        } catch (error) {
            if (/unique|duplicate|23505/i.test(error instanceof Error ? error.message : String(error))) return 'conflict'
            throw error
        }
    } finally {
        await runner.release()
    }
}

export async function migrateLegacyProviderLinks(
    dataSource: DataSource,
    state: { activeMethod: string | null; providerKey: string | null; warningKind: string | null }
): Promise<ProviderLinkMigrationStatus> {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    try {
        const d = dialect(runner)
        const existing = await query(
            runner,
            `SELECT ${q(d, 'id')} AS ${q(d, 'id')}, ${q(d, 'email')} AS ${q(d, 'email')}, ${q(d, 'externalId')} AS ${q(
                d,
                'externalId'
            )} FROM ${q(d, 'user')} WHERE ${q(d, 'externalId')} IS NOT NULL AND ${q(d, 'externalId')} <> ''`
        )
        const markers = await query(runner, `SELECT * FROM ${q(d, 'identity_provider_link_migration')} WHERE ${q(d, 'id')} = 1`)
        const previous = markers[0]
        const previousProviderKey = previous && cell(previous, 'providerKey') ? String(cell(previous, 'providerKey')) : null
        const activeWorkosProviderKey = state.activeMethod === 'workos' ? state.providerKey : null
        const workosProviderKey = activeWorkosProviderKey || previousProviderKey
        const sameProvider = Boolean(previous) && previousProviderKey === workosProviderKey
        let error: string | null = null
        if (existing.length && state.warningKind === 'workos-client-mismatch') error = 'WorkOS configuration review is required.'
        let inert = 0
        let migrated = sameProvider && previous ? Number(cell(previous, 'migratedCount') || 0) : 0
        if (!error) {
            for (const row of existing) {
                const subject = String(cell(row, 'externalId'))
                const userId = String(cell(row, 'id'))
                const linked = workosProviderKey
                    ? await query(
                          runner,
                          `SELECT ${q(d, 'userId')} AS ${q(d, 'userId')} FROM ${q(d, 'identity_provider_link')} WHERE ${q(
                              d,
                              'providerKey'
                          )} = ? AND ${q(d, 'subject')} = ?`,
                          [workosProviderKey, subject]
                      )
                    : await query(
                          runner,
                          `SELECT ${q(d, 'userId')} AS ${q(d, 'userId')} FROM ${q(d, 'identity_provider_link')} WHERE ${q(
                              d,
                              'subject'
                          )} = ? AND ${q(d, 'assuranceBasis')} = 'workos_legacy'`,
                          [subject]
                      )
                if (linked.length) {
                    if (String(cell(linked[0], 'userId')) !== userId) throw new Error('Legacy identity link conflict.')
                    continue
                }
                if (!activeWorkosProviderKey || workosProviderKey !== activeWorkosProviderKey) {
                    inert += 1
                    continue
                }
                const columns = `${q(d, 'providerKey')}, ${q(d, 'subject')}, ${q(d, 'userId')}, ${q(d, 'emailAtLink')}, ${q(
                    d,
                    'assuranceBasis'
                )}, ${q(d, 'createdAt')}`
                const values = [
                    workosProviderKey,
                    subject,
                    userId,
                    mailboxKey(String(cell(row, 'email') || '')) || null,
                    'workos_legacy',
                    dateValue(runner, Date.now())
                ]
                await query(
                    runner,
                    d === 'mysql' || d === 'mariadb'
                        ? `INSERT INTO ${q(d, 'identity_provider_link')} (${columns}) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE ${q(
                              d,
                              'providerKey'
                          )} = ${q(d, 'providerKey')}`
                        : `INSERT INTO ${q(d, 'identity_provider_link')} (${columns}) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
                    values
                )
                const after = await query(
                    runner,
                    `SELECT ${q(d, 'userId')} AS ${q(d, 'userId')} FROM ${q(d, 'identity_provider_link')} WHERE ${q(
                        d,
                        'providerKey'
                    )} = ? AND ${q(d, 'subject')} = ?`,
                    [workosProviderKey, subject]
                )
                if (!after[0] || String(cell(after[0], 'userId')) !== userId) throw new Error('Legacy identity link conflict.')
                migrated += 1
            }
        }
        const markerColumns = `${q(d, 'id')}, ${q(d, 'providerKey')}, ${q(d, 'migratedCount')}, ${q(d, 'inertCount')}, ${q(
            d,
            'completedAt'
        )}, ${q(d, 'error')}`
        const previousCompletedAt = previous && cell(previous, 'completedAt')
        const markerUnchanged =
            previous !== undefined &&
            sameProvider &&
            !error &&
            !cell(previous, 'error') &&
            migrated === Number(cell(previous, 'migratedCount') || 0) &&
            inert === Number(cell(previous, 'inertCount') || 0) &&
            Boolean(previousCompletedAt)
        const markerValues = [
            workosProviderKey,
            migrated,
            inert,
            error ? null : markerUnchanged ? previousCompletedAt : dateValue(runner, Date.now()),
            error
        ]
        await query(
            runner,
            d === 'mysql' || d === 'mariadb'
                ? `INSERT INTO ${q(
                      d,
                      'identity_provider_link_migration'
                  )} (${markerColumns}) VALUES (1, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE ${q(d, 'providerKey')} = VALUES(${q(
                      d,
                      'providerKey'
                  )}), ${q(d, 'migratedCount')} = VALUES(${q(d, 'migratedCount')}), ${q(d, 'inertCount')} = VALUES(${q(
                      d,
                      'inertCount'
                  )}), ${q(d, 'completedAt')} = VALUES(${q(d, 'completedAt')}), ${q(d, 'error')} = VALUES(${q(d, 'error')})`
                : `INSERT INTO ${q(d, 'identity_provider_link_migration')} (${markerColumns}) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT (${q(
                      d,
                      'id'
                  )}) DO UPDATE SET ${q(d, 'providerKey')} = excluded.${q(d, 'providerKey')}, ${q(d, 'migratedCount')} = excluded.${q(
                      d,
                      'migratedCount'
                  )}, ${q(d, 'inertCount')} = excluded.${q(d, 'inertCount')}, ${q(d, 'completedAt')} = excluded.${q(d, 'completedAt')}, ${q(
                      d,
                      'error'
                  )} = excluded.${q(d, 'error')}`,
            markerValues
        )
        await runner.commitTransaction()
        return { complete: !error, migrated, inert, error }
    } catch (error) {
        if (runner.isTransactionActive) await runner.rollbackTransaction()
        throw error
    } finally {
        await runner.release()
    }
}

export async function providerLinkMigrationComplete(dataSource: DataSource): Promise<boolean> {
    return (await providerLinkMigrationStatus(dataSource)).complete
}

export async function providerLinkMigrationStatus(dataSource: DataSource): Promise<ProviderLinkMigrationStatus> {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    try {
        const d = dialect(runner)
        const rows = await query(
            runner,
            `SELECT ${q(d, 'migratedCount')} AS ${q(d, 'migratedCount')}, ${q(d, 'inertCount')} AS ${q(d, 'inertCount')}, ${q(
                d,
                'completedAt'
            )} AS ${q(d, 'completedAt')}, ${q(d, 'error')} AS ${q(d, 'error')} FROM ${q(d, 'identity_provider_link_migration')} WHERE ${q(
                d,
                'id'
            )} = 1`
        )
        const row = rows[0]
        return {
            complete: Boolean(row && cell(row, 'completedAt') && !cell(row, 'error')),
            migrated: Number((row && cell(row, 'migratedCount')) || 0),
            inert: Number((row && cell(row, 'inertCount')) || 0),
            error: row && cell(row, 'error') ? String(cell(row, 'error')) : null
        }
    } finally {
        await runner.release()
    }
}

export async function resolveOidcUser(
    dataSource: DataSource,
    store: IdentityStore,
    identity: {
        providerKey: string
        subject: string
        email?: string
        emailVerified?: boolean
        emailVerificationPresent?: boolean
        xmsEdov?: boolean
        issuer: string
    },
    options: { trustMissing: boolean; invitationToken?: string; bootstrapEmail?: string; now?: number }
): Promise<{ ok: true; user: UserRow; basis: string } | { ok: false; reason: string; basis?: string }> {
    const linked = await findProviderLink(dataSource, identity.providerKey, identity.subject)
    if (linked) {
        const session = await store.sessionFor(linked.userId)
        if (!session || String(session.status).toLowerCase() !== 'active') return { ok: false, reason: 'inactive' }
        const users = await store.findUsersByEmail(session.email)
        const user = users.find((candidate) => candidate.id === linked.userId)
        return user ? { ok: true, user, basis: linked.assuranceBasis } : { ok: false, reason: 'inactive' }
    }

    const email = identity.email ? mailboxKey(identity.email) : ''
    if (!email) return { ok: false, reason: 'email_required' }
    if (identity.emailVerified === false) return { ok: false, reason: 'email_not_assured' }
    const entra = isEntraAuthorityIssuer(identity.issuer) && identity.xmsEdov === true
    const basis =
        identity.emailVerified === true
            ? 'email_verified'
            : entra
            ? 'xms_edov'
            : identity.emailVerified === undefined && identity.emailVerificationPresent !== true && options.trustMissing
            ? 'issuer_trusted'
            : ''
    const matches = (await store.findUsersByEmail(email)).filter((row) => mailboxKey(row.email) === email)
    if (matches.length === 0 && (await store.countUsers()) === 0) {
        if (!basis || !options.bootstrapEmail || mailboxKey(options.bootstrapEmail) !== email) {
            return { ok: false, reason: 'bootstrap_denied', basis: basis || undefined }
        }
        try {
            const user = await store.createOwner(
                {
                    email,
                    name: identity.email?.split('@')[0]?.slice(0, 100) || 'Super User',
                    credential: null,
                    externalId: null
                },
                {
                    now: options.now,
                    providerLink: {
                        providerKey: identity.providerKey,
                        subject: identity.subject,
                        emailAtLink: email,
                        assuranceBasis: basis
                    }
                }
            )
            return { ok: true, user, basis }
        } catch (error) {
            if (error instanceof NotEmptyError) return { ok: false, reason: 'unknown', basis }
            throw error
        }
    }
    if (matches.length !== 1) return { ok: false, reason: matches.length > 1 ? 'ambiguous' : 'unknown', basis: basis || undefined }
    const user = matches[0]
    if (String(user.status).toLowerCase() === 'invited') {
        if (!options.invitationToken) return { ok: false, reason: 'invite_required' }
        const accepted = await store.acceptInvite({
            token: options.invitationToken,
            userId: user.id,
            email,
            externalId: identity.subject,
            providerKey: identity.providerKey,
            subject: identity.subject,
            assuranceBasis: 'invitation',
            now: options.now ?? Date.now()
        })
        return accepted === 'accepted'
            ? { ok: true, user: { ...user, status: 'active' }, basis: 'invitation' }
            : { ok: false, reason: 'invite_invalid' }
    }
    if (String(user.status).toLowerCase() !== 'active') return { ok: false, reason: 'inactive' }
    if (!basis) return { ok: false, reason: 'email_not_assured' }
    const created = await createProviderLink(dataSource, {
        providerKey: identity.providerKey,
        subject: identity.subject,
        userId: user.id,
        emailAtLink: email,
        assuranceBasis: basis
    })
    return created === 'linked' ? { ok: true, user, basis } : { ok: false, reason: 'link_conflict', basis }
}
