// Change history for server settings: settings/history.jsonl, one JSON object per line, append-only.
// Retention is unbounded: the file grows with each change. Nothing here compacts it.
// Secret values never go in. A secret change is recorded as "changed" and nothing else.
import fs from 'fs'
import path from 'path'
import { isSecretSettingKey } from './runtime'
import { HISTORY_FILE } from './store'

export const HISTORY_PAGE_DEFAULT = 50
export const HISTORY_PAGE_MAX = 100

export type HistoryKind = 'save' | 'discard' | 'restore' | 'rollback' | 'unset' | 'restart' | 'start' | 'test'

export interface HistoryChange {
    key: string
    /** Plain values only. Absent for secrets. */
    from?: string
    to?: string
    /** For secrets: always "changed". Never the value. */
    secret?: 'changed' | 'set' | 'replaced' | 'removed'
}

export interface HistoryEntry {
    /** File order, oldest is 1. Older lines written before this field existed get one when they are read. */
    seq?: number
    at: string
    kind: HistoryKind
    /** Who did it: an email for the page, "command line" for the CLI, "safe boot" for a rollback. */
    by?: string
    /** The user id, when a signed-in person did it. No display name. */
    actorId?: string
    /** Stable name for a save, so a later export can filter on it. */
    event?: string
    changes?: HistoryChange[]
    /** What happened, in plain words (no values). */
    note?: string
    outcome?: 'ok' | 'failed'
}

export interface HistoryPage {
    entries: HistoryEntry[]
    /** Null on the last page. */
    nextCursor: string | null
    limit: number
}

/** The changes between two sets of values. A secret is "changed" and the values are left out. */
export function describeChanges(before: Record<string, string>, after: Record<string, string>): HistoryChange[] {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    const changes: HistoryChange[] = []
    for (const key of keys) {
        const from = before[key] ?? ''
        const to = after[key] ?? ''
        if (from === to) continue
        if (isSecretSettingKey(key)) changes.push({ key, secret: 'changed' })
        else changes.push({ key, from, to })
    }
    return changes
}

function redact(entry: HistoryEntry): HistoryEntry {
    for (const change of entry.changes ?? []) {
        if (isSecretSettingKey(change.key) || change.secret) {
            delete change.from
            delete change.to
            change.secret = 'changed'
        }
    }
    return entry
}

function readLines(dir: string): HistoryEntry[] {
    let raw: string
    try {
        raw = fs.readFileSync(path.join(dir, HISTORY_FILE), 'utf8')
    } catch {
        return []
    }
    const entries: HistoryEntry[] = []
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
            const parsed = JSON.parse(line) as HistoryEntry
            if (parsed && typeof parsed.at === 'string' && typeof parsed.kind === 'string') entries.push(parsed)
        } catch {
            // skip a damaged line
        }
    }
    return assignSequence(entries)
}

function assignSequence(entries: HistoryEntry[]): HistoryEntry[] {
    const used = new Set<number>()
    for (const entry of entries) {
        if (typeof entry.seq === 'number' && Number.isInteger(entry.seq) && entry.seq > 0) used.add(entry.seq)
    }
    let next = 1
    for (const entry of entries) {
        if (typeof entry.seq === 'number' && Number.isInteger(entry.seq) && entry.seq > 0) continue
        while (used.has(next)) next += 1
        entry.seq = next
        used.add(next)
        next += 1
    }
    return entries
}

function nextSequence(dir: string): number {
    const entries = readLines(dir)
    let max = 0
    for (const entry of entries) if ((entry.seq ?? 0) > max) max = entry.seq ?? 0
    return max + 1
}

export function appendHistory(dir: string, entry: Omit<HistoryEntry, 'at' | 'seq'> & { at?: string; seq?: number }): HistoryEntry {
    const { seq, at, ...rest } = entry
    const full = redact({ ...rest, seq: seq ?? nextSequence(dir), at: at ?? new Date().toISOString() })
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.appendFileSync(path.join(dir, HISTORY_FILE), JSON.stringify(full) + '\n', { mode: 0o600 })
    return full
}

/** Newest first. Lines that are not valid JSON are skipped. */
export function readHistory(dir: string, limit = 200): HistoryEntry[] {
    return readLines(dir)
        .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
        .slice(0, limit)
}

export function encodeHistoryCursor(seq: number): string {
    return Buffer.from(JSON.stringify({ seq }), 'utf8').toString('base64url')
}

/** Throws when the cursor is not a cursor this server issued. */
export function decodeHistoryCursor(token: string): number {
    let parsed: unknown
    try {
        const raw = Buffer.from(token, 'base64url').toString('utf8')
        if (!raw.startsWith('{')) throw new Error('invalid')
        parsed = JSON.parse(raw)
    } catch {
        throw new Error('invalid')
    }
    if (!parsed || typeof parsed !== 'object' || !('seq' in parsed)) throw new Error('invalid')
    const seq = (parsed as { seq: unknown }).seq
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1 || seq > Number.MAX_SAFE_INTEGER) throw new Error('invalid')
    return seq
}

/**
 * Newest first. A cursor asks for entries strictly older than that sequence.
 * limit is the page size already checked by the route.
 */
export function pageHistory(dir: string, options: { limit: number; cursor?: number | null }): HistoryPage {
    let rows = readLines(dir)
    if (options.cursor) rows = rows.filter((entry) => (entry.seq ?? 0) < options.cursor!)
    rows.sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
    const page = rows.slice(0, options.limit)
    const last = page[page.length - 1]
    const more = rows.length > options.limit && last?.seq
    return {
        entries: page,
        nextCursor: more ? encodeHistoryCursor(last.seq as number) : null,
        limit: options.limit
    }
}
