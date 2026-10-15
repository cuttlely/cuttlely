/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * One audit list: sign-in, lockout, invite, reset, role change, and user
 * disable in audit_event, plus settings changes read from the settings
 * history file. Passwords, tokens, secret values, and question text are
 * not stored.
 */

import { randomUUID } from 'crypto'
import { isSecretSettingKey, loadHistory, type HistoryEntry } from '../settings/history'
import { runtimeNumber } from '../settings/runtime'
import type { Sql } from './directory'

export const AUDIT_TYPES = [
    'sign_in_success',
    'sign_in_failure',
    'lockout',
    'invite',
    'reset',
    'role_change',
    'user_disable',
    'setting_change'
] as const

export type AuditType = (typeof AUDIT_TYPES)[number]

export const AUDIT_RETENTION_KEY = 'CUTTLELY_AUDIT_RETENTION_DAYS'
export const AUDIT_PAGE_DEFAULT = 50
export const AUDIT_PAGE_MAX = 100
const DAY_MS = 24 * 60 * 60 * 1000
const SUMMARY_MAX = 200
const DETAIL_MAX = 8000

const FORBIDDEN_KEY = /password|token|secret|question|authorization|cookie|credential|api[-_]?key|setupcode|bearer/i

export class AuditQueryError extends Error {
    readonly status = 400
    readonly code: string

    constructor(code: string, message: string) {
        super(message)
        this.name = 'AuditQueryError'
        this.code = code
    }
}

export interface AuditWrite {
    type: AuditType
    organizationId: string
    workspaceId: string | null
    userId: string | null
    actorId: string | null
    summary: string
    detail?: unknown
    at?: number
}

export interface AuditEvent {
    id: string
    type: AuditType
    at: string
    userId: string | null
    actorId: string | null
    workspaceId: string | null
    summary: string
    detail: Record<string, unknown> | null
}

export interface AuditPage {
    events: AuditEvent[]
    nextCursor: string | null
    limit: number
}

export interface AuditScope {
    organizationId: string
    workspaceId: string | null
    owner: boolean
}

export interface AuditQuery {
    type?: string
    user?: string
    cursor?: string | null
    limit: number
    historyDir: string
    now?: number
    retentionDays?: number
}

interface Cursor {
    at: string
    id: string
}

function q(dialect: Sql['type'], name: string): string {
    if (dialect === 'mysql' || dialect === 'mariadb') return '`' + name.replace(/`/g, '``') + '`'
    return '"' + name.replace(/"/g, '""') + '"'
}

function isAuditType(value: string): value is AuditType {
    return (AUDIT_TYPES as readonly string[]).includes(value)
}

/** Strings that must not be written, taken from forbidden fields before those fields are removed. */
function collectSecrets(value: unknown, secrets: string[]): void {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
        for (const item of value) collectSecrets(item, secrets)
        return
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (FORBIDDEN_KEY.test(key)) {
            if (typeof item === 'string' && item.length >= 3) secrets.push(item)
            else if (item && typeof item === 'object') collectSecrets(item, secrets)
            continue
        }
        collectSecrets(item, secrets)
    }
}

function omitForbidden(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(omitForbidden)
    if (!value || typeof value !== 'object') return value
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (FORBIDDEN_KEY.test(key)) continue
        out[key] = omitForbidden(item)
    }
    return out
}

function scrub(text: string, secrets: string[], fallback: string): string {
    let next = text
    for (const secret of secrets) {
        if (secret.length >= 3 && next.includes(secret)) next = next.split(secret).join('')
    }
    const trimmed = next.replace(/\s+/g, ' ').trim()
    return trimmed || fallback
}

export function auditSummary(type: AuditType): string {
    if (type === 'sign_in_success') return 'Signed in'
    if (type === 'sign_in_failure') return 'Sign-in failed'
    if (type === 'lockout') return 'Sign-in locked'
    if (type === 'invite') return 'Invite issued'
    if (type === 'reset') return 'Password reset'
    if (type === 'role_change') return 'Role changed'
    if (type === 'user_disable') return 'User disabled'
    return 'Settings changed'
}

/**
 * Removes passwords, tokens, secret values, and question text.
 * A leftover secret string is dropped from the summary as well.
 */
export function redactAudit(input: { summary: string; detail?: unknown; type: AuditType }): {
    summary: string
    detail: Record<string, unknown> | null
} {
    const secrets: string[] = []
    collectSecrets(input.detail, secrets)
    const cleaned = omitForbidden(input.detail)
    const detail =
        cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned) && Object.keys(cleaned as object).length
            ? (cleaned as Record<string, unknown>)
            : null
    let encoded = detail ? JSON.stringify(detail) : ''
    if (encoded && secrets.some((secret) => secret.length >= 3 && encoded.includes(secret))) {
        encoded = ''
    }
    if (encoded.length > DETAIL_MAX) encoded = ''
    const summary = scrub(input.summary, secrets, auditSummary(input.type)).slice(0, SUMMARY_MAX)
    return { summary, detail: encoded ? (JSON.parse(encoded) as Record<string, unknown>) : null }
}

