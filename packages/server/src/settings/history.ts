// Change history for server settings: settings/history.jsonl, one JSON object per line.
// The newest CUTTLELY_HISTORY_KEEP rows are kept (1000 unless that limit says otherwise).
// Each append rewrites the file under its own lock, so two saves cannot drop a row that is still inside the cap.
// Secret values never go in. A secret change is recorded as "changed" and nothing else.
import fs from 'fs'
import path from 'path'
import { withNamedLockSync } from './lock'
import { settingFor } from './registry'
import { invalidateRuntimeCache, runtimeNumber } from './runtime'
import { HISTORY_FILE, writeFileAtomic } from './store'

const SECRET_PARTS = new Set(['SECRET', 'PASSWORD', 'TOKEN', 'CREDENTIAL', 'SECRETKEY'])

/** A known setting uses its registry type. An unknown name is secret when a name part is a secret word. */
export function isSecretSettingKey(key: string): boolean {
    const setting = settingFor(key)
    if (setting) return setting.type === 'secret'
    const parts = key.toUpperCase().split('_').filter(Boolean)
    if (parts.some((part) => SECRET_PARTS.has(part))) return true
    for (let index = 0; index < parts.length - 1; index += 1) {
        if (parts[index] === 'API' && parts[index + 1] === 'KEY') return true
    }
    return false
}

export const HISTORY_PAGE_DEFAULT = 50
export const HISTORY_PAGE_MAX = 100
export const HISTORY_KEEP_KEY = 'CUTTLELY_HISTORY_KEEP'
export const HISTORY_KEEP_DEFAULT = 1000
const HISTORY_LOCK = '.history.lock'

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

/** How many history rows to keep. A valid host value, then the saved value, then 1000. */
export function historyKeepLimit(env: Record<string, string | undefined> = process.env): number {
    return runtimeNumber(HISTORY_KEEP_KEY, env)
}

function readRawLines(dir: string): string[] {
    try {
        return fs
            .readFileSync(path.join(dir, HISTORY_FILE), 'utf8')
            .split('\n')
            .filter((line) => line.trim())
    } catch {
        return []
    }
}

function parseStored(line: string): HistoryEntry | null {
    try {
        const parsed = JSON.parse(line) as HistoryEntry
        if (parsed && typeof parsed.at === 'string' && typeof parsed.kind === 'string') return parsed
    } catch {
        // A damaged line is left out of the rewrite. It was already skipped on read.
    }
    return null
}

function normalizeKeep(keep: number): number {
    if (!Number.isInteger(keep) || keep < 1 || keep > Number.MAX_SAFE_INTEGER) return HISTORY_KEEP_DEFAULT
    return keep
}

/**
 * Adds one row and keeps the newest `keep` rows. `keep` defaults to the runtime limit.
 * The limit is read after this process holds the history lock, so a cap saved while this append waited is the one used.
 * The rewrite is one temp file moved into place.
 */
export function appendHistory(
    dir: string,
    entry: Omit<HistoryEntry, 'at' | 'seq'> & { at?: string; seq?: number },
    keep?: number
): HistoryEntry {
    return withNamedLockSync(dir, HISTORY_LOCK, () => {
        if (keep === undefined) invalidateRuntimeCache()
        const limit = normalizeKeep(keep ?? historyKeepLimit())
        const existing = readRawLines(dir)
            .map(parseStored)
            .filter((row): row is HistoryEntry => row !== null)
        assignSequence(existing)
        let max = 0
        for (const row of existing) if ((row.seq ?? 0) > max) max = row.seq ?? 0
        const { seq, at, ...rest } = entry
        const full = redact({ ...rest, seq: seq ?? max + 1, at: at ?? new Date().toISOString() })
        const kept = [...existing, full].slice(-limit)
        const text = kept.length ? kept.map((row) => JSON.stringify(row)).join('\n') + '\n' : ''
        writeFileAtomic(dir, HISTORY_FILE, text)
        return full
    })
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
