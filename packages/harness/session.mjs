import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { HarnessError } from './errors.mjs'
import { dataRoot, profileDir } from './paths.mjs'
import { adoptLegacyChiefProfile, assertChiefProfileAvailable } from './profile.mjs'

// Unpublished canvas sessions are not runtime profiles. The scope keeps equal
// names in different canvases or teams from sharing draft conversation state.
export function draftSessionScope({ workspaceId, chatflowId }) {
    if (![workspaceId, chatflowId].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 128))
        throw new HarnessError('bad_session', 'A draft session needs its workspace and canvas identity.')
    return createHash('sha256')
        .update(JSON.stringify([workspaceId, chatflowId]))
        .digest('hex')
}

export function sessionKey(harnessName, chatId) {
    if (!harnessName || !chatId) {
        throw new HarnessError('bad_session', 'A harness session needs a harness name and a chat id.')
    }
    return `${harnessName}:${chatId}`
}

function dbPath(harnessName, scope, create) {
    if (scope !== undefined) {
        if (typeof scope !== 'string' || !/^[a-f0-9]{64}$/.test(scope))
            throw new HarnessError('bad_session', 'The draft session scope is not valid.')
        let dir = path.resolve(dataRoot())
        if (create) fs.mkdirSync(dir, { recursive: true })
        for (const part of ['harness-draft-sessions', scope]) {
            dir = path.join(dir, part)
            if (create && !fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 })
            let stat
            try {
                stat = fs.lstatSync(dir)
            } catch (error) {
                if (!create && error.code === 'ENOENT')
                    return path.join(path.resolve(dataRoot()), 'harness-draft-sessions', scope, 'sessions.sqlite')
                throw error
            }
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw new HarnessError('bad_session', 'The draft session directory is not a plain directory.')
        }
        const file = path.join(dir, 'sessions.sqlite')
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
            try {
                const stat = fs.lstatSync(file + suffix)
                if (!stat.isFile() || stat.isSymbolicLink())
                    throw new HarnessError('bad_session', 'The draft session file is not a plain file.')
            } catch (error) {
                if (error.code !== 'ENOENT') throw error
            }
        }
        return file
    }
    assertChiefProfileAvailable(harnessName)
    adoptLegacyChiefProfile(harnessName)
    return path.join(profileDir(harnessName), 'sessions.sqlite')
}

// One connection per session file for the life of the process. Opening the file and
// re-running the schema on every turn cost tens of milliseconds on a Windows-mounted drive.
const connections = new Map()

