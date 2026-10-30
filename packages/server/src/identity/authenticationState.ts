/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { createHash, randomUUID } from 'crypto'
import type { DataSource, QueryRunner } from 'typeorm'
import { localAdminEnabled, localUsersSetting, workosEnvironmentConfigured } from './constants'

export type AuthenticationMethod = 'local' | 'workos'
let effectiveMethod: AuthenticationMethod | null | undefined
let effectiveEpoch: number | undefined

export function selectedAuthenticationMethod(): AuthenticationMethod | null | undefined {
    return effectiveMethod
}

export function selectedAuthenticationEpoch(): number | undefined {
    return effectiveEpoch
}

export interface AuthenticationState {
    installationId: string
    activeMethod: AuthenticationMethod | null
    authenticationEpoch: number
    configurationFingerprint: string | null
    providerKey: string | null
    warning: string | null
    sessionsEnded: number
    changedAt: string | null
    inferredAt: string
    version: number
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

function value(row: Record<string, unknown>, name: string): unknown {
    const key = Object.keys(row).find((item) => item.toLowerCase() === name.toLowerCase())
    return key ? row[key] : undefined
}

function date(valueToRead: unknown): string | null {
    if (!valueToRead) return null
    return new Date(valueToRead as string | number | Date).toISOString()
}

function fromRow(row: Record<string, unknown>): AuthenticationState {
    const method = String(value(row, 'activeMethod') || '')
    return {
        installationId: String(value(row, 'installationId')),
        activeMethod: method === 'local' || method === 'workos' ? method : null,
        authenticationEpoch: Number(value(row, 'authenticationEpoch') || 0),
        configurationFingerprint: value(row, 'configurationFingerprint') ? String(value(row, 'configurationFingerprint')) : null,
        providerKey: value(row, 'providerKey') ? String(value(row, 'providerKey')) : null,
        warning: value(row, 'warning') ? String(value(row, 'warning')) : null,
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

function inferredMethod(env: NodeJS.ProcessEnv): { method: AuthenticationMethod | null; warning: string | null } {
    if (workosEnvironmentConfigured(env)) return { method: 'workos', warning: null }
    if (localUsersSetting(env)) return { method: 'local', warning: null }
    if (localAdminEnabled(env)) return { method: null, warning: null }
    return { method: null, warning: 'No ordinary sign-in method is configured.' }
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
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    try {
        const current = await selectState(runner, true)
        if (current) {
            const fingerprint = workosConfigurationFingerprint(env)
            const mismatchWarning =
                'The WorkOS client identity differs from the saved installation. Review this database before linking accounts.'
            if (
                current.activeMethod === 'workos' &&
                current.configurationFingerprint &&
                fingerprint &&
                current.configurationFingerprint !== fingerprint &&
                current.warning !== mismatchWarning
            ) {
                const d = dialect(runner)
                await query(
                    runner,
                    `UPDATE ${q(d, 'identity_authentication_state')} SET ${q(d, 'warning')} = ?, ${q(d, 'version')} = ${q(
                        d,
                        'version'
                    )} + 1 WHERE ${q(d, 'id')} = 1`,
                    [mismatchWarning]
                )
            }
            await runner.commitTransaction()
            const result = (await readAuthenticationState(dataSource)) as AuthenticationState
            effectiveMethod = result.activeMethod
            effectiveEpoch = result.authenticationEpoch
            return result
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
            )}, ${q(d, 'configurationFingerprint')}, ${q(d, 'providerKey')}, ${q(d, 'warning')}, ${q(d, 'sessionsEnded')}, ${q(
                d,
                'changedAt'
            )}, ${q(d, 'inferredAt')}, ${q(d, 'version')}) VALUES (1, ?, ?, 0, ?, ?, ?, ?, ?, ?, 1)`,
            [
                installationId,
                inferred.method,
                fingerprint,
                fingerprint ? stableWorkosProviderKey(installationId, fingerprint) : null,
                inferred.warning,
                sessionsEnded,
                changedAt ? new Date(changedAt) : null,
                now
            ]
        )
        await runner.commitTransaction()
        const result = (await readAuthenticationState(dataSource)) as AuthenticationState
        effectiveMethod = result.activeMethod
        effectiveEpoch = result.authenticationEpoch
        return result
    } catch (error) {
        await runner.rollbackTransaction()
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

export async function switchAuthenticationMethod(
    dataSource: DataSource,
    method: AuthenticationMethod,
    expectedVersion: number,
    audit?: { organizationId: string; actorId: string }
): Promise<AuthenticationState> {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    try {
        const current = await selectState(runner, true)
        if (!current || current.version !== expectedVersion) throw new Error('AUTH_STATE_CHANGED')
        const fingerprint = method === 'workos' ? workosConfigurationFingerprint() : null
        if (method === 'workos' && (!workosEnvironmentConfigured() || !fingerprint)) throw new Error('METHOD_NOT_READY')
        if (method === 'local' && !localUsersSetting()) throw new Error('METHOD_NOT_READY')
        if (current.activeMethod === method && current.configurationFingerprint === fingerprint) {
            await runner.commitTransaction()
            return current
        }
        const d = dialect(runner)
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
            [method, fingerprint, fingerprint ? stableWorkosProviderKey(current.installationId, fingerprint) : null, ended, now]
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
                        authenticationEpoch: current.authenticationEpoch + 1,
                        sessionsEnded: ended,
                        outcome: 'applied'
                    }),
                    now.getTime()
                ]
            )
        }
        await runner.commitTransaction()
        effectiveEpoch = current.authenticationEpoch + 1
        const result = (await readAuthenticationState(dataSource)) as AuthenticationState
        effectiveMethod = result.activeMethod
        effectiveEpoch = result.authenticationEpoch
        return result
    } catch (error) {
        await runner.rollbackTransaction()
        throw error
    } finally {
        await runner.release()
    }
}