function settingChange(entry: HistoryEntry): AuditEvent | null {
    if (typeof entry.seq !== 'number') return null
    const changes = (entry.changes || []).map((change) => {
        if (isSecretSettingKey(change.key) || FORBIDDEN_KEY.test(change.key) || change.secret) {
            return { key: change.key, values: 'hidden' }
        }
        return { key: change.key, from: change.from, to: change.to }
    })
    const redacted = redactAudit({
        type: 'setting_change',
        summary: auditSummary('setting_change'),
        detail: { kind: entry.kind, outcome: entry.outcome, changes }
    })
    return {
        id: `history:${entry.seq}`,
        type: 'setting_change',
        at: entry.at,
        userId: null,
        actorId: entry.actorId || null,
        workspaceId: null,
        summary: redacted.summary,
        detail: redacted.detail
    }
}

function olderThan(event: { at: string; id: string }, cursor: Cursor | null): boolean {
    if (!cursor) return true
    if (event.at !== cursor.at) return event.at < cursor.at
    return event.id < cursor.id
}

export function encodeAuditCursor(cursor: Cursor): string {
    return Buffer.from(JSON.stringify({ at: cursor.at, id: cursor.id }), 'utf8').toString('base64url')
}

export function decodeAuditCursor(token: string): Cursor {
    let parsed: unknown
    try {
        const raw = Buffer.from(token, 'base64url').toString('utf8')
        if (!raw.startsWith('{')) throw new Error('invalid')
        parsed = JSON.parse(raw)
    } catch {
        throw new AuditQueryError('INVALID_CURSOR', 'Cursor is not valid')
    }
    if (!parsed || typeof parsed !== 'object') throw new AuditQueryError('INVALID_CURSOR', 'Cursor is not valid')
    const at = (parsed as { at?: unknown }).at
    const id = (parsed as { id?: unknown }).id
    if (typeof at !== 'string' || !at || typeof id !== 'string' || !id || at.length > 40 || id.length > 80) {
        throw new AuditQueryError('INVALID_CURSOR', 'Cursor is not valid')
    }
    return { at, id }
}

export function retentionDays(env: Record<string, string | undefined> = process.env): number {
    return runtimeNumber(AUDIT_RETENTION_KEY, env)
}

