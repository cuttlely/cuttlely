/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { createHash, randomBytes, randomUUID } from 'crypto'
import type { DataSource, QueryRunner } from 'typeorm'
import { isUsablePasswordHash } from './password'
import { localAdminEnabled, localUsersSetting, workosEnvironmentConfigured } from './constants'

export type AuthenticationMethod = 'local' | 'workos'
export type AuthenticationWarningKind = 'configuration-ambiguous' | 'method-missing' | 'workos-client-mismatch'
const AMBIGUOUS_CONFIGURATION_WARNING =
    'Both ordinary sign-in settings are enabled. WorkOS remains active until an administrator reviews the configuration.'
const METHOD_MISSING_WARNING = 'No ordinary sign-in method is configured.'
const WORKOS_CLIENT_MISMATCH_WARNING =
    'The WorkOS client identity differs from the saved installation. Review this database before linking accounts.'
let effectiveMethod: AuthenticationMethod | null | undefined
let effectiveEpoch: number | undefined
let effectiveBaselineEpoch: number | undefined
let stateRefreshedAt = 0
const STATE_CACHE_MS = 2_000

export function selectedAuthenticationMethod(): AuthenticationMethod | null | undefined {
    return effectiveMethod
}

export function selectedAuthenticationEpoch(): number | undefined {
    return effectiveEpoch
}

export function selectedAuthenticationBaselineEpoch(): number | undefined {
    return effectiveBaselineEpoch
}

export interface AuthenticationState {
    installationId: string
    activeMethod: AuthenticationMethod | null
    authenticationEpoch: number
    authenticationBaselineEpoch: number
    configurationFingerprint: string | null
    providerKey: string | null
    warning: string | null
    warningKind: AuthenticationWarningKind | null
    sessionsEnded: number
    changedAt: string | null
    inferredAt: string
    version: number
}

export interface AuthenticationSwitchStage {
    id: string
    actorId: string
    method: AuthenticationMethod
    stateVersion: number
    expiresAt: string
    version: number
}

function publishState(state: AuthenticationState): AuthenticationState {
    effectiveMethod = state.activeMethod
    effectiveEpoch = state.authenticationEpoch
    effectiveBaselineEpoch = state.authenticationBaselineEpoch
    stateRefreshedAt = Date.now()
    return state
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
    let n = 0
    const text = dialect(runner) === 'postgres' ? sql.replace(/\?/g, () => `$${++n}`) : sql
    const result = await runner.query(text, params)
    return Array.isArray(result) ? result : []
}

// Row count of an UPDATE or DELETE, or null when the driver does not report one.
// PostgreSQL answers [rows, rowCount]; MySQL and MariaDB answer an object with affectedRows.
async function affectedRows(runner: QueryRunner, sql: string, params: unknown[] = []): Promise<number | null> {
    let n = 0
    const text = dialect(runner) === 'postgres' ? sql.replace(/\?/g, () => `$${++n}`) : sql
    const result: unknown = await runner.query(text, params)
    if (Array.isArray(result) && result.length === 2 && typeof result[1] === 'number') return result[1]
    if (result && typeof result === 'object' && typeof (result as { affectedRows?: unknown }).affectedRows === 'number')
        return (result as { affectedRows: number }).affectedRows
    return null
}

function value(row: Record<string, unknown>, name: string): unknown {
    const key = Object.keys(row).find((item) => item.toLowerCase() === name.toLowerCase())
    return key ? row[key] : undefined
}

function databaseDate(runner: QueryRunner, valueToWrite: Date): Date | number {
    return dialect(runner) === 'sqlite' ? valueToWrite.getTime() : valueToWrite
}

function date(valueToRead: unknown): string | null {
    if (!valueToRead) return null
    const numeric = typeof valueToRead === 'string' ? Number(valueToRead) : Number.NaN
    const valueAsDate = Number.isFinite(numeric) ? new Date(numeric) : new Date(valueToRead as string | number | Date)
    if (!Number.isFinite(valueAsDate.getTime()))
        throw new Error(`Invalid stored authentication date (${typeof valueToRead}: ${String(valueToRead)})`)
    return valueAsDate.toISOString()
}

