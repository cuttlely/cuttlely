// Live-save audit for pinned queries. Draft saves do not call this.
// Detail keys are an allowlist: audit redaction drops any key matching FORBIDDEN_KEY,
// including "credential" and "token", so this file uses cred, paramNames, pin, flow, and node.
// The row records the flow, node, pin name, version, statement hash, and user. It never records
// SQL text or parameter values.

import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { safeRecordAudit } from '../../identity/auditLog'
import logger from '../../utils/logger'

export type PinnedChangeKind = 'create' | 'edit' | 'delete' | 'test'

export interface PinnedQueryActor {
    id?: string | null
    /** Display name is accepted so a version actor can be passed through. It is never written. */
    name?: string | null
}

/** What the test route passes after a test has already run. Extra fields are ignored. */
export interface PinnedQueryTestAudit {
    organizationId: string
    workspaceId?: string | null
    userId?: string | null
    flow: string
    node: string
    pin: string
    version?: number | string | null
    hash?: string | null
    cred?: string | null
    paramNames?: readonly string[] | null
}

interface PinSnap {
    key: string
    node: string
    pin: string
    version: number | string | null
    cred: string | null
    paramNames: string[]
    signature: string
    entry: unknown
}

export interface PinnedQueryChange {
    kind: 'create' | 'edit' | 'delete'
    flow: string
    node: string
    pin: string
    version: number | string | null
    cred: string | null
    paramNames: string[]
    entry: unknown
}

type HashFn = (entry: unknown) => string | Promise<string>

let hashForTests: HashFn | null = null

/** Jest seam. Production calls statementHash in the runtime module. */
export function setPinnedQueryHashForTests(fn: HashFn | null): void {
    hashForTests = fn
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
}

function parseFlow(flowData: unknown): { nodes: unknown[] } | null {
    let parsed: unknown = flowData
    if (typeof flowData === 'string') {
        if (!flowData.trim()) return { nodes: [] }
        try {
            parsed = JSON.parse(flowData)
        } catch {
            return null
        }
    }
    const record = asRecord(parsed)
    if (!record || !Array.isArray(record.nodes)) return flowData == null || flowData === '' ? { nodes: [] } : null
    return { nodes: record.nodes }
}

function credId(node: Record<string, unknown>): string | null {
    const data = asRecord(node.data)
    const raw = data?.credential
    const id = typeof raw === 'string' ? raw : typeof asRecord(raw)?.id === 'string' ? (asRecord(raw)?.id as string) : ''
    const trimmed = id.trim()
    if (!trimmed || trimmed.length > 200 || /[\s:@]/.test(trimmed) || trimmed.includes('://')) return null
    return trimmed
}

function versionOf(entry: Record<string, unknown>): number | string | null {
    const version = entry.version
    if (typeof version === 'number' && Number.isFinite(version)) return version
    if (typeof version === 'string' && version.length > 0 && version.length <= 40 && !/\s/.test(version)) return version
    return null
}

function paramNamesOf(entry: Record<string, unknown>): string[] {
    if (!Array.isArray(entry.params)) return []
    const names: string[] = []
    for (const item of entry.params) {
        const name = asRecord(item)?.name
        if (typeof name === 'string' && name.trim()) names.push(name)
    }
    return names
}

/** Compared so a real edit is seen. Not written to the audit row. */
function signatureOf(entry: Record<string, unknown>, pin: string): string {
    const params = Array.isArray(entry.params)
        ? entry.params.map((item) => {
              const param = asRecord(item)
              if (!param) return null
              return {
                  name: typeof param.name === 'string' ? param.name : '',
                  type: typeof param.type === 'string' ? param.type : '',
                  required: param.required === undefined ? null : param.required === true,
                  default: param.default === undefined ? null : param.default,
                  allowedValues: param.allowedValues === undefined ? null : param.allowedValues,
                  min: param.min === undefined ? null : param.min,
                  max: param.max === undefined ? null : param.max,
                  secure: param.secure === true
              }
          })
        : []
    const columns = Array.isArray(entry.testedColumns)
        ? entry.testedColumns.map((item) => {
              const column = asRecord(item)
              return {
                  name: typeof column?.name === 'string' ? column.name : '',
                  type: typeof column?.type === 'string' ? column.type : ''
              }
          })
        : []
    return JSON.stringify({
        pin,
        version: versionOf(entry),
        purpose: typeof entry.purpose === 'string' ? entry.purpose : '',
        description: typeof entry.description === 'string' ? entry.description : '',
        sql: typeof entry.sql === 'string' ? entry.sql : '',
        params,
        rowCap: entry.rowCap === undefined ? null : entry.rowCap,
        testedStamp: typeof entry.testedStamp === 'string' ? entry.testedStamp : '',
        testedAt: typeof entry.testedAt === 'string' ? entry.testedAt : '',
        testedBy: typeof entry.testedBy === 'string' ? entry.testedBy : '',
        testedColumns: columns,
        needsRetest: entry.needsRetest === true
    })
}