export async function recordAudit(sql: Sql, event: AuditWrite, now = Date.now()): Promise<void> {
    const at = event.at ?? now
    const redacted = redactAudit({ type: event.type, summary: event.summary, detail: event.detail })
    const table = q(sql.type, 'audit_event')
    const days = retentionDays()
    await sql.query(`DELETE FROM ${table} WHERE ${q(sql.type, 'createdAt')} < ?`, [now - days * DAY_MS])
    await sql.query(
        `INSERT INTO ${table} (
            ${q(sql.type, 'id')}, ${q(sql.type, 'type')}, ${q(sql.type, 'organizationId')}, ${q(sql.type, 'workspaceId')},
            ${q(sql.type, 'userId')}, ${q(sql.type, 'actorId')}, ${q(sql.type, 'summary')}, ${q(sql.type, 'detail')}, ${q(
            sql.type,
            'createdAt'
        )}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            randomUUID(),
            event.type,
            event.organizationId,
            event.workspaceId,
            event.userId,
            event.actorId,
            redacted.summary,
            redacted.detail ? JSON.stringify(redacted.detail) : null,
            at
        ]
    )
}

/** A failed audit write does not change the action that already succeeded, and the warning has no values. */
export async function safeRecordAudit(sql: Sql, event: AuditWrite, now = Date.now()): Promise<void> {
    try {
        await recordAudit(sql, event, now)
    } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (/no such table|does not exist|doesn't exist|ER_NO_SUCH_TABLE/i.test(message)) return
        console.warn('[server]: audit event was not saved')
    }
}

export async function organizationsForUser(sql: Sql, userId: string): Promise<string[]> {
    const rows = await sql.query(
        `SELECT ${q(sql.type, 'organizationId')} AS organizationId FROM ${q(sql.type, 'organization_user')} WHERE ${q(
            sql.type,
            'userId'
        )} = ?`,
        [userId]
    )
    const ids = new Set<string>()
    for (const row of rows) {
        const value = row.organizationId ?? row.ORGANIZATIONID
        if (typeof value === 'string' && value) ids.add(value)
    }
    return [...ids]
}

function cell(row: Record<string, unknown>, name: string): unknown {
    if (name in row) return row[name]
    const upper = name.toUpperCase()
    if (upper in row) return row[upper]
    return undefined
}

function textOrNull(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null
    return String(value)
}

function mapRow(row: Record<string, unknown>): AuditEvent | null {
    const type = String(cell(row, 'type') || '')
    if (!isAuditType(type)) return null
    const at = Number(cell(row, 'createdAt'))
    if (!Number.isFinite(at)) return null
    let detail: Record<string, unknown> | null = null
    const raw = cell(row, 'detail')
    if (typeof raw === 'string' && raw) {
        try {
            const parsed = JSON.parse(raw) as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) detail = parsed as Record<string, unknown>
        } catch {
            detail = null
        }
    }
    return {
        id: String(cell(row, 'id') || ''),
        type,
        at: new Date(at).toISOString(),
        userId: textOrNull(cell(row, 'userId')),
        actorId: textOrNull(cell(row, 'actorId')),
        workspaceId: textOrNull(cell(row, 'workspaceId')),
        summary: String(cell(row, 'summary') || ''),
        detail
    }
}

function historyEvents(dir: string, now: number, days: number): AuditEvent[] {
    const cutoff = now - days * DAY_MS
    const events: AuditEvent[] = []
    for (const entry of loadHistory(dir)) {
        const at = Date.parse(entry.at)
        if (!Number.isFinite(at) || at < cutoff) continue
        const event = settingChange(entry)
        if (event) events.push(event)
    }
    return events
}

/**
 * Newest first. The cursor asks for rows strictly older than that time and id.
 * A non-owner sees events for the active team, and sign-in rows for people in that team.
 * Settings changes are the history file, included for anyone who can read this list.
 */
export async function pageAudit(sql: Sql, scope: AuditScope, query: AuditQuery): Promise<AuditPage> {
    const type = (query.type || '').trim()
    if (type && !isAuditType(type)) throw new AuditQueryError('INVALID_TYPE', 'type is not an audit event')
    const user = (query.user || '').trim()
    if (user.length > 255) throw new AuditQueryError('INVALID_USER', 'user is too long')
    const cursor = query.cursor ? decodeAuditCursor(query.cursor) : null
    const now = query.now ?? Date.now()
    const days = query.retentionDays ?? retentionDays()
    const table = q(sql.type, 'audit_event')
    await sql.query(`DELETE FROM ${table} WHERE ${q(sql.type, 'createdAt')} < ?`, [now - days * DAY_MS])

    const where: string[] = []
    const params: unknown[] = []
    if (scope.owner) {
        where.push(`(${q(sql.type, 'organizationId')} = ? OR ${q(sql.type, 'organizationId')} = '')`)
        params.push(scope.organizationId)
    } else {
        where.push(`${q(sql.type, 'organizationId')} = ?`)
        params.push(scope.organizationId)
        where.push(
            `(${q(sql.type, 'workspaceId')} = ? OR (${q(sql.type, 'workspaceId')} IS NULL AND ${q(sql.type, 'userId')} IN (SELECT ${q(
                sql.type,
                'userId'
            )} FROM ${q(sql.type, 'workspace_user')} WHERE ${q(sql.type, 'workspaceId')} = ?)))`
        )
        params.push(scope.workspaceId || '', scope.workspaceId || '')
    }
    if (type) {
        where.push(`${q(sql.type, 'type')} = ?`)
        params.push(type)
    }
    if (user) {
        where.push(`${q(sql.type, 'userId')} = ?`)
        params.push(user)
    }
    if (cursor) {
        const at = Date.parse(cursor.at)
        if (!Number.isFinite(at)) throw new AuditQueryError('INVALID_CURSOR', 'Cursor is not valid')
        where.push(`(${q(sql.type, 'createdAt')} < ? OR (${q(sql.type, 'createdAt')} = ? AND ${q(sql.type, 'id')} < ?))`)
        params.push(at, at, cursor.id)
    }
    const limit = query.limit
    const rows = await sql.query(
        `SELECT ${q(sql.type, 'id')} AS id, ${q(sql.type, 'type')} AS type, ${q(sql.type, 'userId')} AS userId,
                ${q(sql.type, 'actorId')} AS actorId, ${q(sql.type, 'workspaceId')} AS workspaceId,
                ${q(sql.type, 'summary')} AS summary, ${q(sql.type, 'detail')} AS detail, ${q(sql.type, 'createdAt')} AS createdAt
         FROM ${table}
         WHERE ${where.join(' AND ')}
         ORDER BY ${q(sql.type, 'createdAt')} DESC, ${q(sql.type, 'id')} DESC
         LIMIT ?`,
        [...params, limit + 1]
    )
    const fromTable = rows.map(mapRow).filter((row): row is AuditEvent => row !== null && Boolean(row.id))
    const wantHistory = !type || type === 'setting_change'
    const wantUser = !user
    const fromHistory =
        wantHistory && wantUser
            ? historyEvents(query.historyDir, now, days)
                  .filter((event) => olderThan(event, cursor))
                  .sort((a, b) => {
                      if (a.at !== b.at) return a.at < b.at ? 1 : -1
                      if (a.id !== b.id) return a.id < b.id ? 1 : -1
                      return 0
                  })
                  .slice(0, limit + 1)
            : []
    const merged = [...fromTable, ...fromHistory].sort((a, b) => {
        if (a.at !== b.at) return a.at < b.at ? 1 : -1
        if (a.id !== b.id) return a.id < b.id ? 1 : -1
        return 0
    })
    const page = merged.slice(0, limit)
    const last = page[page.length - 1]
    const more = merged.length > limit && last
    return {
        events: page,
        nextCursor: more ? encodeAuditCursor({ at: last.at, id: last.id }) : null,
        limit
    }
}