function fromRow(row: Record<string, unknown>): AuthenticationState {
    const method = String(value(row, 'activeMethod') || '')
    const warning = value(row, 'warning') ? String(value(row, 'warning')) : null
    return {
        installationId: String(value(row, 'installationId')),
        activeMethod: method === 'local' || method === 'workos' ? method : null,
        authenticationEpoch: Number(value(row, 'authenticationEpoch') || 0),
        authenticationBaselineEpoch: Number(value(row, 'authenticationBaselineEpoch') || 0),
        configurationFingerprint: value(row, 'configurationFingerprint') ? String(value(row, 'configurationFingerprint')) : null,
        providerKey: value(row, 'providerKey') ? String(value(row, 'providerKey')) : null,
        warning,
        warningKind:
            warning === WORKOS_CLIENT_MISMATCH_WARNING
                ? 'workos-client-mismatch'
                : warning === AMBIGUOUS_CONFIGURATION_WARNING
                ? 'configuration-ambiguous'
                : warning === METHOD_MISSING_WARNING
                ? 'method-missing'
                : null,
        sessionsEnded: Number(value(row, 'sessionsEnded') || 0),
        changedAt: date(value(row, 'changedAt')),
        inferredAt: date(value(row, 'inferredAt')) as string,
        version: Number(value(row, 'version') || 1)
    }
}

export function workosConfigurationFingerprint(env: NodeJS.ProcessEnv = process.env): string | null {
    const clientId = env.WORKOS_CLIENT_ID?.trim()
    if (!clientId) return null
    return createHash('sha256').update(`workos\nhttps://api.workos.com\n${clientId}`).digest('hex')
}

export function stableWorkosProviderKey(installationId: string, fingerprint: string): string {
    return createHash('sha256').update(`workos\n${installationId}\n${fingerprint}`).digest('hex')
}

export async function recordRecentAuthentication(
    dataSource: DataSource,
    userId: string,
    now = Date.now()
): Promise<{ token: string; expiresAt: number }> {
    const token = randomBytes(32).toString('base64url')
    const digest = createHash('sha256').update(token).digest('hex')
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    try {
        const d = dialect(runner)
        const expiresAt = now + 10 * 60 * 1000
        await query(runner, `DELETE FROM ${q(d, 'identity_recent_authentication')} WHERE ${q(d, 'expiresAt')} <= ?`, [
            databaseDate(runner, new Date(now))
        ])
        await query(
            runner,
            `INSERT INTO ${q(d, 'identity_recent_authentication')} (${q(d, 'token')}, ${q(d, 'userId')}, ${q(d, 'authenticatedAt')}, ${q(
                d,
                'expiresAt'
            )}) VALUES (?, ?, ?, ?)`,
            [digest, userId, databaseDate(runner, new Date(now)), databaseDate(runner, new Date(expiresAt))]
        )
        return { token, expiresAt }
    } finally {
        await runner.release()
    }
}

export async function hasRecentAuthentication(dataSource: DataSource, userId: string, token: string, now = Date.now()): Promise<boolean> {
    const digest = createHash('sha256').update(token).digest('hex')
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    try {
        const d = dialect(runner)
        const rows = await query(
            runner,
            `SELECT ${q(d, 'authenticatedAt')}, ${q(d, 'expiresAt')} FROM ${q(d, 'identity_recent_authentication')} WHERE ${q(
                d,
                'token'
            )} = ? AND ${q(d, 'userId')} = ?`,
            [digest, userId]
        )
        if (!rows[0]) return false
        const authenticatedAt = new Date(value(rows[0], 'authenticatedAt') as string | Date).getTime()
        const expiresAt = new Date(value(rows[0], 'expiresAt') as string | Date).getTime()
        return authenticatedAt <= now && now - authenticatedAt <= 10 * 60 * 1000 && expiresAt > now
    } finally {
        await runner.release()
    }
}

function inferredMethod(env: NodeJS.ProcessEnv): { method: AuthenticationMethod | null; warning: string | null } {
    if (workosEnvironmentConfigured(env) && localUsersSetting(env))
        return {
            method: 'workos',
            warning: AMBIGUOUS_CONFIGURATION_WARNING
        }
    if (workosEnvironmentConfigured(env)) return { method: 'workos', warning: null }
    if (localUsersSetting(env)) return { method: 'local', warning: null }
    if (localAdminEnabled(env)) return { method: null, warning: null }
    return { method: null, warning: METHOD_MISSING_WARNING }
}

async function selectState(runner: QueryRunner, lock = false): Promise<AuthenticationState | null> {
    const d = dialect(runner)
    const suffix = lock && d !== 'sqlite' ? ' FOR UPDATE' : ''
    const rows = await query(runner, `SELECT * FROM ${q(d, 'identity_authentication_state')} WHERE ${q(d, 'id')} = 1${suffix}`)
    return rows[0] ? fromRow(rows[0]) : null
}

