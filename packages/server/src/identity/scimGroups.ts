/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { createHash, randomUUID } from 'crypto'
import { safeRecordAudit } from './auditLog'
import { builtInPermissionKeys } from './builtInRoles'
import { QueryFn, Sql } from './directory'
import { utcDbTime, utcEpoch } from './dbTime'
import { ScimError, TokenActor } from './scim'

const MAX_COUNT = 100
const DIAGNOSTIC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export interface GroupMember {
    value: string
    display: string
}

export interface GroupRecord {
    id: string
    organizationId: string
    externalId: string | null
    displayName: string
    deletedAt: string | null
    createdAt: string
    updatedAt: string
    members: GroupMember[]
}

export interface MappingRecord {
    id: string
    groupId: string
    groupName: string
    workspaceId: string
    workspaceName: string
    roleId: string | null
    roleName: string | null
    ownedAssignments: number
    createdAt: string
}

export interface MappingAdminActor {
    id: string
    organizationId: string
}

async function auditGroup(sql: Sql, actor: TokenActor, operation: string, group: Pick<GroupRecord, 'id' | 'members'>): Promise<void> {
    await safeRecordAudit(sql, {
        type: 'scim_group',
        organizationId: actor.organizationId,
        workspaceId: null,
        userId: null,
        actorId: 'scim',
        summary: `SCIM group ${operation}`,
        detail: { operation, groupId: group.id, memberCount: group.members.length }
    })
}

async function auditMapping(
    sql: Sql,
    actor: MappingAdminActor,
    operation: string,
    mapping: { id: string; groupId: string; workspaceId: string; roleId: string | null },
    assignmentCount: number,
    conflictCount = 0
): Promise<void> {
    await safeRecordAudit(sql, {
        type: 'scim_mapping',
        organizationId: actor.organizationId,
        workspaceId: mapping.workspaceId,
        userId: null,
        actorId: actor.id,
        summary: `SCIM mapping ${operation}`,
        detail: {
            operation,
            mappingId: mapping.id,
            groupId: mapping.groupId,
            roleId: mapping.roleId,
            assignmentCount,
            conflictCount
        }
    })
}

