/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import express, { NextFunction, Request, Response, Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { safeRecordAudit } from './auditLog'
import { scimBearerSecret } from './authenticationSecrets'
import { deactivateUserInTransaction, DirectoryError, QueryFn, Sql } from './directory'
import { utcDbTime, utcEpoch } from './dbTime'
import { applicationSql } from './production'
import {
    createGroup,
    deleteGroup,
    groupPatchChanges,
    groupsForOrganization,
    GroupRecord,
    mutateGroup,
    pageGroups,
    reconcileMappings,
    recordScimOperation
} from './scimGroups'

const CORE_USER = 'urn:ietf:params:scim:schemas:core:2.0:User'
const CORE_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group'
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error'
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'
const SERVICE_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'
const RESOURCE_TYPE_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:ResourceType'
const SCHEMA_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Schema'
const TOKEN_PREFIX = 'cuttlely_scim_'
const MAX_COUNT = 100
const MAX_OVERLAP_HOURS = 24

type TokenStatus = 'active' | 'overlap' | 'revoked'

export interface TokenActor {
    organizationId: string
    tokenId: string
    displayPrefix: string
    creatorId: string
}

export interface ScimTokenState {
    status: 'none' | TokenStatus
    displayPrefix: string | null
    createdAt: string | null
    createdBy: string | null
    lastUsedAt: string | null
    overlapEndsAt: string | null
    previousDisplayPrefix: string | null
}

export interface UserRecord {
    id: string
    organizationId: string
    userId: string
    externalId: string | null
    userName: string
    displayName: string
    givenName: string | null
    familyName: string | null
    workEmail: string | null
    deletedAt: string | null
    createdAt: string
    updatedAt: string
    userStatus: string
    membershipStatus: string
}

export class ScimError extends Error {
    constructor(readonly status: number, message: string, readonly scimType?: string) {
        super(message)
        this.name = 'ScimError'
    }
}

function q(sql: Sql, name: string): string {
    if (sql.type === 'mysql' || sql.type === 'mariadb') return '`' + name.replace(/`/g, '``') + '`'
    return '"' + name.replace(/"/g, '""') + '"'
}

function cell(row: Record<string, unknown>, key: string): unknown {
    if (key in row) return row[key]
    const wanted = key.toLowerCase()
    const found = Object.keys(row).find((item) => item.toLowerCase() === wanted)
    return found ? row[found] : undefined
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function nullable(value: unknown): string | null {
    const valueText = text(value).trim()
    return valueText || null
}

function iso(value: unknown): string | null {
    if (value == null || value === '') return null
    const epoch = utcEpoch(value)
    return epoch ? new Date(epoch).toISOString() : null
}

function tokenHmac(clear: string): string {
    return createHmac('sha256', scimBearerSecret()).update(clear).digest('hex')
}

function sameHmac(left: string, right: string): boolean {
    const a = Buffer.from(left, 'hex')
    const b = Buffer.from(right, 'hex')
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

function newToken(): { clear: string; hmac: string; displayPrefix: string } {
    const clear = TOKEN_PREFIX + randomBytes(32).toString('base64url')
    return { clear, hmac: tokenHmac(clear), displayPrefix: clear.slice(0, TOKEN_PREFIX.length + 7) + '…' }
}

export function errorBody(status: number, detail: string, scimType?: string): Record<string, unknown> {
    return { schemas: [ERROR_SCHEMA], status: String(status), ...(scimType ? { scimType } : {}), detail }
}

export function sendScimError(res: Response, status: number, detail: string, scimType?: string): void {
    const correlationId = text(res.locals.scimCorrelationId) || randomUUID()
    res.locals.scimCorrelationId = correlationId
    res.locals.scimErrorDetail = detail
    res.set('X-Correlation-ID', correlationId)
        .type('application/scim+json')
        .status(status)
        .json(errorBody(status, `${detail} Correlation ID: ${correlationId}.`, scimType))
}

export function scimBodyErrorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
    if (!error) return void next()
    const status = Number((error as { status?: unknown }).status)
    if (status === 413) return sendScimError(res, 413, 'The SCIM request body is too large.', 'tooMany')
    if (error instanceof SyntaxError) return sendScimError(res, 400, 'The JSON request body is invalid.', 'invalidSyntax')
    next(error)
}

async function configuration(query: QueryFn, sql: Sql, lock = false): Promise<Record<string, unknown>> {
    const suffix = lock && sql.type !== 'sqlite' ? ' FOR UPDATE' : ''
    const rows = await query(
        `SELECT ${q(sql, 'organizationId')} AS organizationId, ${q(sql, 'activeTokenId')} AS activeTokenId,
                ${q(sql, 'previousTokenId')} AS previousTokenId
         FROM ${q(sql, 'identity_scim_configuration')} WHERE ${q(sql, 'id')} = 1${suffix}`
    )
    if (!rows.length) throw new Error('SCIM_CONFIGURATION_MISSING')
    return rows[0]
}

async function tokenRow(query: QueryFn, sql: Sql, id: string | null): Promise<Record<string, unknown> | null> {
    if (!id) return null
    const rows = await query(
        `SELECT ${q(sql, 'id')} AS id, ${q(sql, 'organizationId')} AS organizationId, ${q(sql, 'tokenHmac')} AS tokenHmac,
                ${q(sql, 'displayPrefix')} AS displayPrefix, ${q(sql, 'status')} AS status,
                ${q(sql, 'createdAt')} AS createdAt, ${q(sql, 'createdBy')} AS createdBy,
                ${q(sql, 'lastUsedAt')} AS lastUsedAt, ${q(sql, 'overlapEndsAt')} AS overlapEndsAt,
                ${q(sql, 'revokedAt')} AS revokedAt
         FROM ${q(sql, 'identity_scim_token')} WHERE ${q(sql, 'id')} = ?`,
        [id]
    )
    return rows[0] || null
}

function latestTimestamp(...values: unknown[]): string | null {
    const timestamps = values.map(iso).filter((value): value is string => Boolean(value))
    return timestamps.sort().at(-1) || null
}

function publicTokenState(active: Record<string, unknown> | null, previous: Record<string, unknown> | null, now: number): ScimTokenState {
    if (!active) {
        const revoked = previous && text(cell(previous, 'status')) === 'revoked' ? previous : null
        return {
            status: revoked ? 'revoked' : 'none',
            displayPrefix: revoked ? text(cell(revoked, 'displayPrefix')) : null,
            createdAt: revoked ? iso(cell(revoked, 'createdAt')) : null,
            createdBy: revoked ? nullable(cell(revoked, 'createdBy')) : null,
            lastUsedAt: revoked ? iso(cell(revoked, 'lastUsedAt')) : null,
            overlapEndsAt: null,
            previousDisplayPrefix: null
        }
    }
    const overlapping = previous && text(cell(previous, 'status')) === 'overlap' && utcEpoch(cell(previous, 'overlapEndsAt')) > now
    return {
        status: overlapping ? 'overlap' : 'active',
        displayPrefix: text(cell(active, 'displayPrefix')),
        createdAt: iso(cell(active, 'createdAt')),
        createdBy: nullable(cell(active, 'createdBy')),
        lastUsedAt: latestTimestamp(cell(active, 'lastUsedAt'), previous ? cell(previous, 'lastUsedAt') : null),
        overlapEndsAt: overlapping ? iso(cell(previous, 'overlapEndsAt')) : null,
        previousDisplayPrefix: overlapping ? text(cell(previous, 'displayPrefix')) : null
    }
}

export async function readScimTokenState(sql: Sql, now = Date.now()): Promise<ScimTokenState> {
    const config = await configuration(sql.query, sql)
    const active = await tokenRow(sql.query, sql, nullable(cell(config, 'activeTokenId')))
    const previous = await tokenRow(sql.query, sql, nullable(cell(config, 'previousTokenId')))
    return publicTokenState(active, previous, now)
}

async function auditToken(sql: Sql, actorId: string, organizationId: string, operation: string): Promise<void> {
    await safeRecordAudit(sql, {
        type: 'scim_token',
        organizationId,
        workspaceId: null,
        userId: actorId,
        actorId,
        summary: `SCIM credential ${operation}`,
        detail: { operation }
    })
}

export async function createScimToken(
    sql: Sql,
    actor: { id: string; organizationId: string },
    now = Date.now()
): Promise<{ clear: string; state: ScimTokenState }> {
    const generated = newToken()
    await sql.transaction(async (query) => {
        const config = await configuration(query, sql, true)
        if (nullable(cell(config, 'activeTokenId'))) throw new ScimError(409, 'A SCIM credential already exists.', 'uniqueness')
        const id = randomUUID()
        const at = utcDbTime(sql.type, now)
        await query(
            `INSERT INTO ${q(sql, 'identity_scim_token')} (${q(sql, 'id')}, ${q(sql, 'organizationId')}, ${q(sql, 'tokenHmac')}, ${q(
                sql,
                'displayPrefix'
            )}, ${q(sql, 'status')}, ${q(sql, 'createdAt')}, ${q(sql, 'createdBy')})
             VALUES (?, ?, ?, ?, 'active', ?, ?)`,
            [id, actor.organizationId, generated.hmac, generated.displayPrefix, at, actor.id]
        )
        await query(
            `UPDATE ${q(sql, 'identity_scim_configuration')} SET ${q(sql, 'organizationId')} = ?, ${q(sql, 'activeTokenId')} = ?, ${q(
                sql,
                'previousTokenId'
            )} = NULL WHERE ${q(sql, 'id')} = 1`,
            [actor.organizationId, id]
        )
    })
    await auditToken(sql, actor.id, actor.organizationId, 'created')
    return { clear: generated.clear, state: await readScimTokenState(sql, now) }
}

export async function rotateScimToken(
    sql: Sql,
    actor: { id: string; organizationId: string },
    overlapHours = 1,
    now = Date.now()
): Promise<{ clear: string; state: ScimTokenState }> {
    if (!Number.isFinite(overlapHours) || overlapHours < 0 || overlapHours > MAX_OVERLAP_HOURS) {
        throw new ScimError(400, `Overlap must be between 0 and ${MAX_OVERLAP_HOURS} hours.`, 'invalidValue')
    }
    const generated = newToken()
    await sql.transaction(async (query) => {
        const config = await configuration(query, sql, true)
        const oldId = nullable(cell(config, 'activeTokenId'))
        const earlierId = nullable(cell(config, 'previousTokenId'))
        if (!oldId) throw new ScimError(409, 'Create a SCIM credential before rotating it.', 'noTarget')
        if (nullable(cell(config, 'organizationId')) !== actor.organizationId) throw new ScimError(403, 'Forbidden')
        const id = randomUUID()
        const at = utcDbTime(sql.type, now)
        const overlapEndsAt = utcDbTime(sql.type, now + overlapHours * 60 * 60 * 1000)
        if (earlierId) {
            await query(
                `UPDATE ${q(sql, 'identity_scim_token')} SET ${q(sql, 'status')} = 'revoked', ${q(sql, 'overlapEndsAt')} = NULL, ${q(
                    sql,
                    'revokedAt'
                )} = ? WHERE ${q(sql, 'id')} = ?`,
                [at, earlierId]
            )
        }
        await query(
            `UPDATE ${q(sql, 'identity_scim_token')} SET ${q(sql, 'status')} = ?, ${q(sql, 'overlapEndsAt')} = ?, ${q(
                sql,
                'revokedAt'
            )} = ? WHERE ${q(sql, 'id')} = ?`,
            overlapHours > 0 ? ['overlap', overlapEndsAt, null, oldId] : ['revoked', null, at, oldId]
        )
        await query(
            `INSERT INTO ${q(sql, 'identity_scim_token')} (${q(sql, 'id')}, ${q(sql, 'organizationId')}, ${q(sql, 'tokenHmac')}, ${q(
                sql,
                'displayPrefix'
            )}, ${q(sql, 'status')}, ${q(sql, 'createdAt')}, ${q(sql, 'createdBy')})
             VALUES (?, ?, ?, ?, 'active', ?, ?)`,
            [id, actor.organizationId, generated.hmac, generated.displayPrefix, at, actor.id]
        )
        await query(
            `UPDATE ${q(sql, 'identity_scim_configuration')} SET ${q(sql, 'activeTokenId')} = ?, ${q(sql, 'previousTokenId')} = ? WHERE ${q(
                sql,
                'id'
            )} = 1`,
            [id, oldId]
        )
    })
    await auditToken(sql, actor.id, actor.organizationId, 'rotated')
    return { clear: generated.clear, state: await readScimTokenState(sql, now) }
}

export async function endScimOverlap(sql: Sql, actor: { id: string; organizationId: string }, now = Date.now()): Promise<ScimTokenState> {
    await sql.transaction(async (query) => {
        const config = await configuration(query, sql, true)
        if (nullable(cell(config, 'organizationId')) !== actor.organizationId) throw new ScimError(403, 'Forbidden')
        const previousId = nullable(cell(config, 'previousTokenId'))
        if (previousId) {
            await query(
                `UPDATE ${q(sql, 'identity_scim_token')} SET ${q(sql, 'status')} = 'revoked', ${q(sql, 'overlapEndsAt')} = NULL, ${q(
                    sql,
                    'revokedAt'
                )} = ? WHERE ${q(sql, 'id')} = ?`,
                [utcDbTime(sql.type, now), previousId]
            )
            await query(`UPDATE ${q(sql, 'identity_scim_configuration')} SET ${q(sql, 'previousTokenId')} = NULL WHERE ${q(sql, 'id')} = 1`)
        }
    })
    await auditToken(sql, actor.id, actor.organizationId, 'overlap ended')
    return readScimTokenState(sql, now)
}

export async function revokeScimTokens(sql: Sql, actor: { id: string; organizationId: string }, now = Date.now()): Promise<ScimTokenState> {
    await sql.transaction(async (query) => {
        const config = await configuration(query, sql, true)
        if (nullable(cell(config, 'organizationId')) !== actor.organizationId) throw new ScimError(403, 'Forbidden')
        const lastId = nullable(cell(config, 'activeTokenId')) || nullable(cell(config, 'previousTokenId'))
        await query(
            `UPDATE ${q(sql, 'identity_scim_token')} SET ${q(sql, 'status')} = 'revoked', ${q(sql, 'overlapEndsAt')} = NULL, ${q(
                sql,
                'revokedAt'
            )} = ? WHERE ${q(sql, 'organizationId')} = ? AND ${q(sql, 'status')} <> 'revoked'`,
            [utcDbTime(sql.type, now), actor.organizationId]
        )
        await query(
            `UPDATE ${q(sql, 'identity_scim_configuration')} SET ${q(sql, 'activeTokenId')} = NULL, ${q(
                sql,
                'previousTokenId'
            )} = ? WHERE ${q(sql, 'id')} = 1`,
            [lastId]
        )
    })
    await auditToken(sql, actor.id, actor.organizationId, 'revoked')
    return readScimTokenState(sql, now)
}

export async function authenticateScimToken(sql: Sql, clear: string, now = Date.now()): Promise<TokenActor | null> {
    if (!clear.startsWith(TOKEN_PREFIX) || clear.length > 256) return null
    const config = await configuration(sql.query, sql)
    const active = await tokenRow(sql.query, sql, nullable(cell(config, 'activeTokenId')))
    const previous = await tokenRow(sql.query, sql, nullable(cell(config, 'previousTokenId')))
    const supplied = tokenHmac(clear)
    let match: Record<string, unknown> | null = null
    const activeMatches = active ? sameHmac(supplied, text(cell(active, 'tokenHmac'))) : false
    const previousMatches = previous ? sameHmac(supplied, text(cell(previous, 'tokenHmac'))) : false
    if (active && text(cell(active, 'status')) === 'active' && activeMatches) match = active
    const overlapEnd = previous ? utcEpoch(cell(previous, 'overlapEndsAt')) : 0
    if (!match && previous && text(cell(previous, 'status')) === 'overlap' && overlapEnd > now && previousMatches) {
        match = previous
    }
    if (!match) return null
    await sql.query(`UPDATE ${q(sql, 'identity_scim_token')} SET ${q(sql, 'lastUsedAt')} = ? WHERE ${q(sql, 'id')} = ?`, [
        utcDbTime(sql.type, now),
        text(cell(match, 'id'))
    ])
    return {
        organizationId: text(cell(match, 'organizationId')),
        tokenId: text(cell(match, 'id')),
        displayPrefix: text(cell(match, 'displayPrefix')),
        creatorId: text(cell(match, 'createdBy'))
    }
}

type FilterNode =
    | { kind: 'eq'; attribute: 'username' | 'externalid' | 'displayname'; value: string }
    | { kind: 'and' | 'or'; left: FilterNode; right: FilterNode }

interface FilterToken {
    kind: 'word' | 'string' | 'left' | 'right'
    value: string
}

function filterTokens(source: string): FilterToken[] {
    const tokens: FilterToken[] = []
    let index = 0
    while (index < source.length) {
        const char = source[index]
        if (/\s/.test(char)) {
            index += 1
            continue
        }
        if (char === '(' || char === ')') {
            tokens.push({ kind: char === '(' ? 'left' : 'right', value: char })
            index += 1
            continue
        }
        if (char === '"') {
            let value = ''
            index += 1
            let closed = false
            while (index < source.length) {
                if (source[index] === '"') {
                    index += 1
                    closed = true
                    break
                }
                if (source[index] === '\\') {
                    index += 1
                    if (index >= source.length || (source[index] !== '"' && source[index] !== '\\'))
                        throw new ScimError(400, 'Invalid filter.', 'invalidFilter')
                }
                value += source[index]
                index += 1
            }
            if (!closed) throw new ScimError(400, 'Invalid filter.', 'invalidFilter')
            tokens.push({ kind: 'string', value })
            continue
        }
        const start = index
        while (index < source.length && /[A-Za-z0-9._-]/.test(source[index])) index += 1
        if (start === index) throw new ScimError(400, 'Invalid filter.', 'invalidFilter')
        tokens.push({ kind: 'word', value: source.slice(start, index) })
    }
    return tokens
}

export function parseScimFilter(source: string): FilterNode {
    const tokens = filterTokens(source)
    let position = 0
    const primary = (): FilterNode => {
        if (tokens[position]?.kind === 'left') {
            position += 1
            const result = disjunction()
            if (tokens[position]?.kind !== 'right') throw new ScimError(400, 'Invalid filter.', 'invalidFilter')
            position += 1
            return result
        }
        const attribute = tokens[position++]
        const operator = tokens[position++]
        const value = tokens[position++]
        const normalized = attribute?.value.toLowerCase()
        if (
            attribute?.kind !== 'word' ||
            operator?.kind !== 'word' ||
            operator.value.toLowerCase() !== 'eq' ||
            value?.kind !== 'string' ||
            (normalized !== 'username' && normalized !== 'externalid' && normalized !== 'displayname')
        ) {
            throw new ScimError(400, 'Only eq filters on userName, externalId, and displayName are supported.', 'invalidFilter')
        }
        return { kind: 'eq', attribute: normalized, value: value.value }
    }
    const conjunction = (): FilterNode => {
        let left = primary()
        while (tokens[position]?.kind === 'word' && tokens[position].value.toLowerCase() === 'and') {
            position += 1
            left = { kind: 'and', left, right: primary() }
        }
        return left
    }
    const disjunction = (): FilterNode => {
        let left = conjunction()
        while (tokens[position]?.kind === 'word' && tokens[position].value.toLowerCase() === 'or') {
            position += 1
            left = { kind: 'or', left, right: conjunction() }
        }
        return left
    }
    if (!tokens.length) throw new ScimError(400, 'Invalid filter.', 'invalidFilter')
    const result = disjunction()
    if (position !== tokens.length) throw new ScimError(400, 'Invalid filter.', 'invalidFilter')
    return result
}

function matchesFilter(user: UserRecord, filter: FilterNode): boolean {
    if (filter.kind !== 'eq') {
        return filter.kind === 'and'
            ? matchesFilter(user, filter.left) && matchesFilter(user, filter.right)
            : matchesFilter(user, filter.left) || matchesFilter(user, filter.right)
    }
    const actual =
        filter.attribute === 'username' ? user.userName : filter.attribute === 'externalid' ? user.externalId || '' : user.displayName
    return filter.attribute === 'username' || filter.attribute === 'displayname'
        ? actual.toLowerCase() === filter.value.toLowerCase()
        : actual === filter.value
}

export function pageUsers(
    users: UserRecord[],
    query: { startIndex?: unknown; count?: unknown; filter?: unknown }
): { totalResults: number; startIndex: number; itemsPerPage: number; resources: UserRecord[] } {
    const startIndex = query.startIndex === undefined ? 1 : Number(query.startIndex)
    const count = query.count === undefined ? MAX_COUNT : Number(query.count)
    if (!Number.isInteger(startIndex) || startIndex < 1 || !Number.isInteger(count) || count < 0 || count > MAX_COUNT) {
        throw new ScimError(400, `startIndex must be at least 1 and count must be between 0 and ${MAX_COUNT}.`, 'invalidValue')
    }
    let selected = users
    if (query.filter !== undefined) {
        if (typeof query.filter !== 'string') throw new ScimError(400, 'Invalid filter.', 'invalidFilter')
        selected = users.filter((item) => matchesFilter(item, parseScimFilter(query.filter as string)))
    }
    const resources = selected.slice(startIndex - 1, startIndex - 1 + count)
    return { totalResults: selected.length, startIndex, itemsPerPage: resources.length, resources }
}

function userFromRow(row: Record<string, unknown>): UserRecord {
    return {
        id: text(cell(row, 'id')),
        organizationId: text(cell(row, 'organizationId')),
        userId: text(cell(row, 'userId')),
        externalId: nullable(cell(row, 'externalId')),
        userName: text(cell(row, 'userName')),
        displayName: text(cell(row, 'displayName')),
        givenName: nullable(cell(row, 'givenName')),
        familyName: nullable(cell(row, 'familyName')),
        workEmail: nullable(cell(row, 'workEmail')),
        deletedAt: iso(cell(row, 'deletedAt')),
        createdAt: iso(cell(row, 'createdAt')) || new Date(0).toISOString(),
        updatedAt: iso(cell(row, 'updatedAt')) || new Date(0).toISOString(),
        userStatus: text(cell(row, 'userStatus')).toLowerCase(),
        membershipStatus: text(cell(row, 'membershipStatus')).toLowerCase()
    }
}

export async function usersForOrganization(
    query: QueryFn,
    sql: Sql,
    organizationId: string,
    includeDeleted = false
): Promise<UserRecord[]> {
    const rows = await query(
        `SELECT su.${q(sql, 'id')} AS id, su.${q(sql, 'organizationId')} AS organizationId, su.${q(sql, 'userId')} AS userId,
                su.${q(sql, 'externalId')} AS externalId, su.${q(sql, 'userName')} AS userName,
                su.${q(sql, 'displayName')} AS displayName, su.${q(sql, 'givenName')} AS givenName,
                su.${q(sql, 'familyName')} AS familyName, su.${q(sql, 'workEmail')} AS workEmail,
                su.${q(sql, 'deletedAt')} AS deletedAt, su.${q(sql, 'createdAt')} AS createdAt,
                su.${q(sql, 'updatedAt')} AS updatedAt, u.${q(sql, 'status')} AS userStatus,
                ou.${q(sql, 'status')} AS membershipStatus
         FROM ${q(sql, 'identity_scim_user')} su
         INNER JOIN ${q(sql, 'user')} u ON u.${q(sql, 'id')} = su.${q(sql, 'userId')}
         INNER JOIN ${q(sql, 'organization_user')} ou ON ou.${q(sql, 'organizationId')} = su.${q(sql, 'organizationId')} AND ou.${q(
            sql,
            'userId'
        )} = su.${q(sql, 'userId')}
         WHERE su.${q(sql, 'organizationId')} = ? ${includeDeleted ? '' : `AND su.${q(sql, 'deletedAt')} IS NULL`}
         ORDER BY su.${q(sql, 'createdAt')} ASC, su.${q(sql, 'id')} ASC`,
        [organizationId]
    )
    return rows.map(userFromRow)
}

function requestedAttributes(query: Request['query']): { include: Set<string> | null; exclude: Set<string> } {
    const list = (value: unknown): string[] =>
        typeof value === 'string'
            ? value
                  .split(',')
                  .map((item) => item.trim().toLowerCase())
                  .filter(Boolean)
            : []
    const includeList = list(query.attributes)
    return { include: includeList.length ? new Set(includeList) : null, exclude: new Set(list(query.excludedAttributes)) }
}

function scimUser(user: UserRecord, selection?: { include: Set<string> | null; exclude: Set<string> }): Record<string, unknown> {
    const full: Record<string, unknown> = {
        schemas: [CORE_USER],
        id: user.id,
        externalId: user.externalId,
        userName: user.userName,
        displayName: user.displayName,
        name: { givenName: user.givenName, familyName: user.familyName },
        emails: user.workEmail ? [{ value: user.workEmail, type: 'work', primary: true }] : [],
        active: user.userStatus === 'active' && user.membershipStatus === 'active',
        meta: { resourceType: 'User', created: user.createdAt, lastModified: user.updatedAt, location: `/api/v1/scim/v2/Users/${user.id}` }
    }
    if (!selection) return full
    const always = new Set(['schemas', 'id', 'meta'])
    for (const key of Object.keys(full)) {
        const lower = key.toLowerCase()
        if (always.has(lower)) continue
        if ((selection.include && !selection.include.has(lower)) || selection.exclude.has(lower)) delete full[key]
    }
    return full
}

export function scimGroup(group: GroupRecord, selection?: { include: Set<string> | null; exclude: Set<string> }): Record<string, unknown> {
    const full: Record<string, unknown> = {
        schemas: [CORE_GROUP],
        id: group.id,
        externalId: group.externalId,
        displayName: group.displayName,
        members: group.members,
        meta: {
            resourceType: 'Group',
            created: group.createdAt,
            lastModified: group.updatedAt,
            location: `/api/v1/scim/v2/Groups/${group.id}`
        }
    }
    if (!selection) return full
    const always = new Set(['schemas', 'id', 'meta'])
    for (const key of Object.keys(full)) {
        const lower = key.toLowerCase()
        if (always.has(lower)) continue
        if ((selection.include && !selection.include.has(lower)) || selection.exclude.has(lower)) delete full[key]
    }
    return full
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ScimError(400, 'A JSON object is required.', 'invalidSyntax')
    return value as Record<string, unknown>
}

function booleanValue(value: unknown): boolean {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string' && /^(true|false)$/i.test(value)) return value.toLowerCase() === 'true'
    throw new ScimError(400, 'active must be true or false.', 'invalidValue')
}

function emailValue(record: Record<string, unknown>): string | null {
    if (typeof record.userName === 'string') return record.userName.trim()
    const emails = record.emails
    if (Array.isArray(emails)) {
        const work = emails.find(
            (item) => item && typeof item === 'object' && text((item as Record<string, unknown>).type).toLowerCase() === 'work'
        )
        return nullable(work && (work as Record<string, unknown>).value)
    }
    return null
}

function validUserName(value: string): boolean {
    return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

async function memberRoleId(query: QueryFn, sql: Sql): Promise<string> {
    const rows = await query(
        `SELECT ${q(sql, 'id')} AS id FROM ${q(sql, 'role')} WHERE LOWER(${q(sql, 'name')}) = 'member'
         ORDER BY CASE WHEN ${q(sql, 'organizationId')} IS NULL THEN 0 ELSE 1 END, ${q(sql, 'createdDate')} ASC LIMIT 1`
    )
    const id = text(cell(rows[0] || {}, 'id'))
    if (!id) throw new Error('MEMBER_ROLE_MISSING')
    return id
}

async function auditUser(
    sql: Sql,
    actor: TokenActor,
    operation: string,
    userId: string | null,
    outcome: 'applied' | 'refused' = 'applied'
): Promise<void> {
    await safeRecordAudit(sql, {
        type: 'scim_user',
        organizationId: actor.organizationId,
        workspaceId: null,
        userId,
        actorId: 'scim',
        summary: outcome === 'applied' ? `SCIM user ${operation}` : `SCIM user ${operation} refused`,
        detail: { operation, outcome, displayPrefix: actor.displayPrefix }
    })
}

export async function createUser(sql: Sql, actor: TokenActor, body: unknown, now = Date.now()): Promise<UserRecord> {
    const record = object(body)
    const userName = emailValue(record) || ''
    if (!validUserName(userName)) throw new ScimError(400, 'userName must be a valid email address.', 'invalidValue')
    const externalId = nullable(record.externalId)
    const name = record.name && typeof record.name === 'object' ? (record.name as Record<string, unknown>) : {}
    const givenName = nullable(name.givenName)
    const familyName = nullable(name.familyName)
    const displayName = nullable(record.displayName) || [givenName, familyName].filter(Boolean).join(' ') || userName
    const workEmail = emailValue({ emails: record.emails }) || userName
    const active = record.active === undefined ? true : booleanValue(record.active)
    const normalized = userName.toLowerCase()
    let resourceId = ''
    let internalId = ''
    try {
        await sql.transaction(async (query) => {
            const links = await usersForOrganization(query, sql, actor.organizationId, true)
            const activeConflict = links.find(
                (item) => !item.deletedAt && (item.userName.toLowerCase() === normalized || (externalId && item.externalId === externalId))
            )
            if (activeConflict) throw new ScimError(409, 'A matching SCIM user already exists.', 'uniqueness')
            const deleted = links.find(
                (item) => item.deletedAt && (item.userName.toLowerCase() === normalized || (externalId && item.externalId === externalId))
            )
            const at = utcDbTime(sql.type, now)
            if (deleted) {
                resourceId = deleted.id
                internalId = deleted.userId
                await query(
                    `UPDATE ${q(sql, 'identity_scim_user')} SET ${q(sql, 'externalId')} = ?, ${q(sql, 'userName')} = ?, ${q(
                        sql,
                        'normalizedUserName'
                    )} = ?, ${q(sql, 'displayName')} = ?, ${q(sql, 'givenName')} = ?, ${q(sql, 'familyName')} = ?, ${q(
                        sql,
                        'workEmail'
                    )} = ?, ${q(sql, 'deletedAt')} = NULL, ${q(sql, 'updatedAt')} = ? WHERE ${q(sql, 'id')} = ?`,
                    [externalId, userName, normalized, displayName, givenName, familyName, workEmail, at, resourceId]
                )
                await query(
                    `UPDATE ${q(sql, 'user')} SET ${q(sql, 'name')} = ?, ${q(sql, 'email')} = ?, ${q(sql, 'status')} = 'active', ${q(
                        sql,
                        'updatedBy'
                    )} = ?, ${q(sql, 'updatedDate')} = CURRENT_TIMESTAMP WHERE ${q(sql, 'id')} = ?`,
                    [displayName, userName, actor.creatorId, internalId]
                )
                await query(
                    `UPDATE ${q(sql, 'organization_user')} SET ${q(sql, 'status')} = 'active', ${q(sql, 'updatedBy')} = ?, ${q(
                        sql,
                        'updatedDate'
                    )} = CURRENT_TIMESTAMP WHERE ${q(sql, 'organizationId')} = ? AND ${q(sql, 'userId')} = ?`,
                    [actor.creatorId, actor.organizationId, internalId]
                )
                if (!active) await deactivateUserInTransaction(query, sql, actor.organizationId, internalId, now)
                await reconcileMappings(query, sql, actor.organizationId, actor.creatorId, now)
                return
            }
            const candidates = await query(
                `SELECT u.${q(sql, 'id')} AS id FROM ${q(sql, 'user')} u
             INNER JOIN ${q(sql, 'organization_user')} ou ON ou.${q(sql, 'userId')} = u.${q(sql, 'id')}
             INNER JOIN ${q(sql, 'role')} r ON r.${q(sql, 'id')} = ou.${q(sql, 'roleId')}
             LEFT JOIN ${q(sql, 'identity_scim_user')} su ON su.${q(sql, 'userId')} = u.${q(sql, 'id')}
             WHERE ou.${q(sql, 'organizationId')} = ? AND LOWER(u.${q(sql, 'email')}) = ?
               AND su.${q(sql, 'id')} IS NULL AND LOWER(r.${q(sql, 'name')}) <> 'owner'`,
                [actor.organizationId, normalized]
            )
            if (candidates.length === 1) {
                internalId = text(cell(candidates[0], 'id'))
            } else {
                internalId = randomUUID()
                await query(
                    `INSERT INTO ${q(sql, 'user')} (${q(sql, 'id')}, ${q(sql, 'name')}, ${q(sql, 'email')}, ${q(sql, 'credential')}, ${q(
                        sql,
                        'status'
                    )}, ${q(sql, 'createdBy')}, ${q(sql, 'updatedBy')}) VALUES (?, ?, ?, NULL, 'active', ?, ?)`,
                    [internalId, displayName, userName, actor.creatorId, actor.creatorId]
                )
                const roleId = await memberRoleId(query, sql)
                await query(
                    `INSERT INTO ${q(sql, 'organization_user')} (${q(sql, 'organizationId')}, ${q(sql, 'userId')}, ${q(sql, 'roleId')}, ${q(
                        sql,
                        'status'
                    )}, ${q(sql, 'createdBy')}, ${q(sql, 'updatedBy')}) VALUES (?, ?, ?, 'active', ?, ?)`,
                    [actor.organizationId, internalId, roleId, actor.creatorId, actor.creatorId]
                )
            }
            resourceId = randomUUID()
            await query(
                `INSERT INTO ${q(sql, 'identity_scim_user')} (${q(sql, 'id')}, ${q(sql, 'organizationId')}, ${q(sql, 'userId')}, ${q(
                    sql,
                    'externalId'
                )}, ${q(sql, 'userName')}, ${q(sql, 'normalizedUserName')}, ${q(sql, 'displayName')}, ${q(sql, 'givenName')}, ${q(
                    sql,
                    'familyName'
                )}, ${q(sql, 'workEmail')}, ${q(sql, 'createdAt')}, ${q(sql, 'updatedAt')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    resourceId,
                    actor.organizationId,
                    internalId,
                    externalId,
                    userName,
                    normalized,
                    displayName,
                    givenName,
                    familyName,
                    workEmail,
                    at,
                    at
                ]
            )
            if (active) {
                await query(
                    `UPDATE ${q(sql, 'user')} SET ${q(sql, 'status')} = 'active', ${q(sql, 'updatedDate')} = CURRENT_TIMESTAMP
                 WHERE ${q(sql, 'id')} = ? AND LOWER(${q(sql, 'status')}) = 'disable'`,
                    [internalId]
                )
                await query(
                    `UPDATE ${q(sql, 'organization_user')} SET ${q(sql, 'status')} = 'active', ${q(
                        sql,
                        'updatedDate'
                    )} = CURRENT_TIMESTAMP WHERE ${q(sql, 'organizationId')} = ? AND ${q(sql, 'userId')} = ?`,
                    [actor.organizationId, internalId]
                )
            } else {
                await deactivateUserInTransaction(query, sql, actor.organizationId, internalId, now)
            }
            await reconcileMappings(query, sql, actor.organizationId, actor.creatorId, now)
        })
    } catch (error) {
        if (error instanceof DirectoryError && error.status === 409) {
            await auditUser(sql, actor, 'created', internalId || null, 'refused')
            throw new ScimError(409, error.message, 'mutability')
        }
        throw error
    }
    await auditUser(sql, actor, 'created', internalId)
    const created = (await usersForOrganization(sql.query, sql, actor.organizationId)).find((item) => item.id === resourceId)
    if (!created) throw new Error('SCIM_USER_CREATE_FAILED')
    return created
}

export interface UserChanges {
    userName?: string
    externalId?: string | null
    displayName?: string
    givenName?: string | null
    familyName?: string | null
    workEmail?: string | null
    active?: boolean
}

export function operationCategoryForUserChanges(changes: UserChanges): 'usersDisabled' | 'usersUpdated' {
    return changes.active === false ? 'usersDisabled' : 'usersUpdated'
}

function replaceChanges(value: Record<string, unknown>): UserChanges {
    const name = value.name && typeof value.name === 'object' ? (value.name as Record<string, unknown>) : {}
    const changes: UserChanges = {
        userName: typeof value.userName === 'string' ? value.userName.trim() : undefined,
        externalId: 'externalId' in value ? nullable(value.externalId) : undefined,
        displayName: typeof value.displayName === 'string' ? value.displayName.trim() : undefined,
        givenName: 'givenName' in name ? nullable(name.givenName) : undefined,
        familyName: 'familyName' in name ? nullable(name.familyName) : undefined,
        workEmail: emailValue({ emails: value.emails })
    }
    if ('active' in value) changes.active = booleanValue(value.active)
    return changes
}

export function patchChanges(body: unknown): UserChanges {
    const record = object(body)
    if (!Array.isArray(record.Operations)) throw new ScimError(400, 'Operations are required.', 'invalidSyntax')
    const changes: UserChanges = {}
    for (const raw of record.Operations) {
        const operation = object(raw)
        const op = text(operation.op).toLowerCase()
        if (op !== 'replace' && op !== 'add' && op !== 'remove') throw new ScimError(400, 'Unsupported PATCH operation.', 'invalidSyntax')
        const path = nullable(operation.path)?.toLowerCase()
        if (!path) {
            if (op === 'remove') throw new ScimError(400, 'A path is required for remove.', 'invalidSyntax')
            Object.assign(changes, replaceChanges(object(operation.value)))
            continue
        }
        const remove = op === 'remove'
        if (path === 'active') {
            if (remove) throw new ScimError(400, 'active cannot be removed.', 'mutability')
            changes.active = booleanValue(operation.value)
        } else if (path === 'username') {
            if (remove || typeof operation.value !== 'string') throw new ScimError(400, 'userName requires a value.', 'invalidValue')
            changes.userName = operation.value.trim()
        } else if (path === 'externalid') changes.externalId = remove ? null : nullable(operation.value)
        else if (path === 'displayname') changes.displayName = remove ? '' : text(operation.value).trim()
        else if (path === 'name.givenname') changes.givenName = remove ? null : nullable(operation.value)
        else if (path === 'name.familyname') changes.familyName = remove ? null : nullable(operation.value)
        else if (/^emails\s*\[\s*type\s+eq\s+"work"\s*\]\.value$/i.test(path)) {
            changes.workEmail = remove ? null : nullable(operation.value)
        } else throw new ScimError(400, 'Unsupported PATCH path.', 'invalidSyntax')
    }
    return changes
}

export async function mutateUser(
    sql: Sql,
    actor: TokenActor,
    resourceId: string,
    changes: UserChanges,
    operation: string,
    now = Date.now()
): Promise<UserRecord> {
    let internalId = ''
    try {
        await sql.transaction(async (query) => {
            const current = (await usersForOrganization(query, sql, actor.organizationId)).find((item) => item.id === resourceId)
            if (!current) throw new ScimError(404, 'User not found.', 'noTarget')
            internalId = current.userId
            const userName = changes.userName === undefined ? current.userName : changes.userName
            if (!validUserName(userName)) throw new ScimError(400, 'userName must be a valid email address.', 'invalidValue')
            if (changes.active === false) await deactivateUserInTransaction(query, sql, actor.organizationId, current.userId, now)
            if (changes.active === true) {
                await query(
                    `UPDATE ${q(sql, 'user')} SET ${q(sql, 'status')} = 'active', ${q(sql, 'updatedDate')} = CURRENT_TIMESTAMP WHERE ${q(
                        sql,
                        'id'
                    )} = ? AND LOWER(${q(sql, 'status')}) = 'disable'`,
                    [current.userId]
                )
                await query(
                    `UPDATE ${q(sql, 'organization_user')} SET ${q(sql, 'status')} = 'active', ${q(
                        sql,
                        'updatedDate'
                    )} = CURRENT_TIMESTAMP WHERE ${q(sql, 'organizationId')} = ? AND ${q(sql, 'userId')} = ?`,
                    [actor.organizationId, current.userId]
                )
            }
            const externalId = changes.externalId === undefined ? current.externalId : changes.externalId
            const displayName = changes.displayName === undefined ? current.displayName : changes.displayName || userName
            const givenName = changes.givenName === undefined ? current.givenName : changes.givenName
            const familyName = changes.familyName === undefined ? current.familyName : changes.familyName
            const workEmail = changes.workEmail === undefined ? current.workEmail : changes.workEmail
            await query(
                `UPDATE ${q(sql, 'identity_scim_user')} SET ${q(sql, 'externalId')} = ?, ${q(sql, 'userName')} = ?, ${q(
                    sql,
                    'normalizedUserName'
                )} = ?, ${q(sql, 'displayName')} = ?, ${q(sql, 'givenName')} = ?, ${q(sql, 'familyName')} = ?, ${q(
                    sql,
                    'workEmail'
                )} = ?, ${q(sql, 'updatedAt')} = ? WHERE ${q(sql, 'id')} = ?`,
                [
                    externalId,
                    userName,
                    userName.toLowerCase(),
                    displayName,
                    givenName,
                    familyName,
                    workEmail,
                    utcDbTime(sql.type, now),
                    resourceId
                ]
            )
            await query(
                `UPDATE ${q(sql, 'user')} SET ${q(sql, 'name')} = ?, ${q(sql, 'email')} = ?, ${q(sql, 'updatedBy')} = ?, ${q(
                    sql,
                    'updatedDate'
                )} = CURRENT_TIMESTAMP WHERE ${q(sql, 'id')} = ?`,
                [displayName, userName, actor.creatorId, current.userId]
            )
            if (changes.active !== undefined) await reconcileMappings(query, sql, actor.organizationId, actor.creatorId, now)
        })
    } catch (error) {
        if (error instanceof DirectoryError && error.status === 409) {
            await auditUser(sql, actor, operation, internalId || null, 'refused')
            throw new ScimError(409, error.message, 'mutability')
        }
        const message = error instanceof Error ? error.message : ''
        if (/unique|duplicate/i.test(message)) throw new ScimError(409, 'A matching value already exists.', 'uniqueness')
        throw error
    }
    await auditUser(sql, actor, operation, internalId)
    const updated = (await usersForOrganization(sql.query, sql, actor.organizationId)).find((item) => item.id === resourceId)
    if (!updated) throw new ScimError(404, 'User not found.', 'noTarget')
    return updated
}

export async function deleteUser(sql: Sql, actor: TokenActor, resourceId: string, now = Date.now()): Promise<void> {
    let internalId = ''
    try {
        await sql.transaction(async (query) => {
            const current = (await usersForOrganization(query, sql, actor.organizationId)).find((item) => item.id === resourceId)
            if (!current) throw new ScimError(404, 'User not found.', 'noTarget')
            internalId = current.userId
            await deactivateUserInTransaction(query, sql, actor.organizationId, current.userId, now)
            await query(`DELETE FROM ${q(sql, 'identity_scim_group_member')} WHERE ${q(sql, 'scimUserId')} = ?`, [resourceId])
            await query(
                `UPDATE ${q(sql, 'identity_scim_user')} SET ${q(sql, 'deletedAt')} = ?, ${q(sql, 'updatedAt')} = ? WHERE ${q(
                    sql,
                    'id'
                )} = ?`,
                [utcDbTime(sql.type, now), utcDbTime(sql.type, now), resourceId]
            )
            await reconcileMappings(query, sql, actor.organizationId, actor.creatorId, now)
        })
    } catch (error) {
        if (error instanceof DirectoryError && error.status === 409) {
            await auditUser(sql, actor, 'deleted', internalId || null, 'refused')
            throw new ScimError(409, error.message, 'mutability')
        }
        throw error
    }
    await auditUser(sql, actor, 'deleted', internalId)
}

export const serviceProviderConfig = {
    schemas: [SERVICE_SCHEMA],
    documentationUri: '/docs/reference/scim-api',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_COUNT },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
        {
            type: 'oauthbearertoken',
            name: 'Bearer Token',
            description: 'SCIM bearer authentication',
            specUri: 'https://www.rfc-editor.org/rfc/rfc6750',
            primary: true
        }
    ],
    meta: { resourceType: 'ServiceProviderConfig', location: '/api/v1/scim/v2/ServiceProviderConfig' }
}

export const userResourceType = {
    schemas: [RESOURCE_TYPE_SCHEMA],
    id: 'User',
    name: 'User',
    endpoint: '/Users',
    description: 'User account',
    schema: CORE_USER,
    schemaExtensions: [],
    meta: { resourceType: 'ResourceType', location: '/api/v1/scim/v2/ResourceTypes/User' }
}

export const groupResourceType = {
    schemas: [RESOURCE_TYPE_SCHEMA],
    id: 'Group',
    name: 'Group',
    endpoint: '/Groups',
    description: 'Provider group',
    schema: CORE_GROUP,
    schemaExtensions: [],
    meta: { resourceType: 'ResourceType', location: '/api/v1/scim/v2/ResourceTypes/Group' }
}

export const userSchema = {
    schemas: [SCHEMA_SCHEMA],
    id: CORE_USER,
    name: 'User',
    description: 'User account',
    attributes: [
        {
            name: 'userName',
            type: 'string',
            multiValued: false,
            required: true,
            caseExact: false,
            mutability: 'readWrite',
            returned: 'default',
            uniqueness: 'server'
        },
        {
            name: 'externalId',
            type: 'string',
            multiValued: false,
            required: false,
            caseExact: true,
            mutability: 'readWrite',
            returned: 'default',
            uniqueness: 'server'
        },
        {
            name: 'displayName',
            type: 'string',
            multiValued: false,
            required: false,
            caseExact: false,
            mutability: 'readWrite',
            returned: 'default',
            uniqueness: 'none'
        },
        {
            name: 'name',
            type: 'complex',
            multiValued: false,
            required: false,
            mutability: 'readWrite',
            returned: 'default',
            subAttributes: [
                {
                    name: 'givenName',
                    type: 'string',
                    multiValued: false,
                    required: false,
                    caseExact: false,
                    mutability: 'readWrite',
                    returned: 'default',
                    uniqueness: 'none'
                },
                {
                    name: 'familyName',
                    type: 'string',
                    multiValued: false,
                    required: false,
                    caseExact: false,
                    mutability: 'readWrite',
                    returned: 'default',
                    uniqueness: 'none'
                }
            ]
        },
        {
            name: 'emails',
            type: 'complex',
            multiValued: true,
            required: false,
            mutability: 'readWrite',
            returned: 'default',
            subAttributes: [
                {
                    name: 'value',
                    type: 'string',
                    multiValued: false,
                    required: true,
                    caseExact: false,
                    mutability: 'readWrite',
                    returned: 'default',
                    uniqueness: 'none'
                },
                {
                    name: 'type',
                    type: 'string',
                    multiValued: false,
                    required: false,
                    caseExact: false,
                    mutability: 'readWrite',
                    returned: 'default',
                    uniqueness: 'none',
                    canonicalValues: ['work']
                },
                { name: 'primary', type: 'boolean', multiValued: false, required: false, mutability: 'readWrite', returned: 'default' }
            ]
        },
        { name: 'active', type: 'boolean', multiValued: false, required: false, mutability: 'readWrite', returned: 'default' }
    ],
    meta: { resourceType: 'Schema', location: `/api/v1/scim/v2/Schemas/${CORE_USER}` }
}

export const groupSchema = {
    schemas: [SCHEMA_SCHEMA],
    id: CORE_GROUP,
    name: 'Group',
    description: 'Provider group',
    attributes: [
        {
            name: 'displayName',
            type: 'string',
            multiValued: false,
            required: true,
            caseExact: false,
            mutability: 'readWrite',
            returned: 'default',
            uniqueness: 'server'
        },
        {
            name: 'externalId',
            type: 'string',
            multiValued: false,
            required: false,
            caseExact: true,
            mutability: 'readWrite',
            returned: 'default',
            uniqueness: 'server'
        },
        {
            name: 'members',
            type: 'complex',
            multiValued: true,
            required: false,
            mutability: 'readWrite',
            returned: 'default',
            subAttributes: [
                {
                    name: 'value',
                    type: 'string',
                    multiValued: false,
                    required: true,
                    caseExact: true,
                    mutability: 'immutable',
                    returned: 'default',
                    uniqueness: 'none'
                },
                {
                    name: 'display',
                    type: 'string',
                    multiValued: false,
                    required: false,
                    caseExact: false,
                    mutability: 'readOnly',
                    returned: 'default',
                    uniqueness: 'none'
                }
            ]
        }
    ],
    meta: { resourceType: 'Schema', location: `/api/v1/scim/v2/Schemas/${CORE_GROUP}` }
}

const failedAuditAt = new Map<string, number>()
const FAILURE_AUDIT_WINDOW_MS = 5 * 60 * 1000

async function auditAuthenticationFailure(sql: Sql, organizationId: string): Promise<void> {
    if (!organizationId) return
    const previous = failedAuditAt.get(organizationId) || 0
    if (Date.now() - previous < FAILURE_AUDIT_WINDOW_MS) return
    failedAuditAt.set(organizationId, Date.now())
    await safeRecordAudit(sql, {
        type: 'scim_auth_failure',
        organizationId,
        workspaceId: null,
        userId: null,
        actorId: 'scim',
        summary: 'SCIM authentication failed',
        detail: { outcome: 'failed' }
    })
}

function authorization(req: Request): string {
    const header = req.headers.authorization
    if (typeof header !== 'string') return ''
    const match = /^Bearer ([^\s]+)$/i.exec(header)
    return match ? match[1] : ''
}

function scimContentType(req: Request, res: Response, next: NextFunction): void {
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return void next()
    if (req.is('application/scim+json') || req.is('application/json')) return void next()
    sendScimError(res, 415, 'Content-Type must be application/scim+json or application/json.', 'invalidSyntax')
}

const scimRateLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: false,
    legacyHeaders: false,
    handler: (_req, res) => sendScimError(res, 429, 'Too many SCIM requests.', 'tooMany')
})

declare global {
    namespace Express {
        interface Request {
            scimActor?: TokenActor
        }
    }
}

async function scimAuthentication(req: Request, res: Response, next: NextFunction): Promise<void> {
    const sql = applicationSql()
    try {
        const actor = await authenticateScimToken(sql, authorization(req))
        if (!actor) {
            let organizationId = ''
            try {
                organizationId = nullable(cell(await configuration(sql.query, sql), 'organizationId')) || ''
            } catch {
                // A missing migration is handled by the normal server error path.
            }
            res.locals.scimOrganizationId = organizationId
            res.locals.scimFailureCategory = 'authentication'
            await auditAuthenticationFailure(sql, organizationId)
            sendScimError(res, 401, 'A valid SCIM bearer credential is required.')
            return
        }
        req.scimActor = actor
        res.locals.scimOrganizationId = actor.organizationId
        next()
    } catch {
        sendScimError(res, 500, 'The SCIM request could not be authenticated.')
    }
}

function operationCategory(req: Request, status: number): string {
    if (status >= 400) return text(req.res?.locals.scimFailureCategory) || (status === 401 ? 'authentication' : 'request')
    const parsedCategory = text(req.res?.locals.scimOperationCategory)
    if (parsedCategory) return parsedCategory
    const path = req.path.toLowerCase()
    if (path.startsWith('/users')) {
        if (req.method === 'POST') return 'usersCreated'
        if (req.method === 'DELETE') return 'usersDisabled'
        if (req.method === 'PATCH' || req.method === 'PUT') return 'usersUpdated'
        return 'userRequests'
    }
    if (path.startsWith('/groups')) {
        if (req.method === 'PATCH' && /members/i.test(JSON.stringify(req.body || {}))) return 'membershipOperations'
        return 'groupOperations'
    }
    return 'discoveryRequests'
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => void handler(req, res).catch(next)
}

export const identityScimRouter = Router()

identityScimRouter.use((_req, res, next) => {
    const correlationId = randomUUID()
    res.locals.scimCorrelationId = correlationId
    res.type('application/scim+json').set('Cache-Control', 'no-store').set('X-Correlation-ID', correlationId)
    next()
})
identityScimRouter.use((req, res, next) => {
    res.once('finish', () => {
        const organizationId = text(res.locals.scimOrganizationId)
        if (!organizationId) return
        void recordScimOperation(applicationSql(), {
            organizationId,
            category: operationCategory(req, res.statusCode),
            outcome: res.statusCode < 400 ? 'success' : 'failed',
            correlationId: text(res.locals.scimCorrelationId),
            detail: res.statusCode < 400 ? null : text(res.locals.scimErrorDetail) || 'The request was refused.'
        }).catch(() => undefined)
    })
    next()
})
const SCIM_JSON_LIMIT = '256kb'
const scimJsonParser = express.json({ limit: SCIM_JSON_LIMIT, type: ['application/scim+json', 'application/json'] })

identityScimRouter.use(scimRateLimit, scimAuthentication, scimContentType, scimJsonParser, scimBodyErrorHandler)

identityScimRouter.get('/ServiceProviderConfig', (_req, res) => res.status(200).json(serviceProviderConfig))
identityScimRouter.get('/ResourceTypes', (_req, res) =>
    res
        .status(200)
        .json({ schemas: [LIST_SCHEMA], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: [userResourceType, groupResourceType] })
)
identityScimRouter.get('/ResourceTypes/User', (_req, res) => res.status(200).json(userResourceType))
identityScimRouter.get('/ResourceTypes/Group', (_req, res) => res.status(200).json(groupResourceType))
identityScimRouter.get('/Schemas', (_req, res) =>
    res.status(200).json({ schemas: [LIST_SCHEMA], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: [userSchema, groupSchema] })
)
identityScimRouter.get('/Schemas/:id', (req, res) => {
    if (req.params.id === CORE_USER) return void res.status(200).json(userSchema)
    if (req.params.id === CORE_GROUP) return void res.status(200).json(groupSchema)
    sendScimError(res, 404, 'Schema not found.', 'noTarget')
})

identityScimRouter.all('/Bulk', (_req, res) => sendScimError(res, 501, 'Bulk operations are not supported.'))

identityScimRouter.get(
    '/Groups',
    asyncRoute(async (req, res) => {
        const actor = req.scimActor as TokenActor
        const page = pageGroups(await groupsForOrganization(applicationSql().query, applicationSql(), actor.organizationId), req.query)
        res.status(200).json({
            schemas: [LIST_SCHEMA],
            totalResults: page.totalResults,
            startIndex: page.startIndex,
            itemsPerPage: page.itemsPerPage,
            Resources: page.resources.map((group) => scimGroup(group, requestedAttributes(req.query)))
        })
    })
)

identityScimRouter.post(
    '/Groups',
    asyncRoute(async (req, res) => {
        const created = await createGroup(applicationSql(), req.scimActor as TokenActor, req.body)
        res.set('Location', `/api/v1/scim/v2/Groups/${created.id}`)
            .status(201)
            .json(scimGroup(created, requestedAttributes(req.query)))
    })
)

identityScimRouter.get(
    '/Groups/:id',
    asyncRoute(async (req, res) => {
        const actor = req.scimActor as TokenActor
        const found = (await groupsForOrganization(applicationSql().query, applicationSql(), actor.organizationId)).find(
            (group) => group.id === req.params.id
        )
        if (!found) throw new ScimError(404, 'Group not found.', 'noTarget')
        res.status(200).json(scimGroup(found, requestedAttributes(req.query)))
    })
)

identityScimRouter.put(
    '/Groups/:id',
    asyncRoute(async (req, res) => {
        const record = object(req.body)
        const updated = await mutateGroup(applicationSql(), req.scimActor as TokenActor, req.params.id, {
            displayName: text(record.displayName).trim(),
            externalId: nullable(record.externalId),
            replaceMembers: Array.isArray(record.members) ? record.members.map((member) => text(object(member).value)).filter(Boolean) : []
        })
        res.status(200).json(scimGroup(updated, requestedAttributes(req.query)))
    })
)

identityScimRouter.patch(
    '/Groups/:id',
    asyncRoute(async (req, res) => {
        const updated = await mutateGroup(applicationSql(), req.scimActor as TokenActor, req.params.id, groupPatchChanges(req.body))
        res.status(200).json(scimGroup(updated, requestedAttributes(req.query)))
    })
)

identityScimRouter.delete(
    '/Groups/:id',
    asyncRoute(async (req, res) => {
        await deleteGroup(applicationSql(), req.scimActor as TokenActor, req.params.id)
        res.status(204).end()
    })
)

identityScimRouter.get(
    '/Users',
    asyncRoute(async (req, res) => {
        const actor = req.scimActor as TokenActor
        const page = pageUsers(await usersForOrganization(applicationSql().query, applicationSql(), actor.organizationId), req.query)
        res.status(200).json({
            schemas: [LIST_SCHEMA],
            totalResults: page.totalResults,
            startIndex: page.startIndex,
            itemsPerPage: page.itemsPerPage,
            Resources: page.resources.map((item) => scimUser(item, requestedAttributes(req.query)))
        })
    })
)

identityScimRouter.post(
    '/Users',
    asyncRoute(async (req, res) => {
        const created = await createUser(applicationSql(), req.scimActor as TokenActor, req.body)
        res.set('Location', `/api/v1/scim/v2/Users/${created.id}`)
            .status(201)
            .json(scimUser(created, requestedAttributes(req.query)))
    })
)

identityScimRouter.get(
    '/Users/:id',
    asyncRoute(async (req, res) => {
        const actor = req.scimActor as TokenActor
        const found = (await usersForOrganization(applicationSql().query, applicationSql(), actor.organizationId)).find(
            (item) => item.id === req.params.id
        )
        if (!found) throw new ScimError(404, 'User not found.', 'noTarget')
        res.status(200).json(scimUser(found, requestedAttributes(req.query)))
    })
)

identityScimRouter.put(
    '/Users/:id',
    asyncRoute(async (req, res) => {
        const record = object(req.body)
        if (typeof record.userName !== 'string') throw new ScimError(400, 'userName is required.', 'invalidValue')
        const changes = replaceChanges(record)
        changes.externalId = nullable(record.externalId)
        changes.displayName = nullable(record.displayName) || emailValue(record) || ''
        changes.givenName =
            record.name && typeof record.name === 'object' ? nullable((record.name as Record<string, unknown>).givenName) : null
        changes.familyName =
            record.name && typeof record.name === 'object' ? nullable((record.name as Record<string, unknown>).familyName) : null
        changes.workEmail = emailValue({ emails: record.emails })
        const updated = await mutateUser(applicationSql(), req.scimActor as TokenActor, req.params.id, changes, 'replaced')
        res.locals.scimOperationCategory = operationCategoryForUserChanges(changes)
        res.status(200).json(scimUser(updated, requestedAttributes(req.query)))
    })
)

identityScimRouter.patch(
    '/Users/:id',
    asyncRoute(async (req, res) => {
        const changes = patchChanges(req.body)
        const updated = await mutateUser(applicationSql(), req.scimActor as TokenActor, req.params.id, changes, 'updated')
        res.locals.scimOperationCategory = operationCategoryForUserChanges(changes)
        res.status(200).json(scimUser(updated, requestedAttributes(req.query)))
    })
)

identityScimRouter.delete(
    '/Users/:id',
    asyncRoute(async (req, res) => {
        await deleteUser(applicationSql(), req.scimActor as TokenActor, req.params.id)
        res.status(204).end()
    })
)

identityScimRouter.all(
    [
        '/ServiceProviderConfig',
        '/ResourceTypes',
        '/ResourceTypes/*',
        '/Schemas',
        '/Schemas/*',
        '/Users',
        '/Users/*',
        '/Groups',
        '/Groups/*'
    ],
    (_req, res) => sendScimError(res, 501, 'This operation is not supported.')
)

identityScimRouter.use((_req, res) => sendScimError(res, 404, 'SCIM resource not found.', 'noTarget'))

identityScimRouter.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ScimError) return sendScimError(res, error.status, error.message, error.scimType)
    const message = error instanceof Error ? error.message : ''
    if (/unique|duplicate/i.test(message)) return sendScimError(res, 409, 'A matching value already exists.', 'uniqueness')
    sendScimError(res, 500, 'The SCIM request could not be completed.')
})