/** Creates the installation row once and imports the old WorkOS cutoff without ending sessions again. */
export async function initializeAuthenticationState(
    dataSource: DataSource,
    env: NodeJS.ProcessEnv = process.env
): Promise<AuthenticationState> {
    try {
        return await initializeAuthenticationStateOnce(dataSource, env)
    } catch (error) {
        // Another process may have created the singleton row first. Read and adopt the row it wrote.
        if (!(await readAuthenticationState(dataSource))) throw error
        return await initializeAuthenticationStateOnce(dataSource, env)
    }
}

async function initializeAuthenticationStateOnce(dataSource: DataSource, env: NodeJS.ProcessEnv): Promise<AuthenticationState> {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    try {
        const current = await selectState(runner, true)
        if (current) {
            const fingerprint = workosConfigurationFingerprint(env)
            if (
                current.activeMethod === 'workos' &&
                current.configurationFingerprint &&
                fingerprint &&
                current.configurationFingerprint !== fingerprint &&
                current.warning !== WORKOS_CLIENT_MISMATCH_WARNING
            ) {
                const d = dialect(runner)
                await query(
                    runner,
                    `UPDATE ${q(d, 'identity_authentication_state')} SET ${q(d, 'warning')} = ?, ${q(d, 'version')} = ${q(
                        d,
                        'version'
                    )} + 1 WHERE ${q(d, 'id')} = 1`,
                    [WORKOS_CLIENT_MISMATCH_WARNING]
                )
            }
            await runner.commitTransaction()
            const result = (await readAuthenticationState(dataSource)) as AuthenticationState
            return publishState(result)
        }
        const d = dialect(runner)
        const installationId = randomUUID()
        const inferred = inferredMethod(env)
        const fingerprint = inferred.method === 'workos' ? workosConfigurationFingerprint(env) : null
        const legacy = await query(runner, `SELECT * FROM ${q(d, 'identity_authkit_switch')} WHERE ${q(d, 'id')} = 1`)
        const sessionsEnded = Number(value(legacy[0] || {}, 'sessionsEnded') || 0)
        const changedAt = date(value(legacy[0] || {}, 'switchedAt'))
        const now = new Date()
        await query(
            runner,
            `INSERT INTO ${q(d, 'identity_authentication_state')} (${q(d, 'id')}, ${q(d, 'installationId')}, ${q(d, 'activeMethod')}, ${q(
                d,
                'authenticationEpoch'
            )}, ${q(d, 'authenticationBaselineEpoch')}, ${q(d, 'configurationFingerprint')}, ${q(d, 'providerKey')}, ${q(
                d,
                'warning'
            )}, ${q(d, 'sessionsEnded')}, ${q(d, 'changedAt')}, ${q(d, 'inferredAt')}, ${q(
                d,
                'version'
            )}) VALUES (1, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, 1)`,
            [
                installationId,
                inferred.method,
                fingerprint,
                fingerprint ? stableWorkosProviderKey(installationId, fingerprint) : null,
                inferred.warning,
                sessionsEnded,
                changedAt ? databaseDate(runner, new Date(changedAt)) : null,
                databaseDate(runner, now)
            ]
        )
        await runner.commitTransaction()
        const result = (await readAuthenticationState(dataSource)) as AuthenticationState
        return publishState(result)
    } catch (error) {
        if (runner.isTransactionActive) await runner.rollbackTransaction()
        throw error
    } finally {
        await runner.release()
    }
}

export async function readAuthenticationState(dataSource: DataSource): Promise<AuthenticationState | null> {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    try {
        return await selectState(runner)
    } finally {
        await runner.release()
    }
}

/** Refreshes the process view from durable state. The bounded cache limits request-path database reads. */
export async function refreshAuthenticationState(dataSource: DataSource, force = false): Promise<AuthenticationState | null> {
    if (!force && effectiveMethod !== undefined && Date.now() - stateRefreshedAt < STATE_CACHE_MS) return null
    const state = await readAuthenticationState(dataSource)
    if (state) publishState(state)
    return state
}

export function authenticationStateCacheMs(): number {
    return STATE_CACHE_MS
}