function q(sql: Sql, name: string): string {
    if (sql.type === 'mysql' || sql.type === 'mariadb') return '`' + name.replace(/`/g, '``') + '`'
    return '"' + name.replace(/"/g, '""') + '"'
}

function cell(row: Record<string, unknown>, key: string): unknown {
    if (key in row) return row[key]
    const found = Object.keys(row).find((item) => item.toLowerCase() === key.toLowerCase())
    return found ? row[found] : undefined
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function nullable(value: unknown): string | null {
    const result = text(value).trim()
    return result || null
}

function normalizedDisplayName(value: string): string {
    return value.trim().toLowerCase()
}

function iso(value: unknown): string | null {
    const epoch = utcEpoch(value)
    return epoch ? new Date(epoch).toISOString() : null
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ScimError(400, 'A JSON object is required.', 'invalidSyntax')
    return value as Record<string, unknown>
}

function memberIds(value: unknown): string[] {
    if (value === undefined) return []
    const list = Array.isArray(value) ? value : [value]
    const ids = list.map((item) => nullable(object(item).value))
    if (ids.some((id) => !id)) throw new ScimError(400, 'Each member requires a value.', 'invalidValue')
    return [...new Set(ids as string[])]
}

async function validateMemberIds(query: QueryFn, sql: Sql, organizationId: string, ids: string[]): Promise<void> {
    if (!ids.length) return
    const found = await query(
        `SELECT ${q(sql, 'id')} AS id FROM ${q(sql, 'identity_scim_user')}
         WHERE ${q(sql, 'organizationId')} = ? AND ${q(sql, 'deletedAt')} IS NULL`,
        [organizationId]
    )
    const known = new Set(found.map((row) => text(cell(row, 'id'))))
    if (ids.some((id) => !known.has(id))) throw new ScimError(400, 'A group member id is not a current SCIM user.', 'invalidValue')
}

async function groupMembers(query: QueryFn, sql: Sql, groupId: string): Promise<GroupMember[]> {
    const rows = await query(
        `SELECT gm.${q(sql, 'scimUserId')} AS value, su.${q(sql, 'displayName')} AS display
         FROM ${q(sql, 'identity_scim_group_member')} gm
         INNER JOIN ${q(sql, 'identity_scim_user')} su ON su.${q(sql, 'id')} = gm.${q(sql, 'scimUserId')}
         WHERE gm.${q(sql, 'groupId')} = ? AND su.${q(sql, 'deletedAt')} IS NULL
         ORDER BY gm.${q(sql, 'scimUserId')} ASC`,
        [groupId]
    )
    return rows.map((row) => ({ value: text(cell(row, 'value')), display: text(cell(row, 'display')) }))
}

async function groupFromRow(query: QueryFn, sql: Sql, row: Record<string, unknown>): Promise<GroupRecord> {
    const id = text(cell(row, 'id'))
    return {
        id,
        organizationId: text(cell(row, 'organizationId')),
        externalId: nullable(cell(row, 'externalId')),
        displayName: text(cell(row, 'displayName')),
        deletedAt: iso(cell(row, 'deletedAt')),
        createdAt: iso(cell(row, 'createdAt')) || new Date(0).toISOString(),
        updatedAt: iso(cell(row, 'updatedAt')) || new Date(0).toISOString(),
        members: await groupMembers(query, sql, id)
    }
}

export async function groupsForOrganization(
    query: QueryFn,
    sql: Sql,
    organizationId: string,
    includeDeleted = false
): Promise<GroupRecord[]> {
    const rows = await query(
        `SELECT ${q(sql, 'id')} AS id, ${q(sql, 'organizationId')} AS organizationId, ${q(sql, 'externalId')} AS externalId,
                ${q(sql, 'displayName')} AS displayName, ${q(sql, 'deletedAt')} AS deletedAt,
                ${q(sql, 'createdAt')} AS createdAt, ${q(sql, 'updatedAt')} AS updatedAt
         FROM ${q(sql, 'identity_scim_group')} WHERE ${q(sql, 'organizationId')} = ?
         ${includeDeleted ? '' : `AND ${q(sql, 'deletedAt')} IS NULL`}
         ORDER BY ${q(sql, 'createdAt')} ASC, ${q(sql, 'id')} ASC`,
        [organizationId]
    )
    return Promise.all(rows.map((row) => groupFromRow(query, sql, row)))
}

type GroupFilter =
    | { kind: 'eq'; attribute: 'displayname' | 'externalid'; value: string }
    | { kind: 'and' | 'or'; left: GroupFilter; right: GroupFilter }

interface FilterToken {
    kind: 'word' | 'string' | 'left' | 'right'
    value: string
}

function tokens(source: string): FilterToken[] {
    const result: FilterToken[] = []
    let index = 0
    while (index < source.length) {
        const character = source[index]
        if (/\s/.test(character)) {
            index += 1
            continue
        }
        if (character === '(' || character === ')') {
            result.push({ kind: character === '(' ? 'left' : 'right', value: character })
            index += 1
            continue
        }
        if (character === '"') {
            let value = ''
            let closed = false
            index += 1
            while (index < source.length) {
                if (source[index] === '"') {
                    closed = true
                    index += 1
                    break
                }
                if (source[index] === '\\') {
                    index += 1
                    if (source[index] !== '"' && source[index] !== '\\') throw new ScimError(400, 'Invalid filter.', 'invalidFilter')
                }
                value += source[index++]
            }
            if (!closed) throw new ScimError(400, 'Invalid filter.', 'invalidFilter')
            result.push({ kind: 'string', value })
            continue
        }
        const start = index
        while (index < source.length && /[A-Za-z0-9._-]/.test(source[index])) index += 1
        if (start === index) throw new ScimError(400, 'Invalid filter.', 'invalidFilter')
        result.push({ kind: 'word', value: source.slice(start, index) })
    }
    return result
}

export function parseGroupFilter(source: string): GroupFilter {
    const values = tokens(source)
    let position = 0
    const primary = (): GroupFilter => {
        if (values[position]?.kind === 'left') {
            position += 1
            const nested = disjunction()
            if (values[position]?.kind !== 'right') throw new ScimError(400, 'Invalid filter.', 'invalidFilter')
            position += 1
            return nested
        }
        const attribute = values[position++]
        const operator = values[position++]
        const value = values[position++]
        const name = attribute?.value.toLowerCase()
        if (
            attribute?.kind !== 'word' ||
            operator?.value.toLowerCase() !== 'eq' ||
            value?.kind !== 'string' ||
            (name !== 'displayname' && name !== 'externalid')
        ) {
            throw new ScimError(400, 'Only eq filters on displayName and externalId are supported.', 'invalidFilter')
        }
        return { kind: 'eq', attribute: name, value: value.value }
    }
    const conjunction = (): GroupFilter => {
        let left = primary()
        while (values[position]?.value.toLowerCase() === 'and') {
            position += 1
            left = { kind: 'and', left, right: primary() }
        }
        return left
    }
    const disjunction = (): GroupFilter => {
        let left = conjunction()
        while (values[position]?.value.toLowerCase() === 'or') {
            position += 1
            left = { kind: 'or', left, right: conjunction() }
        }
        return left
    }
    if (!values.length) throw new ScimError(400, 'Invalid filter.', 'invalidFilter')
    const result = disjunction()
    if (position !== values.length) throw new ScimError(400, 'Invalid filter.', 'invalidFilter')
    return result
}

function matches(group: GroupRecord, filter: GroupFilter): boolean {
    if (filter.kind !== 'eq') {
        return filter.kind === 'and'
            ? matches(group, filter.left) && matches(group, filter.right)
            : matches(group, filter.left) || matches(group, filter.right)
    }
    const actual = filter.attribute === 'displayname' ? normalizedDisplayName(group.displayName) : group.externalId || ''
    const expected = filter.attribute === 'displayname' ? normalizedDisplayName(filter.value) : filter.value
    return actual === expected
}

export function pageGroups(
    groups: GroupRecord[],
    query: { startIndex?: unknown; count?: unknown; filter?: unknown }
): { totalResults: number; startIndex: number; itemsPerPage: number; resources: GroupRecord[] } {
    const startIndex = query.startIndex === undefined ? 1 : Number(query.startIndex)
    const count = query.count === undefined ? MAX_COUNT : Number(query.count)
    if (!Number.isInteger(startIndex) || startIndex < 1 || !Number.isInteger(count) || count < 0 || count > MAX_COUNT) {
        throw new ScimError(400, `startIndex must be at least 1 and count must be between 0 and ${MAX_COUNT}.`, 'invalidValue')
    }
    let selected = groups
    if (query.filter !== undefined) {
        if (typeof query.filter !== 'string') throw new ScimError(400, 'Invalid filter.', 'invalidFilter')
        const parsed = parseGroupFilter(query.filter)
        selected = groups.filter((group) => matches(group, parsed))
    }
    const resources = selected.slice(startIndex - 1, startIndex - 1 + count)
    return { totalResults: selected.length, startIndex, itemsPerPage: resources.length, resources }
}

async function replaceMembers(query: QueryFn, sql: Sql, groupId: string, ids: string[], now: number): Promise<void> {
    const current = await query(
        `SELECT ${q(sql, 'scimUserId')} AS id FROM ${q(sql, 'identity_scim_group_member')} WHERE ${q(sql, 'groupId')} = ?`,
        [groupId]
    )
    const before = new Set(current.map((row) => text(cell(row, 'id'))))
    const after = new Set(ids)
    for (const id of before) {
        if (!after.has(id))
            await query(
                `DELETE FROM ${q(sql, 'identity_scim_group_member')} WHERE ${q(sql, 'groupId')} = ? AND ${q(sql, 'scimUserId')} = ?`,
                [groupId, id]
            )
    }
    for (const id of after) {
        if (!before.has(id))
            await query(
                `INSERT INTO ${q(sql, 'identity_scim_group_member')} (${q(sql, 'groupId')}, ${q(sql, 'scimUserId')}, ${q(
                    sql,
                    'createdAt'
                )}) VALUES (?, ?, ?)`,
                [groupId, id, utcDbTime(sql.type, now)]
            )
    }
}

export async function createGroup(sql: Sql, actor: TokenActor, body: unknown, now = Date.now()): Promise<GroupRecord> {
    const record = object(body)
    const displayName = text(record.displayName).trim()
    const normalizedName = normalizedDisplayName(displayName)
    const externalId = nullable(record.externalId)
    const members = memberIds(record.members)
    if (!displayName || displayName.length > 255) throw new ScimError(400, 'displayName is required.', 'invalidValue')
    let id = ''
    let restored = false
    await sql.transaction(async (query) => {
        await validateMemberIds(query, sql, actor.organizationId, members)
        const groups = await groupsForOrganization(query, sql, actor.organizationId, true)
        const matches = groups.filter(
            (group) => (externalId && group.externalId === externalId) || normalizedDisplayName(group.displayName) === normalizedName
        )
        if (matches.some((group) => !group.deletedAt) || matches.length > 1) {
            throw new ScimError(409, 'A matching SCIM group already exists.', 'uniqueness')
        }
        const at = utcDbTime(sql.type, now)
        const deleted = matches[0]
        if (deleted) {
            id = deleted.id
            restored = true
            await query(
                `UPDATE ${q(sql, 'identity_scim_group')} SET ${q(sql, 'externalId')} = ?, ${q(sql, 'displayName')} = ?, ${q(
                    sql,
                    'normalizedDisplayName'
                )} = ?, ${q(sql, 'deletedAt')} = NULL, ${q(sql, 'updatedAt')} = ? WHERE ${q(sql, 'id')} = ?`,
                [externalId, displayName, normalizedName, at, id]
            )
            await replaceMembers(query, sql, id, members, now)
            await reconcileMappings(query, sql, actor.organizationId, actor.creatorId, now)
            return
        }
        id = randomUUID()
        await query(
            `INSERT INTO ${q(sql, 'identity_scim_group')} (${q(sql, 'id')}, ${q(sql, 'organizationId')}, ${q(sql, 'externalId')}, ${q(
                sql,
                'displayName'
            )}, ${q(sql, 'normalizedDisplayName')}, ${q(sql, 'createdAt')}, ${q(sql, 'updatedAt')}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, actor.organizationId, externalId, displayName, normalizedName, at, at]
        )
        await replaceMembers(query, sql, id, members, now)
        await reconcileMappings(query, sql, actor.organizationId, actor.creatorId, now)
    })
    const created = (await groupsForOrganization(sql.query, sql, actor.organizationId)).find((group) => group.id === id)
    if (!created) throw new Error('SCIM_GROUP_CREATE_FAILED')
    await auditGroup(sql, actor, restored ? 'restored' : 'created', created)
    return created
}

export interface GroupMemberOperation {
    operation: 'add' | 'remove' | 'replace'
    ids: string[]
}

export interface GroupChanges {
    displayName?: string
    externalId?: string | null
    replaceMembers?: string[]
    addMembers?: string[]
    removeMembers?: string[]
    memberOperations?: GroupMemberOperation[]
}

export function groupPatchChanges(body: unknown): GroupChanges {
    const record = object(body)
    if (!Array.isArray(record.Operations)) throw new ScimError(400, 'Operations are required.', 'invalidSyntax')
    const changes: GroupChanges = { memberOperations: [] }
    for (const raw of record.Operations) {
        const operation = object(raw)
        const op = text(operation.op).toLowerCase()
        if (!['add', 'replace', 'remove'].includes(op)) throw new ScimError(400, 'Unsupported PATCH operation.', 'invalidSyntax')
        const path = nullable(operation.path)
        if (!path) {
            if (op === 'remove') throw new ScimError(400, 'A path is required for remove.', 'invalidSyntax')
            const value = object(operation.value)
            if ('displayName' in value) changes.displayName = text(value.displayName).trim()
            if ('externalId' in value) changes.externalId = nullable(value.externalId)
            if ('members' in value) {
                changes.memberOperations?.push({ operation: op === 'add' ? 'add' : 'replace', ids: memberIds(value.members) })
            }
            continue
        }
        if (/^displayname$/i.test(path)) changes.displayName = op === 'remove' ? '' : text(operation.value).trim()
        else if (/^externalid$/i.test(path)) changes.externalId = op === 'remove' ? null : nullable(operation.value)
        else if (/^members$/i.test(path)) {
            changes.memberOperations?.push({ operation: op as GroupMemberOperation['operation'], ids: memberIds(operation.value) })
        } else {
            const selected = /^members\s*\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(path)
            if (!selected || op !== 'remove') throw new ScimError(400, 'Unsupported PATCH path.', 'invalidSyntax')
            changes.memberOperations?.push({ operation: 'remove', ids: [selected[1]] })
        }
    }
    return changes
}

export async function mutateGroup(
    sql: Sql,
    actor: TokenActor,
    groupId: string,
    changes: GroupChanges,
    now = Date.now()
): Promise<GroupRecord> {
    await sql.transaction(async (query) => {
        const groups = await groupsForOrganization(query, sql, actor.organizationId)
        const current = groups.find((group) => group.id === groupId)
        if (!current) throw new ScimError(404, 'Group not found.', 'noTarget')
        const displayName = changes.displayName === undefined ? current.displayName : changes.displayName
        if (!displayName || displayName.length > 255) throw new ScimError(400, 'displayName is required.', 'invalidValue')
        const normalizedName = normalizedDisplayName(displayName)
        const externalId = changes.externalId === undefined ? current.externalId : changes.externalId
        const conflict = groups.find(
            (group) =>
                group.id !== groupId &&
                ((externalId && group.externalId === externalId) || normalizedDisplayName(group.displayName) === normalizedName)
        )
        if (conflict) throw new ScimError(409, 'A matching SCIM group already exists.', 'uniqueness')
        const memberOperations = changes.memberOperations || [
            ...(changes.replaceMembers ? [{ operation: 'replace' as const, ids: changes.replaceMembers }] : []),
            ...(changes.addMembers ? [{ operation: 'add' as const, ids: changes.addMembers }] : []),
            ...(changes.removeMembers ? [{ operation: 'remove' as const, ids: changes.removeMembers }] : [])
        ]
        await validateMemberIds(
            query,
            sql,
            actor.organizationId,
            memberOperations.filter((operation) => operation.operation !== 'remove').flatMap((operation) => operation.ids)
        )
        let next = current.members.map((member) => member.value)
        for (const operation of memberOperations) {
            if (operation.operation === 'replace') next = [...operation.ids]
            else if (operation.operation === 'add') next = [...new Set([...next, ...operation.ids])]
            else {
                const removed = new Set(operation.ids)
                next = next.filter((id) => !removed.has(id))
            }
        }
        await query(
            `UPDATE ${q(sql, 'identity_scim_group')} SET ${q(sql, 'displayName')} = ?, ${q(sql, 'externalId')} = ?, ${q(
                sql,
                'normalizedDisplayName'
            )} = ?, ${q(sql, 'updatedAt')} = ? WHERE ${q(sql, 'id')} = ?`,
            [displayName, externalId, normalizedName, utcDbTime(sql.type, now), groupId]
        )
        await replaceMembers(query, sql, groupId, next, now)
        await reconcileMappings(query, sql, actor.organizationId, actor.creatorId, now)
    })
    const updated = (await groupsForOrganization(sql.query, sql, actor.organizationId)).find((group) => group.id === groupId)
    if (!updated) throw new ScimError(404, 'Group not found.', 'noTarget')
    const membershipChanged = Boolean(
        changes.memberOperations?.length || changes.replaceMembers || changes.addMembers || changes.removeMembers
    )
    await auditGroup(sql, actor, membershipChanged ? 'membership changed' : 'updated', updated)
    return updated
}

function permissionList(value: unknown): string[] {
    if (typeof value !== 'string') return []
    try {
        const parsed = JSON.parse(value) as unknown
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
    } catch {
        return []
    }
}

function rolePermissions(role: Record<string, unknown>): string[] {
    return builtInPermissionKeys(text(cell(role, 'name'))) || permissionList(cell(role, 'permissions'))
}

async function memberRole(query: QueryFn, sql: Sql): Promise<string> {
    const rows = await query(
        `SELECT ${q(sql, 'id')} AS id FROM ${q(sql, 'role')} WHERE LOWER(${q(sql, 'name')}) = 'member'
         ORDER BY CASE WHEN ${q(sql, 'organizationId')} IS NULL THEN 0 ELSE 1 END LIMIT 1`
    )
    const id = text(cell(rows[0] || {}, 'id'))
    if (!id) throw new Error('MEMBER_ROLE_MISSING')
    return id
}

async function safeRole(query: QueryFn, sql: Sql, organizationId: string, roleId: string): Promise<boolean> {
    const rows = await query(
        `SELECT ${q(sql, 'name')} AS name, ${q(sql, 'permissions')} AS permissions, ${q(sql, 'organizationId')} AS organizationId
         FROM ${q(sql, 'role')} WHERE ${q(sql, 'id')} = ?`,
        [roleId]
    )
    const role = rows[0]
    if (!role) return false
    const roleOrganization = nullable(cell(role, 'organizationId'))
    if (roleOrganization && roleOrganization !== organizationId) return false
    return text(cell(role, 'name')).toLowerCase() !== 'owner' && !rolePermissions(role).includes('authentication:manage')
}

async function diagnostic(
    query: QueryFn,
    sql: Sql,
    organizationId: string,
    category: string,
    detail: string,
    now: number,
    correlationId = randomUUID()
): Promise<void> {
    await query(
        `INSERT INTO ${q(sql, 'identity_scim_diagnostic')} (${q(sql, 'id')}, ${q(sql, 'organizationId')}, ${q(sql, 'category')}, ${q(
            sql,
            'outcome'
        )}, ${q(sql, 'correlationId')}, ${q(sql, 'detail')}, ${q(sql, 'completedAt')})
         VALUES (?, ?, ?, 'failed', ?, ?, ?)`,
        [randomUUID(), organizationId, category, correlationId, detail.slice(0, 500), utcDbTime(sql.type, now)]
    )
}

interface ReconcileMapping {
    id: string
    groupId: string
    workspaceId: string
    roleId: string
    safe: boolean
}

/** Reconcile only rows recorded in the assignment ledger; pre-existing team rows remain manual. */
export async function reconcileMappings(
    query: QueryFn,
    sql: Sql,
    organizationId: string,
    actorId: string,
    now = Date.now()
): Promise<string[]> {
    const defaultRole = await memberRole(query, sql)
    const mappingRows = await query(
        `SELECT ${q(sql, 'id')} AS id, ${q(sql, 'groupId')} AS groupId, ${q(sql, 'workspaceId')} AS workspaceId,
                ${q(sql, 'roleId')} AS roleId FROM ${q(sql, 'identity_scim_mapping')}
         WHERE ${q(sql, 'organizationId')} = ? ORDER BY ${q(sql, 'id')} ASC`,
        [organizationId]
    )
    const mappings: ReconcileMapping[] = []
    for (const row of mappingRows) {
        const roleId = nullable(cell(row, 'roleId')) || defaultRole
        const isSafe = await safeRole(query, sql, organizationId, roleId)
        mappings.push({
            id: text(cell(row, 'id')),
            groupId: text(cell(row, 'groupId')),
            workspaceId: text(cell(row, 'workspaceId')),
            roleId,
            safe: isSafe
        })
        if (!isSafe) await diagnostic(query, sql, organizationId, 'mapping_role_refused', 'A mapping role is no longer allowed.', now)
    }
    const desiredRows = await query(
        `SELECT m.${q(sql, 'id')} AS mappingId, m.${q(sql, 'workspaceId')} AS workspaceId,
                m.${q(sql, 'roleId')} AS configuredRoleId, su.${q(sql, 'userId')} AS userId
         FROM ${q(sql, 'identity_scim_mapping')} m
         INNER JOIN ${q(sql, 'identity_scim_group')} g ON g.${q(sql, 'id')} = m.${q(sql, 'groupId')} AND g.${q(sql, 'deletedAt')} IS NULL
         INNER JOIN ${q(sql, 'identity_scim_group_member')} gm ON gm.${q(sql, 'groupId')} = g.${q(sql, 'id')}
         INNER JOIN ${q(sql, 'identity_scim_user')} su ON su.${q(sql, 'id')} = gm.${q(sql, 'scimUserId')} AND su.${q(
            sql,
            'deletedAt'
        )} IS NULL
         INNER JOIN ${q(sql, 'user')} u ON u.${q(sql, 'id')} = su.${q(sql, 'userId')} AND LOWER(u.${q(sql, 'status')}) = 'active'
         INNER JOIN ${q(sql, 'organization_user')} ou ON ou.${q(sql, 'userId')} = u.${q(sql, 'id')}
            AND ou.${q(sql, 'organizationId')} = ? AND LOWER(ou.${q(sql, 'status')}) = 'active'
         WHERE m.${q(sql, 'organizationId')} = ?`,
        [organizationId, organizationId]
    )
    const ownerRows = await query(
        `SELECT ou.${q(sql, 'userId')} AS userId FROM ${q(sql, 'organization_user')} ou
         INNER JOIN ${q(sql, 'role')} r ON r.${q(sql, 'id')} = ou.${q(sql, 'roleId')}
         WHERE ou.${q(sql, 'organizationId')} = ? AND LOWER(r.${q(sql, 'name')}) = 'owner'`,
        [organizationId]
    )
    const owners = new Set(ownerRows.map((row) => text(cell(row, 'userId'))))
    const mappingById = new Map(mappings.map((mapping) => [mapping.id, mapping]))
    const desiredByPair = new Map<string, Array<{ mappingId: string; userId: string; workspaceId: string; roleId: string }>>()
    for (const row of desiredRows) {
        const mapping = mappingById.get(text(cell(row, 'mappingId')))
        const userId = text(cell(row, 'userId'))
        if (!mapping || !mapping.safe || owners.has(userId)) continue
        const pair = `${userId}\u0000${mapping.workspaceId}`
        const list = desiredByPair.get(pair) || []
        list.push({ mappingId: mapping.id, userId, workspaceId: mapping.workspaceId, roleId: mapping.roleId })
        desiredByPair.set(pair, list)
    }
    const conflicts = new Set<string>()
    for (const [pair, candidates] of desiredByPair) {
        if (new Set(candidates.map((candidate) => candidate.roleId)).size > 1) {
            conflicts.add(pair)
            await diagnostic(query, sql, organizationId, 'mapping_conflict', 'Mappings request different roles for one user and team.', now)
        }
    }
    const assignmentRows = await query(
        `SELECT a.${q(sql, 'mappingId')} AS mappingId, a.${q(sql, 'userId')} AS userId,
                a.${q(sql, 'workspaceId')} AS workspaceId, a.${q(sql, 'roleId')} AS roleId
         FROM ${q(sql, 'identity_scim_assignment')} a
         INNER JOIN ${q(sql, 'identity_scim_mapping')} m ON m.${q(sql, 'id')} = a.${q(sql, 'mappingId')}
         WHERE m.${q(sql, 'organizationId')} = ?`,
        [organizationId]
    )
    const changed = new Set<string>()
    const assignmentByPair = new Map<string, Record<string, unknown>>()
    for (const assignment of assignmentRows) {
        const userId = text(cell(assignment, 'userId'))
        const workspaceId = text(cell(assignment, 'workspaceId'))
        const pair = `${userId}\u0000${workspaceId}`
        assignmentByPair.set(pair, assignment)
        const memberships = await query(
            `SELECT ${q(sql, 'roleId')} AS roleId FROM ${q(sql, 'workspace_user')}
             WHERE ${q(sql, 'workspaceId')} = ? AND ${q(sql, 'userId')} = ?`,
            [workspaceId, userId]
        )
        const roleStillMatches = Boolean(memberships.length && text(cell(memberships[0], 'roleId')) === text(cell(assignment, 'roleId')))
        if (conflicts.has(pair)) {
            if (roleStillMatches) {
                await query(`DELETE FROM ${q(sql, 'workspace_user')} WHERE ${q(sql, 'workspaceId')} = ? AND ${q(sql, 'userId')} = ?`, [
                    workspaceId,
                    userId
                ])
                changed.add(userId)
            }
            await query(`DELETE FROM ${q(sql, 'identity_scim_assignment')} WHERE ${q(sql, 'mappingId')} = ? AND ${q(sql, 'userId')} = ?`, [
                text(cell(assignment, 'mappingId')),
                userId
            ])
            assignmentByPair.delete(pair)
            continue
        }
        const desired = desiredByPair.get(pair) || []
        const stillDesired = desired.some((candidate) => candidate.mappingId === text(cell(assignment, 'mappingId')))
        if (stillDesired && roleStillMatches) continue
        if (!stillDesired && roleStillMatches) {
            await query(`DELETE FROM ${q(sql, 'workspace_user')} WHERE ${q(sql, 'workspaceId')} = ? AND ${q(sql, 'userId')} = ?`, [
                workspaceId,
                userId
            ])
            changed.add(userId)
        }
        await query(`DELETE FROM ${q(sql, 'identity_scim_assignment')} WHERE ${q(sql, 'mappingId')} = ? AND ${q(sql, 'userId')} = ?`, [
            text(cell(assignment, 'mappingId')),
            userId
        ])
        assignmentByPair.delete(pair)
    }
    for (const [pair, candidates] of desiredByPair) {
        if (conflicts.has(pair)) continue
        const existingAssignment = assignmentByPair.get(pair)
        if (existingAssignment) continue
        const chosen = [...candidates].sort((left, right) => left.mappingId.localeCompare(right.mappingId))[0]
        const memberships = await query(
            `SELECT ${q(sql, 'roleId')} AS roleId FROM ${q(sql, 'workspace_user')}
             WHERE ${q(sql, 'workspaceId')} = ? AND ${q(sql, 'userId')} = ?`,
            [chosen.workspaceId, chosen.userId]
        )
        if (memberships.length) continue
        await query(
            `INSERT INTO ${q(sql, 'workspace_user')} (${q(sql, 'workspaceId')}, ${q(sql, 'userId')}, ${q(sql, 'roleId')}, ${q(
                sql,
                'status'
            )}, ${q(sql, 'createdBy')}, ${q(sql, 'updatedBy')}) VALUES (?, ?, ?, 'active', ?, ?)`,
            [chosen.workspaceId, chosen.userId, chosen.roleId, actorId, actorId]
        )
        await query(
            `INSERT INTO ${q(sql, 'identity_scim_assignment')} (${q(sql, 'mappingId')}, ${q(sql, 'userId')}, ${q(sql, 'workspaceId')}, ${q(
                sql,
                'roleId'
            )}, ${q(sql, 'createdAt')}) VALUES (?, ?, ?, ?, ?)`,
            [chosen.mappingId, chosen.userId, chosen.workspaceId, chosen.roleId, utcDbTime(sql.type, now)]
        )
        changed.add(chosen.userId)
    }
    for (const userId of changed) {
        await query(
            `UPDATE ${q(sql, 'user')} SET ${q(sql, 'permissionVersion')} = COALESCE(${q(sql, 'permissionVersion')}, 0) + 1 WHERE ${q(
                sql,
                'id'
            )} = ?`,
            [userId]
        )
    }
    return [...changed].sort()
}

export async function deleteGroup(sql: Sql, actor: TokenActor, groupId: string, now = Date.now()): Promise<void> {
    let deleted: GroupRecord | null = null
    let removedMapping: { id: string; groupId: string; workspaceId: string; roleId: string | null } | null = null
    let removedAssignmentCount = 0
    await sql.transaction(async (query) => {
        const current = (await groupsForOrganization(query, sql, actor.organizationId)).find((group) => group.id === groupId)
        if (!current) throw new ScimError(404, 'Group not found.', 'noTarget')
        deleted = current
        const mappings = await query(
            `SELECT ${q(sql, 'id')} AS id, ${q(sql, 'groupId')} AS groupId, ${q(sql, 'workspaceId')} AS workspaceId,
                    ${q(sql, 'roleId')} AS roleId FROM ${q(sql, 'identity_scim_mapping')}
             WHERE ${q(sql, 'groupId')} = ? AND ${q(sql, 'organizationId')} = ?`,
            [groupId, actor.organizationId]
        )
        if (mappings.length) {
            removedMapping = {
                id: text(cell(mappings[0], 'id')),
                groupId,
                workspaceId: text(cell(mappings[0], 'workspaceId')),
                roleId: nullable(cell(mappings[0], 'roleId'))
            }
            const assignments = await query(
                `SELECT COUNT(*) AS count FROM ${q(sql, 'identity_scim_assignment')} a
                 INNER JOIN ${q(sql, 'workspace_user')} wu ON wu.${q(sql, 'workspaceId')} = a.${q(sql, 'workspaceId')}
                    AND wu.${q(sql, 'userId')} = a.${q(sql, 'userId')} AND wu.${q(sql, 'roleId')} = a.${q(sql, 'roleId')}
                 WHERE a.${q(sql, 'mappingId')} = ?`,
                [text(cell(mappings[0], 'id'))]
            )
            removedAssignmentCount = Number(cell(assignments[0] || {}, 'count')) || 0
        }
        await query(`DELETE FROM ${q(sql, 'identity_scim_group_member')} WHERE ${q(sql, 'groupId')} = ?`, [groupId])
        await reconcileMappings(query, sql, actor.organizationId, actor.creatorId, now)
        await query(`DELETE FROM ${q(sql, 'identity_scim_mapping')} WHERE ${q(sql, 'groupId')} = ?`, [groupId])
        await query(
            `UPDATE ${q(sql, 'identity_scim_group')} SET ${q(sql, 'deletedAt')} = ?, ${q(sql, 'updatedAt')} = ? WHERE ${q(sql, 'id')} = ?`,
            [utcDbTime(sql.type, now), utcDbTime(sql.type, now), groupId]
        )
    })
    if (deleted) await auditGroup(sql, actor, 'deleted', deleted)
    if (removedMapping) {
        await auditMapping(sql, { id: 'scim', organizationId: actor.organizationId }, 'removed', removedMapping, removedAssignmentCount)
    }
}

async function mappingRows(sql: Sql, organizationId: string): Promise<MappingRecord[]> {
    const rows = await sql.query(
        `SELECT m.${q(sql, 'id')} AS id, m.${q(sql, 'groupId')} AS groupId, g.${q(sql, 'displayName')} AS groupName,
                m.${q(sql, 'workspaceId')} AS workspaceId, w.${q(sql, 'name')} AS workspaceName,
                m.${q(sql, 'roleId')} AS roleId, r.${q(sql, 'name')} AS roleName, m.${q(sql, 'createdAt')} AS createdAt,
                (SELECT COUNT(*) FROM ${q(sql, 'identity_scim_assignment')} a
                 INNER JOIN ${q(sql, 'workspace_user')} wu ON wu.${q(sql, 'workspaceId')} = a.${q(sql, 'workspaceId')}
                    AND wu.${q(sql, 'userId')} = a.${q(sql, 'userId')} AND wu.${q(sql, 'roleId')} = a.${q(sql, 'roleId')}
                 WHERE a.${q(sql, 'mappingId')} = m.${q(sql, 'id')}) AS ownedAssignments
         FROM ${q(sql, 'identity_scim_mapping')} m
         INNER JOIN ${q(sql, 'identity_scim_group')} g ON g.${q(sql, 'id')} = m.${q(sql, 'groupId')}
         INNER JOIN ${q(sql, 'workspace')} w ON w.${q(sql, 'id')} = m.${q(sql, 'workspaceId')}
         LEFT JOIN ${q(sql, 'role')} r ON r.${q(sql, 'id')} = m.${q(sql, 'roleId')}
         WHERE m.${q(sql, 'organizationId')} = ? ORDER BY g.${q(sql, 'displayName')} ASC`,
        [organizationId]
    )
    return rows.map((row) => ({
        id: text(cell(row, 'id')),
        groupId: text(cell(row, 'groupId')),
        groupName: text(cell(row, 'groupName')),
        workspaceId: text(cell(row, 'workspaceId')),
        workspaceName: text(cell(row, 'workspaceName')),
        roleId: nullable(cell(row, 'roleId')),
        roleName: nullable(cell(row, 'roleName')),
        ownedAssignments: Number(cell(row, 'ownedAssignments')) || 0,
        createdAt: iso(cell(row, 'createdAt')) || new Date(0).toISOString()
    }))
}

export async function mappingOptions(sql: Sql, actor: MappingAdminActor): Promise<Record<string, unknown>> {
    const groups = await groupsForOrganization(sql.query, sql, actor.organizationId)
    const workspaces = await sql.query(
        `SELECT ${q(sql, 'id')} AS id, ${q(sql, 'name')} AS name FROM ${q(sql, 'workspace')}
         WHERE ${q(sql, 'organizationId')} = ? AND LOWER(${q(sql, 'name')}) <> 'personal workspace'
         ORDER BY ${q(sql, 'name')} ASC`,
        [actor.organizationId]
    )
    const roles = await sql.query(
        `SELECT ${q(sql, 'id')} AS id, ${q(sql, 'name')} AS name, ${q(sql, 'permissions')} AS permissions,
                ${q(sql, 'organizationId')} AS organizationId FROM ${q(sql, 'role')}
         WHERE ${q(sql, 'organizationId')} = ? OR ${q(sql, 'organizationId')} IS NULL ORDER BY ${q(sql, 'name')} ASC`,
        [actor.organizationId]
    )
    const allowedRoles = roles
        .filter((role) => {
            const name = text(cell(role, 'name')).toLowerCase()
            return name !== 'owner' && !rolePermissions(role).includes('authentication:manage')
        })
        .map((role) => ({ id: text(cell(role, 'id')), name: text(cell(role, 'name')) }))
    return {
        mappings: await mappingRows(sql, actor.organizationId),
        groups: groups.map((group) => ({ id: group.id, displayName: group.displayName })),
        workspaces: workspaces.map((row) => ({ id: text(cell(row, 'id')), name: text(cell(row, 'name')) })),
        roles: allowedRoles
    }
}

interface MappingPreviewAssignment {
    userId: string
    userName: string
    workspaceId: string
    workspaceName: string
    roleId: string
    roleName: string
}

interface MappingPreviewConflict extends MappingPreviewAssignment {
    currentRoleId: string | null
    currentRoleName: string | null
    removesOwnedMembership: boolean
}

interface MappingCreationSnapshot {
    mapping: {
        groupId: string
        groupName: string
        workspaceId: string
        workspaceName: string
        roleId: string | null
        effectiveRoleId: string
        roleName: string
    }
    assignments: MappingPreviewAssignment[]
    manualMemberships: MappingPreviewAssignment[]
    conflicts: MappingPreviewConflict[]
}

async function mappingCreationSnapshot(
    query: QueryFn,
    sql: Sql,
    actor: MappingAdminActor,
    body: unknown
): Promise<MappingCreationSnapshot> {
    const record = object(body)
    const groupId = text(record.groupId).trim()
    const workspaceId = text(record.workspaceId).trim()
    const roleId = nullable(record.roleId)
    if (!groupId || !workspaceId) throw new ScimError(400, 'Choose a SCIM group and team.', 'invalidValue')
    const groups = await groupsForOrganization(query, sql, actor.organizationId)
    const group = groups.find((item) => item.id === groupId)
    if (!group) throw new ScimError(400, 'Choose a current SCIM group.', 'invalidValue')
    const workspaces = await query(
        `SELECT ${q(sql, 'id')} AS id, ${q(sql, 'name')} AS name FROM ${q(sql, 'workspace')}
         WHERE ${q(sql, 'id')} = ? AND ${q(sql, 'organizationId')} = ?
           AND LOWER(${q(sql, 'name')}) <> 'personal workspace'`,
        [workspaceId, actor.organizationId]
    )
    if (!workspaces.length) throw new ScimError(400, 'Choose a team in this organization.', 'invalidValue')
    const effectiveRoleId = roleId || (await memberRole(query, sql))
    if (!(await safeRole(query, sql, actor.organizationId, effectiveRoleId))) {
        throw new ScimError(400, 'That role cannot be granted by a SCIM mapping.', 'invalidValue')
    }
    const existing = await query(`SELECT ${q(sql, 'id')} AS id FROM ${q(sql, 'identity_scim_mapping')} WHERE ${q(sql, 'groupId')} = ?`, [
        groupId
    ])
    if (existing.length) throw new ScimError(409, 'That SCIM group already has a mapping.', 'uniqueness')
    const roleRows = await query(
        `SELECT ${q(sql, 'id')} AS id, ${q(sql, 'name')} AS name, ${q(sql, 'permissions')} AS permissions,
                ${q(sql, 'organizationId')} AS organizationId FROM ${q(sql, 'role')}
         WHERE ${q(sql, 'organizationId')} = ? OR ${q(sql, 'organizationId')} IS NULL`,
        [actor.organizationId]
    )
    const roleById = new Map(roleRows.map((row) => [text(cell(row, 'id')), row]))
    const requestedRole = roleById.get(effectiveRoleId)
    if (!requestedRole) throw new ScimError(400, 'Choose a current role.', 'invalidValue')
    const candidates = await query(
        `SELECT su.${q(sql, 'userId')} AS userId, su.${q(sql, 'displayName')} AS userName
         FROM ${q(sql, 'identity_scim_group_member')} gm
         INNER JOIN ${q(sql, 'identity_scim_user')} su ON su.${q(sql, 'id')} = gm.${q(sql, 'scimUserId')}
            AND su.${q(sql, 'deletedAt')} IS NULL
         INNER JOIN ${q(sql, 'user')} u ON u.${q(sql, 'id')} = su.${q(sql, 'userId')} AND LOWER(u.${q(sql, 'status')}) = 'active'
         INNER JOIN ${q(sql, 'organization_user')} ou ON ou.${q(sql, 'userId')} = u.${q(sql, 'id')}
            AND ou.${q(sql, 'organizationId')} = ? AND LOWER(ou.${q(sql, 'status')}) = 'active'
         INNER JOIN ${q(sql, 'role')} orgRole ON orgRole.${q(sql, 'id')} = ou.${q(sql, 'roleId')}
            AND LOWER(orgRole.${q(sql, 'name')}) <> 'owner'
         WHERE gm.${q(sql, 'groupId')} = ? ORDER BY su.${q(sql, 'userId')} ASC`,
        [actor.organizationId, groupId]
    )
    const desiredRows = await query(
        `SELECT m.${q(sql, 'id')} AS mappingId, m.${q(sql, 'roleId')} AS roleId, su.${q(sql, 'userId')} AS userId
         FROM ${q(sql, 'identity_scim_mapping')} m
         INNER JOIN ${q(sql, 'identity_scim_group')} g ON g.${q(sql, 'id')} = m.${q(sql, 'groupId')} AND g.${q(sql, 'deletedAt')} IS NULL
         INNER JOIN ${q(sql, 'identity_scim_group_member')} gm ON gm.${q(sql, 'groupId')} = g.${q(sql, 'id')}
         INNER JOIN ${q(sql, 'identity_scim_user')} su ON su.${q(sql, 'id')} = gm.${q(sql, 'scimUserId')}
            AND su.${q(sql, 'deletedAt')} IS NULL
         INNER JOIN ${q(sql, 'user')} u ON u.${q(sql, 'id')} = su.${q(sql, 'userId')} AND LOWER(u.${q(sql, 'status')}) = 'active'
         INNER JOIN ${q(sql, 'organization_user')} ou ON ou.${q(sql, 'userId')} = u.${q(sql, 'id')}
            AND ou.${q(sql, 'organizationId')} = ? AND LOWER(ou.${q(sql, 'status')}) = 'active'
         WHERE m.${q(sql, 'organizationId')} = ? AND m.${q(sql, 'workspaceId')} = ?`,
        [actor.organizationId, actor.organizationId, workspaceId]
    )
    const existingRoles = new Map<string, Set<string>>()
    for (const row of desiredRows) {
        const mappedRoleId = nullable(cell(row, 'roleId')) || (await memberRole(query, sql))
        if (!(await safeRole(query, sql, actor.organizationId, mappedRoleId))) continue
        const userId = text(cell(row, 'userId'))
        const roles = existingRoles.get(userId) || new Set<string>()
        roles.add(mappedRoleId)
        existingRoles.set(userId, roles)
    }
    const memberships = await query(
        `SELECT wu.${q(sql, 'userId')} AS userId, wu.${q(sql, 'roleId')} AS roleId
         FROM ${q(sql, 'workspace_user')} wu WHERE wu.${q(sql, 'workspaceId')} = ?`,
        [workspaceId]
    )
    const membershipByUser = new Map(memberships.map((row) => [text(cell(row, 'userId')), text(cell(row, 'roleId'))]))
    const ownedRows = await query(
        `SELECT a.${q(sql, 'userId')} AS userId, a.${q(sql, 'roleId')} AS roleId
         FROM ${q(sql, 'identity_scim_assignment')} a
         INNER JOIN ${q(sql, 'identity_scim_mapping')} m ON m.${q(sql, 'id')} = a.${q(sql, 'mappingId')}
         WHERE m.${q(sql, 'organizationId')} = ? AND a.${q(sql, 'workspaceId')} = ?`,
        [actor.organizationId, workspaceId]
    )
    const ownedRoleByUser = new Map(ownedRows.map((row) => [text(cell(row, 'userId')), text(cell(row, 'roleId'))]))
    const workspaceName = text(cell(workspaces[0], 'name'))
    const roleName = text(cell(requestedRole, 'name'))
    const assignments: MappingPreviewAssignment[] = []
    const manualMemberships: MappingPreviewAssignment[] = []
    const conflicts: MappingPreviewConflict[] = []
    for (const row of candidates) {
        const userId = text(cell(row, 'userId'))
        const userName = text(cell(row, 'userName'))
        const currentRoleId = membershipByUser.get(userId) || null
        const currentRoleName = currentRoleId ? text(cell(roleById.get(currentRoleId) || {}, 'name')) || null : null
        const roleSet = new Set(existingRoles.get(userId) || [])
        roleSet.add(effectiveRoleId)
        const assignment = { userId, userName, workspaceId, workspaceName, roleId: effectiveRoleId, roleName }
        if (roleSet.size > 1) {
            conflicts.push({
                ...assignment,
                currentRoleId,
                currentRoleName,
                removesOwnedMembership: Boolean(currentRoleId && ownedRoleByUser.get(userId) === currentRoleId)
            })
        } else if (!currentRoleId) {
            assignments.push(assignment)
        } else if (!ownedRoleByUser.has(userId)) {
            manualMemberships.push({ ...assignment, roleId: currentRoleId, roleName: currentRoleName || currentRoleId })
        }
    }
    return {
        mapping: {
            groupId,
            groupName: group.displayName,
            workspaceId,
            workspaceName,
            roleId,
            effectiveRoleId,
            roleName
        },
        assignments,
        manualMemberships,
        conflicts
    }
}

function mappingCreationFingerprint(snapshot: MappingCreationSnapshot): string {
    return createHash('sha256').update(JSON.stringify(snapshot)).digest('base64url')
}

export async function previewMappingCreation(sql: Sql, actor: MappingAdminActor, body: unknown): Promise<Record<string, unknown>> {
    const snapshot = await mappingCreationSnapshot(sql.query, sql, actor, body)
    return { ...snapshot, fingerprint: mappingCreationFingerprint(snapshot) }
}

export async function createMapping(
    sql: Sql,
    actor: MappingAdminActor,
    body: unknown,
    fingerprint: unknown,
    now = Date.now()
): Promise<MappingRecord> {
    let id = ''
    let confirmedAssignmentCount = 0
    let confirmedConflictCount = 0
    await sql.transaction(async (query) => {
        const snapshot = await mappingCreationSnapshot(query, sql, actor, body)
        if (typeof fingerprint !== 'string' || fingerprint !== mappingCreationFingerprint(snapshot)) {
            throw new ScimError(409, 'The mapping preview changed. Preview the mapping again.', 'versionMismatch')
        }
        confirmedAssignmentCount = snapshot.assignments.length
        confirmedConflictCount = snapshot.conflicts.length
        id = randomUUID()
        await query(
            `INSERT INTO ${q(sql, 'identity_scim_mapping')} (${q(sql, 'id')}, ${q(sql, 'organizationId')}, ${q(sql, 'groupId')}, ${q(
                sql,
                'workspaceId'
            )}, ${q(sql, 'roleId')}, ${q(sql, 'createdAt')}, ${q(sql, 'createdBy')})
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                id,
                actor.organizationId,
                snapshot.mapping.groupId,
                snapshot.mapping.workspaceId,
                snapshot.mapping.roleId,
                utcDbTime(sql.type, now),
                actor.id
            ]
        )
        await reconcileMappings(query, sql, actor.organizationId, actor.id, now)
    })
    const created = (await mappingRows(sql, actor.organizationId)).find((mapping) => mapping.id === id)
    if (!created) throw new Error('SCIM_MAPPING_CREATE_FAILED')
    await auditMapping(
        sql,
        actor,
        'created',
        { id, groupId: created.groupId, workspaceId: created.workspaceId, roleId: created.roleId },
        confirmedAssignmentCount,
        confirmedConflictCount
    )
    return created
}

async function assignmentPreview(sql: Sql, actor: MappingAdminActor, mappingId: string): Promise<Array<Record<string, string>>> {
    const rows = await sql.query(
        `SELECT a.${q(sql, 'userId')} AS userId, u.${q(sql, 'name')} AS userName,
                a.${q(sql, 'workspaceId')} AS workspaceId, w.${q(sql, 'name')} AS workspaceName,
                a.${q(sql, 'roleId')} AS roleId, r.${q(sql, 'name')} AS roleName
         FROM ${q(sql, 'identity_scim_assignment')} a
         INNER JOIN ${q(sql, 'identity_scim_mapping')} m ON m.${q(sql, 'id')} = a.${q(sql, 'mappingId')}
         INNER JOIN ${q(sql, 'workspace_user')} wu ON wu.${q(sql, 'workspaceId')} = a.${q(sql, 'workspaceId')}
            AND wu.${q(sql, 'userId')} = a.${q(sql, 'userId')} AND wu.${q(sql, 'roleId')} = a.${q(sql, 'roleId')}
         INNER JOIN ${q(sql, 'user')} u ON u.${q(sql, 'id')} = a.${q(sql, 'userId')}
         INNER JOIN ${q(sql, 'workspace')} w ON w.${q(sql, 'id')} = a.${q(sql, 'workspaceId')}
         INNER JOIN ${q(sql, 'role')} r ON r.${q(sql, 'id')} = a.${q(sql, 'roleId')}
         WHERE a.${q(sql, 'mappingId')} = ? AND m.${q(sql, 'organizationId')} = ?
         ORDER BY a.${q(sql, 'userId')} ASC`,
        [mappingId, actor.organizationId]
    )
    return rows.map((row) => ({
        userId: text(cell(row, 'userId')),
        userName: text(cell(row, 'userName')),
        workspaceId: text(cell(row, 'workspaceId')),
        workspaceName: text(cell(row, 'workspaceName')),
        roleId: text(cell(row, 'roleId')),
        roleName: text(cell(row, 'roleName'))
    }))
}

function previewFingerprint(mappingId: string, assignments: Array<Record<string, string>>): string {
    return createHash('sha256').update(JSON.stringify({ mappingId, assignments })).digest('base64url')
}

export async function previewMappingRemoval(sql: Sql, actor: MappingAdminActor, mappingId: string): Promise<Record<string, unknown>> {
    const mapping = (await mappingRows(sql, actor.organizationId)).find((item) => item.id === mappingId)
    if (!mapping) throw new ScimError(404, 'Mapping not found.', 'noTarget')
    const assignments = await assignmentPreview(sql, actor, mappingId)
    return { mapping, assignments, fingerprint: previewFingerprint(mappingId, assignments) }
}

export async function removeMapping(
    sql: Sql,
    actor: MappingAdminActor,
    mappingId: string,
    fingerprint: unknown,
    now = Date.now()
): Promise<void> {
    let removed: { id: string; groupId: string; workspaceId: string; roleId: string | null } | null = null
    let removedAssignmentCount = 0
    await sql.transaction(async (query) => {
        const mappings = await query(
            `SELECT ${q(sql, 'id')} AS id, ${q(sql, 'groupId')} AS groupId, ${q(sql, 'workspaceId')} AS workspaceId,
                    ${q(sql, 'roleId')} AS roleId FROM ${q(sql, 'identity_scim_mapping')}
             WHERE ${q(sql, 'id')} = ? AND ${q(sql, 'organizationId')} = ?`,
            [mappingId, actor.organizationId]
        )
        if (!mappings.length) throw new ScimError(404, 'Mapping not found.', 'noTarget')
        const assignments = await assignmentPreview({ ...sql, query }, actor, mappingId)
        if (typeof fingerprint !== 'string' || fingerprint !== previewFingerprint(mappingId, assignments)) {
            throw new ScimError(409, 'The mapping assignments changed. Preview the removal again.', 'versionMismatch')
        }
        removed = {
            id: mappingId,
            groupId: text(cell(mappings[0], 'groupId')),
            workspaceId: text(cell(mappings[0], 'workspaceId')),
            roleId: nullable(cell(mappings[0], 'roleId'))
        }
        removedAssignmentCount = assignments.length
        await query(`DELETE FROM ${q(sql, 'identity_scim_mapping')} WHERE ${q(sql, 'id')} = ?`, [mappingId])
        for (const assignment of assignments) {
            const current = await query(
                `SELECT ${q(sql, 'roleId')} AS roleId FROM ${q(sql, 'workspace_user')}
                 WHERE ${q(sql, 'workspaceId')} = ? AND ${q(sql, 'userId')} = ?`,
                [assignment.workspaceId, assignment.userId]
            )
            if (current.length && text(cell(current[0], 'roleId')) === assignment.roleId) {
                await query(`DELETE FROM ${q(sql, 'workspace_user')} WHERE ${q(sql, 'workspaceId')} = ? AND ${q(sql, 'userId')} = ?`, [
                    assignment.workspaceId,
                    assignment.userId
                ])
                await query(
                    `UPDATE ${q(sql, 'user')} SET ${q(sql, 'permissionVersion')} = COALESCE(${q(
                        sql,
                        'permissionVersion'
                    )}, 0) + 1 WHERE ${q(sql, 'id')} = ?`,
                    [assignment.userId]
                )
            }
        }
        await query(`DELETE FROM ${q(sql, 'identity_scim_assignment')} WHERE ${q(sql, 'mappingId')} = ?`, [mappingId])
        await reconcileMappings(query, sql, actor.organizationId, actor.id, now)
    })
    if (removed) await auditMapping(sql, actor, 'removed', removed, removedAssignmentCount)
}

export async function sweepScimDiagnostics(sql: Sql, now = Date.now()): Promise<void> {
    await sql.query(`DELETE FROM ${q(sql, 'identity_scim_diagnostic')} WHERE ${q(sql, 'completedAt')} < ?`, [
        utcDbTime(sql.type, now - DIAGNOSTIC_RETENTION_MS)
    ])
}

export async function recordScimOperation(
    sql: Sql,
    input: {
        organizationId: string
        category: string
        outcome: 'success' | 'failed'
        correlationId: string
        detail?: string | null
        completedAt?: number
    }
): Promise<void> {
    const now = input.completedAt ?? Date.now()
    await sweepScimDiagnostics(sql, now)
    await sql.query(
        `INSERT INTO ${q(sql, 'identity_scim_diagnostic')} (${q(sql, 'id')}, ${q(sql, 'organizationId')}, ${q(sql, 'category')}, ${q(
            sql,
            'outcome'
        )}, ${q(sql, 'correlationId')}, ${q(sql, 'detail')}, ${q(sql, 'completedAt')})
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            randomUUID(),
            input.organizationId,
            input.category,
            input.outcome,
            input.correlationId,
            input.detail ? input.detail.slice(0, 500) : null,
            utcDbTime(sql.type, now)
        ]
    )
}

export async function readScimOperations(sql: Sql, organizationId: string, now = Date.now()): Promise<Record<string, unknown>> {
    await sweepScimDiagnostics(sql, now)
    const cutoff = utcDbTime(sql.type, now - DIAGNOSTIC_RETENTION_MS)
    const scope = `WHERE ${q(sql, 'organizationId')} = ? AND ${q(sql, 'completedAt')} >= ?`
    const [summaryRows, countRows, failedRows, recentErrors] = await Promise.all([
        sql.query(
            `SELECT MAX(${q(sql, 'completedAt')}) AS lastCompletedRequestAt,
                    MAX(CASE WHEN ${q(sql, 'outcome')} = 'success' THEN ${q(sql, 'completedAt')} ELSE NULL END) AS lastSuccessfulRequestAt,
                    MAX(CASE WHEN ${q(sql, 'outcome')} = 'failed' THEN ${q(sql, 'completedAt')} ELSE NULL END) AS lastFailedRequestAt
             FROM ${q(sql, 'identity_scim_diagnostic')} ${scope}`,
            [organizationId, cutoff]
        ),
        sql.query(
            `SELECT ${q(sql, 'category')} AS category, ${q(sql, 'outcome')} AS outcome, COUNT(*) AS count
             FROM ${q(sql, 'identity_scim_diagnostic')} ${scope}
             GROUP BY ${q(sql, 'category')}, ${q(sql, 'outcome')}`,
            [organizationId, cutoff]
        ),
        sql.query(
            `SELECT ${q(sql, 'category')} AS category FROM ${q(sql, 'identity_scim_diagnostic')} ${scope}
             AND ${q(sql, 'outcome')} = 'failed'
             ORDER BY ${q(sql, 'completedAt')} DESC, ${q(sql, 'id')} DESC LIMIT 1`,
            [organizationId, cutoff]
        ),
        sql.query(
            `SELECT ${q(sql, 'category')} AS category, ${q(sql, 'correlationId')} AS correlationId, ${q(sql, 'detail')} AS detail,
                    ${q(sql, 'completedAt')} AS completedAt
             FROM ${q(sql, 'identity_scim_diagnostic')} ${scope}
             AND ${q(sql, 'outcome')} = 'failed'
             ORDER BY ${q(sql, 'completedAt')} DESC, ${q(sql, 'id')} DESC LIMIT 20`,
            [organizationId, cutoff]
        )
    ])
    const counts: Record<string, number> = {}
    const failedCounts: Record<string, number> = {}
    for (const row of countRows) {
        const category = text(cell(row, 'category'))
        const target = text(cell(row, 'outcome')) === 'success' ? counts : failedCounts
        target[category] = Number(cell(row, 'count')) || 0
    }
    const summary = summaryRows[0] || {}
    return {
        lastSuccessfulRequestAt: iso(cell(summary, 'lastSuccessfulRequestAt')),
        lastFailedRequestAt: iso(cell(summary, 'lastFailedRequestAt')),
        lastFailedRequestCategory: failedRows.length ? text(cell(failedRows[0], 'category')) : null,
        lastCompletedRequestAt: iso(cell(summary, 'lastCompletedRequestAt')),
        counts,
        failedCounts,
        recentErrors: recentErrors.map((row) => ({
            category: text(cell(row, 'category')),
            detail: nullable(cell(row, 'detail')),
            correlationId: text(cell(row, 'correlationId')),
            completedAt: iso(cell(row, 'completedAt'))
        })),
        retentionDays: 30
    }
}
