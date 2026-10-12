import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { turnBudgetMs } from './budget.mjs'
import { HarnessError } from './errors.mjs'
import { dataRoot } from './paths.mjs'
import { sessionKey } from './session.mjs'

export const BUSY_MESSAGE = 'This chat already has a harness turn in progress.'

let cached = null

export function queueDbPath() {
    return path.join(dataRoot(), 'harness-queue.sqlite')
}

export function database() {
    if (cached) return cached
    const file = queueDbPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS turns (
            session_key TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            session_key TEXT NOT NULL,
            status TEXT NOT NULL,
            payload TEXT NOT NULL,
            result TEXT,
            error_code TEXT,
            error_message TEXT,
            cancel_requested INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jobs_claim ON jobs (status, created_at);
        CREATE TABLE IF NOT EXISTS job_events (
            job_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            event TEXT NOT NULL,
            PRIMARY KEY (job_id, seq)
        );
    `)
    cached = db
    return db
}

export function closeQueueDb() {
    if (!cached) return
    try {
        cached.close()
    } catch {
        // Already closed.
    }
    cached = null
}

// 0 means the row does not expire. Otherwise a dead worker cannot pin the chat past this.
export function lockTtlMs() {
    const raw = process.env.CUTTLELY_HARNESS_LOCK_MS
    if (raw != null && String(raw).trim() !== '') {
        const n = Number(raw)
        if (Number.isFinite(n) && n >= 0) return Math.floor(n)
    }
    const budget = turnBudgetMs()
    return budget > 0 ? budget + 5000 : 120000
}

function expiresAt(now) {
    const ttl = lockTtlMs()
    return ttl === 0 ? Number.MAX_SAFE_INTEGER : now + ttl
}

function isConstraint(error) {
    const code = String(error?.code || '')
    return code.includes('CONSTRAINT') || /unique|constraint/i.test(String(error?.message || ''))
}

export function immediate(fn) {
    const db = database()
    db.exec('BEGIN IMMEDIATE')
    try {
        const value = fn(db)
        db.exec('COMMIT')
        return value
    } catch (error) {
        try {
            db.exec('ROLLBACK')
        } catch {
            // The transaction is already closed.
        }
        throw error
    }
}

export function acquireTurn(name, chatId) {
    const key = sessionKey(name, chatId)
    const owner = `${process.pid}:${randomUUID()}`
    const now = Date.now()
    try {
        immediate((db) => {
            db.prepare('DELETE FROM turns WHERE session_key = ? AND expires_at <= ?').run(key, now)
            db.prepare('INSERT INTO turns (session_key, owner, expires_at) VALUES (?, ?, ?)').run(key, owner, expiresAt(now))
        })
    } catch (error) {
        if (error?.code === 'busy') throw error
        if (isConstraint(error)) throw new HarnessError('busy', BUSY_MESSAGE)
        throw error
    }
    return { key, owner }
}

export function releaseTurn(held) {
    if (!held?.key || !held?.owner) return
    database().prepare('DELETE FROM turns WHERE session_key = ? AND owner = ?').run(held.key, held.owner)
}

export function turnBusyError() {
    return new HarnessError('busy', BUSY_MESSAGE)
}