function readNodePins(node: unknown): { ok: true; pins: PinSnap[] } | { ok: false } {
    const record = asRecord(node)
    if (!record || typeof record.id !== 'string' || !record.id) return { ok: true, pins: [] }
    const data = asRecord(record.data)
    const inputs = asRecord(data?.inputs)
    const raw = inputs?.pinnedQueries
    if (raw == null || raw === '') return { ok: true, pins: [] }
    let list: unknown
    if (Array.isArray(raw)) list = raw
    else if (typeof raw === 'string') {
        try {
            list = JSON.parse(raw)
        } catch {
            return { ok: false }
        }
    } else return { ok: false }
    if (!Array.isArray(list)) return { ok: false }
    const cred = credId(record)
    const pins: PinSnap[] = []
    for (const item of list) {
        const entry = asRecord(item)
        if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) continue
        const pin = entry.name
        const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : ''
        pins.push({
            key: `${record.id}\0${id || 'name:' + pin}`,
            node: record.id,
            pin,
            version: versionOf(entry),
            cred,
            paramNames: paramNamesOf(entry),
            signature: signatureOf(entry, pin),
            entry
        })
    }
    return { ok: true, pins }
}

type NodePins = { ok: true; pins: PinSnap[] } | { ok: false }

function pinsByNode(flowData: unknown): Map<string, NodePins> | null {
    const flow = parseFlow(flowData)
    if (!flow) return null
    const byNode = new Map<string, NodePins>()
    for (const node of flow.nodes) {
        const id = asRecord(node)?.id
        if (typeof id !== 'string' || !id) continue
        byNode.set(id, readNodePins(node))
    }
    return byNode
}

/**
 * Pins added, changed, or removed between two saved canvases.
 * A node whose pin list cannot be read is left out, so a bad value does not look like a delete.
 * Sample fields that are not part of the pin definition do not count as an edit.
 */
export function diffPinnedQueries(previousFlowData: unknown, nextFlowData: unknown, flowId = ''): PinnedQueryChange[] {
    const before = pinsByNode(previousFlowData) ?? new Map<string, NodePins>()
    const after = pinsByNode(nextFlowData) ?? new Map<string, NodePins>()
    const nodeIds = new Set<string>([...before.keys(), ...after.keys()])
    const changes: PinnedQueryChange[] = []
    for (const nodeId of nodeIds) {
        const oldNode = before.get(nodeId)
        const newNode = after.get(nodeId)
        if ((oldNode && !oldNode.ok) || (newNode && !newNode.ok)) continue
        const oldPins = new Map<string, PinSnap>((oldNode && oldNode.ok ? oldNode.pins : []).map((pin) => [pin.key, pin]))
        const newPins = new Map<string, PinSnap>((newNode && newNode.ok ? newNode.pins : []).map((pin) => [pin.key, pin]))
        for (const [key, pin] of oldPins) {
            if (!newPins.has(key)) changes.push(changeOf('delete', flowId, pin))
        }
        for (const [key, pin] of newPins) {
            const previous = oldPins.get(key)
            if (!previous) changes.push(changeOf('create', flowId, pin))
            else if (previous.signature !== pin.signature) changes.push(changeOf('edit', flowId, pin))
        }
    }
    changes.sort((a, b) => `${a.node}\0${a.kind}\0${a.pin}`.localeCompare(`${b.node}\0${b.kind}\0${b.pin}`))
    return changes
}

function changeOf(kind: 'create' | 'edit' | 'delete', flow: string, pin: PinSnap): PinnedQueryChange {
    return {
        kind,
        flow,
        node: pin.node,
        pin: pin.pin,
        version: pin.version,
        cred: pin.cred,
        paramNames: pin.paramNames,
        entry: pin.entry
    }
}

function validHash(hash: unknown): string | null {
    if (typeof hash !== 'string') return null
    const trimmed = hash.trim().toLowerCase()
    return /^[a-f0-9]{64}$/.test(trimmed) ? trimmed : null
}