export async function acknowledgeAuthenticationWarning(
    dataSource: DataSource,
    expectedVersion: number,
    audit: { organizationId: string; actorId: string }
): Promise<AuthenticationState> {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    try {
        const current = await selectState(runner, true)
        if (!current || current.version !== expectedVersion) throw new Error('AUTH_STATE_CHANGED')
        if (current.warningKind !== 'workos-client-mismatch') throw new Error('AUTH_WARNING_NOT_ACTIONABLE')
        const fingerprint = workosConfigurationFingerprint()
        const d = dialect(runner)
        const now = new Date()
        await query(
            runner,
            `UPDATE ${q(d, 'identity_authentication_state')} SET ${q(d, 'configurationFingerprint')} = ?, ${q(d, 'providerKey')} = ?, ${q(
                d,
                'warning'
            )} = NULL, ${q(d, 'version')} = ${q(d, 'version')} + 1 WHERE ${q(d, 'id')} = 1`,
            [fingerprint, fingerprint ? stableWorkosProviderKey(current.installationId, fingerprint) : null]
        )
        await query(
            runner,
            `INSERT INTO ${q(d, 'audit_event')} (${q(d, 'id')}, ${q(d, 'type')}, ${q(d, 'organizationId')}, ${q(d, 'workspaceId')}, ${q(
                d,
                'userId'
            )}, ${q(d, 'actorId')}, ${q(d, 'summary')}, ${q(d, 'detail')}, ${q(d, 'createdAt')}) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
            [
                randomUUID(),
                'auth_config_warning_ack',
                audit.organizationId,
                audit.actorId,
                audit.actorId,
                'Authentication configuration warning acknowledged',
                JSON.stringify({ configurationFingerprint: fingerprint, outcome: 'acknowledged' }),
                now.getTime()
            ]
        )
        await runner.commitTransaction()
        return publishState((await readAuthenticationState(dataSource)) as AuthenticationState)
    } catch (error) {
        if (runner.isTransactionActive) await runner.rollbackTransaction()
        throw error
    } finally {
        await runner.release()
    }
}

export async function automaticWorkosLinkingAllowed(dataSource: DataSource): Promise<boolean> {
    const state = await readAuthenticationState(dataSource)
    const fingerprint = workosConfigurationFingerprint()
    return Boolean(state && fingerprint && state.configurationFingerprint === fingerprint && state.warningKind !== 'workos-client-mismatch')
}

export async function stageAuthenticationMethodSwitch(
    dataSource: DataSource,
    actorId: string,
    method: AuthenticationMethod,
    stateVersion: number,
    now = Date.now()
): Promise<AuthenticationSwitchStage> {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    try {
        const d = dialect(runner)
        const id = randomUUID()
        const expiresAt = new Date(now + 10 * 60 * 1000)
        await query(
            runner,
            `INSERT INTO ${q(d, 'identity_authentication_switch_stage')} (${q(d, 'id')}, ${q(d, 'actorId')}, ${q(d, 'method')}, ${q(
                d,
                'stateVersion'
            )}, ${q(d, 'expiresAt')}, ${q(d, 'consumedAt')}, ${q(d, 'version')}) VALUES (?, ?, ?, ?, ?, NULL, 1)`,
            [id, actorId, method, stateVersion, databaseDate(runner, expiresAt)]
        )
        return { id, actorId, method, stateVersion, expiresAt: expiresAt.toISOString(), version: 1 }
    } finally {
        await runner.release()
    }
}

/** True when any active owner with an active membership has a usable local password. */
export async function usableLocalOwnerReady(dataSource: DataSource): Promise<boolean> {
    const runner = dataSource.createQueryRunner()
    try {
        await runner.connect()
        return await usableLocalOwnerExists(runner)
    } finally {
        await runner.release()
    }
}

async function usableLocalOwnerExists(runner: QueryRunner): Promise<boolean> {
    const d = dialect(runner)
    const rows = await query(
        runner,
        `SELECT u.${q(d, 'credential')} AS ${q(d, 'credential')} FROM ${q(d, 'user')} u
         INNER JOIN ${q(d, 'organization_user')} ou ON ou.${q(d, 'userId')} = u.${q(d, 'id')}
         INNER JOIN ${q(d, 'role')} r ON r.${q(d, 'id')} = ou.${q(d, 'roleId')}
         WHERE LOWER(r.${q(d, 'name')}) = 'owner'
           AND LOWER(u.${q(d, 'status')}) = 'active'
           AND LOWER(ou.${q(d, 'status')}) = 'active'
           AND u.${q(d, 'credential')} IS NOT NULL
           AND u.${q(d, 'credential')} <> ''`
    )
    return rows.some((row) => isUsablePasswordHash(String(value(row, 'credential') ?? '')))
}

export async function switchAuthenticationMethod(
    dataSource: DataSource,
    method: AuthenticationMethod,
    expectedVersion: number,
    audit?: { organizationId: string; actorId: string },
    stage?: { id: string; actorId: string; version: number; now?: number }
): Promise<AuthenticationState> {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    try {
        const current = await selectState(runner, true)
        if (!current || current.version !== expectedVersion) throw new Error('AUTH_STATE_CHANGED')
        if (stage) {
            const d = dialect(runner)
            const rows = await query(
                runner,
                `SELECT * FROM ${q(d, 'identity_authentication_switch_stage')} WHERE ${q(d, 'id')} = ?${
                    d === 'sqlite' ? '' : ' FOR UPDATE'
                }`,
                [stage.id]
            )
            const row = rows[0]
            const expiresAt = row ? new Date(value(row, 'expiresAt') as string | number | Date).getTime() : 0
            if (
                !row ||
                String(value(row, 'actorId')) !== stage.actorId ||
                String(value(row, 'method')) !== method ||
                Number(value(row, 'stateVersion')) !== expectedVersion ||
                Number(value(row, 'version')) !== stage.version ||
                value(row, 'consumedAt') !== null ||
                expiresAt <= (stage.now ?? Date.now())
            )
                throw new Error('AUTH_STAGE_STALE')
        }
        const fingerprint = method === 'workos' ? workosConfigurationFingerprint() : null
        if (method === 'workos' && (!workosEnvironmentConfigured() || !fingerprint)) throw new Error('METHOD_NOT_READY')
        if (method === 'local' && !localUsersSetting()) throw new Error('METHOD_NOT_READY')
        if (current.activeMethod === 'workos' && method === 'local' && !(await usableLocalOwnerExists(runner))) {
            throw new Error('LOCAL_OWNER_REQUIRED')
        }
        if (current.activeMethod === method && current.configurationFingerprint === fingerprint) {
            await runner.commitTransaction()
            return current
        }
        const d = dialect(runner)
        if (stage) {
            const consumed = await affectedRows(
                runner,
                `UPDATE ${q(d, 'identity_authentication_switch_stage')} SET ${q(d, 'consumedAt')} = ?, ${q(d, 'version')} = ${q(
                    d,
                    'version'
                )} + 1 WHERE ${q(d, 'id')} = ? AND ${q(d, 'version')} = ? AND ${q(d, 'consumedAt')} IS NULL`,
                [databaseDate(runner, new Date(stage.now ?? Date.now())), stage.id, stage.version]
            )
            if (consumed === 0) throw new Error('AUTH_STAGE_STALE')
        }
        const counted = await query(runner, `SELECT COUNT(*) AS ${q(d, 'count')} FROM ${q(d, 'identity_local_session')}`)
        const ended = Number(value(counted[0] || {}, 'count') || 0)
        await query(runner, `DELETE FROM ${q(d, 'identity_local_session')}`)
        const now = new Date()
        await query(
            runner,
            `UPDATE ${q(d, 'identity_authentication_state')} SET ${q(d, 'activeMethod')} = ?, ${q(d, 'authenticationEpoch')} = ${q(
                d,
                'authenticationEpoch'
            )} + 1, ${q(d, 'configurationFingerprint')} = ?, ${q(d, 'providerKey')} = ?, ${q(d, 'warning')} = NULL, ${q(
                d,
                'sessionsEnded'
            )} = ?, ${q(d, 'changedAt')} = ?, ${q(d, 'version')} = ${q(d, 'version')} + 1 WHERE ${q(d, 'id')} = 1`,
            [
                method,
                fingerprint,
                fingerprint ? stableWorkosProviderKey(current.installationId, fingerprint) : null,
                ended,
                databaseDate(runner, now)
            ]
        )
        if (audit) {
            await query(
                runner,
                `INSERT INTO ${q(d, 'audit_event')} (${q(d, 'id')}, ${q(d, 'type')}, ${q(d, 'organizationId')}, ${q(d, 'workspaceId')}, ${q(
                    d,
                    'userId'
                )}, ${q(d, 'actorId')}, ${q(d, 'summary')}, ${q(d, 'detail')}, ${q(d, 'createdAt')}) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
                [
                    randomUUID(),
                    'auth_method_change',
                    audit.organizationId,
                    audit.actorId,
                    audit.actorId,
                    'Sign-in method changed',
                    JSON.stringify({
                        oldMethod: current.activeMethod || 'none',
                        newMethod: method,
                        configurationFingerprint: fingerprint,
                        authenticationEpoch: current.authenticationEpoch + 1,
                        sessionsEnded: ended,
                        outcome: 'applied'
                    }),
                    now.getTime()
                ]
            )
        }
        await runner.commitTransaction()
        const result = (await readAuthenticationState(dataSource)) as AuthenticationState
        return publishState(result)
    } catch (error) {
        if (runner.isTransactionActive) await runner.rollbackTransaction()
        throw error
    } finally {
        await runner.release()
    }
}