function connection(harnessName, { create, scope }) {
    const file = dbPath(harnessName, scope, create)
    const cached = connections.get(file)
    if (cached) {
        if (fs.existsSync(file)) return cached
        closeConnection(file)
    }
    if (!create && !fs.existsSync(file)) return null
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS sessions (
            session_key TEXT PRIMARY KEY,
            harness_name TEXT NOT NULL,
            chat_id TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_key TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS messages_session ON messages (session_key, id);
        CREATE TABLE IF NOT EXISTS memory (
            session_key TEXT PRIMARY KEY,
            summary TEXT NOT NULL,
            pins TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS answer_context (
            session_key TEXT PRIMARY KEY,
            selections TEXT NOT NULL
        );
    `)
    const entry = {
        db,
        ensure: db.prepare(
            `INSERT INTO sessions (session_key, harness_name, chat_id, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(session_key) DO NOTHING`
        ),
        insert: db.prepare(`INSERT INTO messages (session_key, role, content, created_at) VALUES (?, ?, ?, ?)`),
        all: db.prepare(`SELECT role, content, created_at FROM messages WHERE session_key = ? ORDER BY id ASC`),
        recent: db.prepare(`SELECT role, content, created_at FROM messages WHERE session_key = ? ORDER BY id DESC LIMIT ?`),
        memoryGet: db.prepare(`SELECT summary, pins FROM memory WHERE session_key = ?`),
        selectionsGet: db.prepare(`SELECT selections FROM answer_context WHERE session_key = ?`),
        selectionsPut: db.prepare(`INSERT INTO answer_context (session_key, selections) VALUES (?, ?)
            ON CONFLICT(session_key) DO UPDATE SET selections = excluded.selections`),
        memoryPut: db.prepare(
            `INSERT INTO memory (session_key, summary, pins, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(session_key) DO UPDATE SET summary = excluded.summary, pins = excluded.pins, updated_at = excluded.updated_at`
        ),
        userTurns: db.prepare(
            `SELECT m.content AS content, m.created_at AS createdAt, m.id AS id
             FROM messages m
             JOIN sessions s ON s.session_key = m.session_key
             WHERE s.harness_name = ? AND m.role = 'user'
             ORDER BY m.created_at DESC, m.id DESC
             LIMIT ?`
        )
    }
    connections.set(file, entry)
    return entry
}

function closeConnection(file) {
    const entry = connections.get(file)
    connections.delete(file)
    try {
        entry?.db.close()
    } catch {
        // Already closed.
    }
}

export function closeSessions() {
    for (const file of [...connections.keys()]) closeConnection(file)
}

// Called only after the owning canvas delete commits. This state is never served by the runtime.
export function removeDraftSessions(canvas) {
    const scope = draftSessionScope(canvas)
    const file = dbPath('', scope, false)
    closeConnection(file)
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
}

function writeMessages(harnessName, chatId, messages, selections, scope) {
    const key = sessionKey(harnessName, chatId)
    const entry = connection(harnessName, { create: true, scope })
    const now = new Date().toISOString()
    entry.db.exec('BEGIN')
    try {
        entry.ensure.run(key, harnessName, chatId, now)
        for (const [role, content] of messages) entry.insert.run(key, role, content, now)
        if (selections?.length) entry.selectionsPut.run(key, JSON.stringify(selections))
        entry.db.exec('COMMIT')
    } catch (error) {
        entry.db.exec('ROLLBACK')
        throw error
    }
    return key
}

export function ensureSession(harnessName, chatId) {
    return writeMessages(harnessName, chatId, [])
}

export function appendMessage(harnessName, chatId, role, content) {
    return writeMessages(harnessName, chatId, [[role, content]])
}

const RAW_TURNS = 2
const RAW_MESSAGES = RAW_TURNS * 2
const SUMMARY_CHARS = 1600
const PIN_LIMIT = 8
const PIN_CHARS = 160

function oneLine(text, max) {
    const flat = String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
    return flat.length > max ? `${flat.slice(0, max)}...` : flat
}

function pinsFromText(text) {
    const pins = []
    for (const line of String(text || '').split('\n')) {
        const match = line.match(/^\s*pin:(.*)$/i)
        if (match?.[1].trim()) pins.push(match[1].trim())
    }
    return pins
}

function mergePins(existing, incoming) {
    const next = []
    for (const pin of [...existing, ...incoming]) {
        const clean = String(pin || '')
            .trim()
            .slice(0, PIN_CHARS)
        if (!clean) continue
        const at = next.indexOf(clean)
        if (at !== -1) next.splice(at, 1)
        next.push(clean)
    }
    return next.slice(-PIN_LIMIT)
}

function summarizeOlder(messages) {
    const lines = []
    for (let i = 0; i < messages.length; ) {
        const current = messages[i]
        const next = messages[i + 1]
        if (current?.role === 'user' && next?.role === 'assistant') {
            lines.push(`Q: ${oneLine(current.content, 120)} A: ${oneLine(next.content, 160)}`)
            i += 2
        } else if (current) {
            lines.push(`${current.role}: ${oneLine(current.content, 120)}`)
            i += 1
        } else break
    }
    while (lines.length > 1 && lines.join('\n').length > SUMMARY_CHARS) lines.shift()
    const summary = lines.join('\n')
    return summary.length > SUMMARY_CHARS ? summary.slice(summary.length - SUMMARY_CHARS) : summary
}

function parsePins(raw) {
    try {
        const parsed = JSON.parse(raw || '[]')
        return Array.isArray(parsed) ? parsed.map((pin) => String(pin)) : []
    } catch {
        return []
    }
}

export function readMemory(harnessName, chatId, { scope } = {}) {
    const key = sessionKey(harnessName, chatId)
    const entry = connection(harnessName, { create: false, scope })
    if (!entry) return { summary: '', pins: [] }
    const row = entry.memoryGet.get(key)
    if (!row) return { summary: '', pins: [] }
    return { summary: row.summary || '', pins: parsePins(row.pins) }
}

function refreshMemory(harnessName, chatId, pins, scope) {
    const key = sessionKey(harnessName, chatId)
    const entry = connection(harnessName, { create: true, scope })
    const all = entry.all.all(key)
    const older = all.length > RAW_MESSAGES ? all.slice(0, all.length - RAW_MESSAGES) : []
    const summary = summarizeOlder(older)
    const prior = parsePins(entry.memoryGet.get(key)?.pins)
    entry.memoryPut.run(key, summary, JSON.stringify(mergePins(prior, pins)), new Date().toISOString())
}

export function memoryBlock(memory) {
    const parts = []
    if (memory?.summary) parts.push(memory.summary)
    if (memory?.pins?.length) parts.push(['Pins:', ...memory.pins.map((pin) => `* ${pin}`)].join('\n'))
    return parts.join('\n')
}

// Prompt context is the rolling summary, the pin list, and the last two turns. The sqlite transcript stays on disk.
export function readPromptContext(harnessName, chatId, { scope } = {}) {
    const all = readMessages(harnessName, chatId, undefined, { scope })
    const older = all.length > RAW_MESSAGES ? all.slice(0, -RAW_MESSAGES) : []
    const stored = readMemory(harnessName, chatId, { scope })
    const summary = summarizeOlder(older)
    const memory = { summary, pins: stored.pins }
    const raw = connection(harnessName, { create: false, scope })?.selectionsGet.get(sessionKey(harnessName, chatId))?.selections
    let selections = []
    try {
        if (raw && raw.length <= 16000) selections = JSON.parse(raw)
    } catch {
        /* Older or damaged context is unavailable. */
    }
    return { messages: all.slice(-RAW_MESSAGES), summary, pins: stored.pins, block: memoryBlock(memory), selections }
}

export function appendTurn(harnessName, chatId, question, answer, pins = [], selections, { scope } = {}) {
    const key = writeMessages(
        harnessName,
        chatId,
        [
            ['user', question],
            ['assistant', answer]
        ],
        selections,
        scope
    )
    refreshMemory(harnessName, chatId, [...pinsFromText(question), ...pinsFromText(answer), ...pins], scope)
    return key
}

// Full user prompts for this harness, newest first. The run list stores only a short preview.
export function listUserTurns(harnessName, { limit = 2000 } = {}) {
    const entry = connection(harnessName, { create: false })
    if (!entry) return []
    // 5000 is the most this query will read. CUTTLELY_HARNESS_TURN_SCAN_CAP uses the same ceiling.
    const cap = Number.isFinite(limit) ? Math.min(5000, Math.max(1, Math.floor(limit))) : 2000
    if (!entry.userTurns) {
        entry.userTurns = entry.db.prepare(
            `SELECT m.content AS content, m.created_at AS createdAt, m.id AS id
             FROM messages m
             JOIN sessions s ON s.session_key = m.session_key
             WHERE s.harness_name = ? AND m.role = 'user'
             ORDER BY m.created_at DESC, m.id DESC
             LIMIT ?`
        )
    }
    return entry.userTurns.all(harnessName, cap)
}

export function readMessages(harnessName, chatId, limit, { scope } = {}) {
    const key = sessionKey(harnessName, chatId)
    const entry = connection(harnessName, { create: false, scope })
    if (!entry) return []
    if (limit === undefined) return entry.all.all(key)
    return entry.recent.all(key, limit).reverse()
}

export function sessionExists(harnessName, chatId) {
    return readMessages(harnessName, chatId, 1).length > 0
}