function runtimeUrl(): string | null {
    const file = path.resolve(__dirname, '../../../../harness/runtime/pinned-query.mjs')
    return fs.existsSync(file) ? pathToFileURL(file).href : null
}

async function statementHashOf(entry: unknown): Promise<string | null> {
    try {
        if (hashForTests) return validHash(await hashForTests(entry))
        const url = runtimeUrl()
        if (!url) return null
        const mod = (await import(url)) as { statementHash?: (entry: unknown) => string }
        if (typeof mod.statementHash !== 'function') return null
        return validHash(mod.statementHash(entry))
    } catch {
        return null
    }
}

/** Allowlist. Anything else, including SQL and parameter values, stays out of the row. */
export function pinnedAuditDetail(input: {
    kind: PinnedChangeKind
    flow: string
    node: string
    pin: string
    version?: number | string | null
    hash?: string | null
    cred?: string | null
    paramNames?: readonly string[] | null
    user?: string | null
}): Record<string, unknown> {
    const detail: Record<string, unknown> = {
        kind: input.kind,
        flow: input.flow,
        node: input.node,
        pin: input.pin
    }
    if (typeof input.version === 'number' || typeof input.version === 'string') detail.version = input.version
    const hash = validHash(input.hash)
    if (hash) detail.hash = hash
    if (typeof input.cred === 'string' && input.cred) detail.cred = input.cred
    if (Array.isArray(input.paramNames)) detail.paramNames = input.paramNames.filter((name) => typeof name === 'string')
    if (typeof input.user === 'string' && input.user) detail.user = input.user
    return detail
}

function summaryFor(kind: PinnedChangeKind, pin: string): string {
    const action = kind === 'create' ? 'created' : kind === 'edit' ? 'edited' : kind === 'delete' ? 'deleted' : 'tested'
    const name = pin.replace(/[\u0000-\u001f]/g, '').slice(0, 80)
    return `Pinned query ${name} ${action}`.slice(0, 200)
}

async function writePinnedAudit(input: {
    organizationId: string
    workspaceId?: string | null
    userId?: string | null
    kind: PinnedChangeKind
    flow: string
    node: string
    pin: string
    version?: number | string | null
    hash?: string | null
    cred?: string | null
    paramNames?: readonly string[] | null
}): Promise<void> {
    const organizationId = typeof input.organizationId === 'string' ? input.organizationId.trim() : ''
    if (!organizationId || !input.flow || !input.node || !input.pin || !input.kind) return
    const userId = typeof input.userId === 'string' && input.userId ? input.userId : null
    try {
        const { applicationSql } = await import('../../identity/production')
        await safeRecordAudit(applicationSql(), {
            type: 'pinned_query_change',
            organizationId,
            workspaceId: input.workspaceId ?? null,
            userId,
            actorId: userId,
            summary: summaryFor(input.kind, input.pin),
            detail: pinnedAuditDetail({ ...input, user: userId })
        })
    } catch {
        logger.warn('[server]: pinned query audit event was not saved')
    }
}

export async function auditPinnedQuerySave(input: {
    flowId: string
    organizationId: string
    workspaceId?: string | null
    actor?: PinnedQueryActor | null
    previousFlowData?: unknown
    nextFlowData?: unknown
}): Promise<void> {
    let changes: PinnedQueryChange[] = []
    try {
        changes = diffPinnedQueries(input.previousFlowData, input.nextFlowData, input.flowId)
    } catch {
        logger.warn('[server]: pinned query audit event was not saved')
        return
    }
    if (!changes.length) return
    const userId = typeof input.actor?.id === 'string' && input.actor.id ? input.actor.id : null
    for (const change of changes) {
        const hash = await statementHashOf(change.entry)
        await writePinnedAudit({
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            userId,
            kind: change.kind,
            flow: input.flowId,
            node: change.node,
            pin: change.pin,
            version: change.version,
            hash,
            cred: change.cred,
            paramNames: change.paramNames
        })
    }
}

/** The test route calls this after a test. Draft saves do not. */
export async function recordPinnedQueryTest(input: PinnedQueryTestAudit): Promise<void> {
    const names = Array.isArray(input.paramNames) ? input.paramNames.filter((name) => typeof name === 'string') : []
    await writePinnedAudit({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        kind: 'test',
        flow: input.flow,
        node: input.node,
        pin: input.pin,
        version: input.version,
        hash: input.hash,
        cred: input.cred,
        paramNames: names
    })
}
