// Change history for server settings: settings/history.jsonl, one JSON object per line, append-only.
// Secret values never go in: a secret change is recorded as set, replaced or removed.
import fs from 'fs'
import path from 'path'
import { settingFor } from './registry'
import { HISTORY_FILE } from './store'

export type HistoryKind = 'save' | 'discard' | 'restore' | 'rollback' | 'unset' | 'restart' | 'start' | 'test'

export interface HistoryChange {
    key: string
    /** Plain values only. Absent for secrets. */
    from?: string
    to?: string
    /** For secrets: what happened, never the value. */
    secret?: 'set' | 'replaced' | 'removed'
}

export interface HistoryEntry {
    at: string
    kind: HistoryKind
    /** Who did it: an email for the page, "command line" for the CLI, "safe boot" for a rollback. */
    by?: string
    changes?: HistoryChange[]
    /** What happened, in plain words (no values). */
    note?: string
    outcome?: 'ok' | 'failed'
}

/** The changes between two sets of values, with secrets reduced to set/replaced/removed. */
export function describeChanges(before: Record<string, string>, after: Record<string, string>): HistoryChange[] {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    const changes: HistoryChange[] = []
    for (const key of keys) {
        const from = before[key] ?? ''
        const to = after[key] ?? ''
        if (from === to) continue
        if (settingFor(key)?.type === 'secret') {
            changes.push({ key, secret: !from ? 'set' : !to ? 'removed' : 'replaced' })
        } else {
            changes.push({ key, from, to })
        }
    }
    return changes
}

export function appendHistory(dir: string, entry: Omit<HistoryEntry, 'at'> & { at?: string }): HistoryEntry {
    const full: HistoryEntry = { at: entry.at ?? new Date().toISOString(), ...entry }
    for (const change of full.changes ?? []) {
        if (settingFor(change.key)?.type === 'secret') {
            delete change.from
            delete change.to
        }
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, HISTORY_FILE)
    fs.appendFileSync(file, JSON.stringify(full) + '\n', { mode: 0o600 })
    return full
}

/** Newest first. Lines that are not valid JSON are skipped. */
export function readHistory(dir: string, limit = 200): HistoryEntry[] {
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
            const parsed = JSON.parse(line)
            if (parsed && typeof parsed.at === 'string' && typeof parsed.kind === 'string') entries.push(parsed)
        } catch {
            // skip a damaged line
        }
    }
    return entries.reverse().slice(0, limit)
}
