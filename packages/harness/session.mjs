import { legacyRecallRows } from './runtime/native-memory-legacy.mjs'
import { publishedSessionScope } from './session-scope.mjs'
import { assertStorageReady } from './side-store-maintenance.mjs'
import { dropDraftPostgres, harnessUsesPostgres, openHarnessPostgres } from './side-store-postgres.mjs'
import { SESSION_SCHEMA } from './side-store-schema.mjs'
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
    assertStorageReady()
    const postgres = harnessUsesPostgres()
    const diskPath = dbPath(harnessName, scope, postgres ? false : create)
    const identity = postgres && scope === undefined ? publishedSessionScope(harnessName) : 'draft:' + scope
    const file = postgres ? identity : diskPath
    const cached = connections.get(file)
    if (cached) {
        if (postgres || fs.existsSync(file)) return cached
        closeConnection(file)
    }
    if (!postgres && !create && !fs.existsSync(file)) return null
    if (!postgres) fs.mkdirSync(path.dirname(file), { recursive: true })
    const db = postgres ? openHarnessPostgres(identity) : new DatabaseSync(file)
    if (!postgres)
        db.exec(`PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        ${SESSION_SCHEMA}`)
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
            `SELECT m.content AS content, m.created_at AS "createdAt", m.id AS id
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
    assertStorageReady()
    const scope = draftSessionScope(canvas)
    if (harnessUsesPostgres()) {
        closeConnection('draft:' + scope)
        dropDraftPostgres(scope)
        return
    }
    const file = dbPath('', scope, false)
    closeConnection(file)
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
}

// The model never supplies the workspace identity or the expected revision. A single commit
// publishes all completed specialist workspaces together with the visible chat turn.
export function readManagedWorkspace(harnessName, scope, scopeKey) {
    const entry = connection(harnessName, { create: false, scope })
    return entry?.db.prepare('SELECT revision,manifest FROM managed_file_workspaces WHERE scope_key=?').get(scopeKey)
}

function storeManagedWorkspaces(entry, changes) {
    if (!changes) return
    for (const { scopeKey, manifest, revision } of changes || []) {
        const args = [scopeKey, JSON.stringify(manifest), revision]
        const result =
            revision === 0
                ? entry.db
                      .prepare(
                          'INSERT INTO managed_file_workspaces(scope_key,manifest,revision) VALUES(?,?,1) ON CONFLICT(scope_key) DO NOTHING'
                      )
                      .run(...args.slice(0, 2))
                : entry.db
                      .prepare('UPDATE managed_file_workspaces SET manifest=?,revision=revision+1 WHERE scope_key=? AND revision=?')
                      .run(args[1], args[0], revision)
        if (Number(result.changes) !== 1)
            throw new HarnessError(
                'workspace_changed',
                'The specialist workspace changed during this turn. Retry to read the current files.',
                409
            )
    }
    const total = entry.db.prepare('SELECT count(*) AS count,coalesce(sum(length(manifest)),0) AS bytes FROM managed_file_workspaces').get()
    if (Number(total.count) > 1024 || Number(total.bytes) > 512 * 1024 * 1024)
        throw new HarnessError('file_limit', 'The team has reached its managed workspace storage limit.')
}

function writeMessages(harnessName, chatId, messages, selections, scope, recall, pins = [], managedWorkspaces) {
    const key = sessionKey(harnessName, chatId)
    const entry = connection(harnessName, { create: true, scope })
    const now = new Date().toISOString()
    entry.db.exec('BEGIN')
    try {
        entry.ensure.run(key, harnessName, chatId, now)
        storeManagedWorkspaces(entry, managedWorkspaces)
        if (recall) {
            if (recall.sessionKey !== key || recall.storeScope !== scope || messages.length !== 2)
                throw new HarnessError('bad_session', 'Invalid recall turn.')
            const insert = entry.db.prepare(
                'INSERT INTO messages (session_key, role, content, created_at) VALUES (?, ?, ?, ?) RETURNING id'
            )
            const ids = messages.map(([role, content]) => insert.get(key, role, content, now).id)
            entry.db
                .prepare(
                    'INSERT INTO recall_turns (runtime_id,owner_scope,session_key,question_id,answer_id,model,started_at) VALUES (?,?,?,?,?,?,?)'
                )
                .run(recall.runtimeId, recall.ownerScope, key, ...ids, recall.model, recall.startedAt)
        } else {
            for (const [role, content] of messages) entry.insert.run(key, role, content, now)
        }
        if (selections?.length) entry.selectionsPut.run(key, JSON.stringify(selections))
        if (recall) {
            // A separate key without a colon cannot collide with an ordinary harness:chat session.
            const privateKey = 'recall_' + recall.ownerScope
            if (selections?.length) entry.selectionsPut.run(privateKey, JSON.stringify(selections))
            const prior = parsePins(entry.memoryGet.get(privateKey)?.pins)
            entry.memoryPut.run(privateKey, '', JSON.stringify(mergePins(prior, pins)), now)
        }
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
// Even an empty standalone message renders ": ", and each pair renders "Q:  A: ".
// Keep an extra pair so a clipped boundary cannot change the part of the summary that fits.
const CONTEXT_MESSAGES = RAW_MESSAGES + Math.ceil(SUMMARY_CHARS / 2) + 2
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
    let remaining = SUMMARY_CHARS
    let i = messages.length - 1
    while (i >= 0) {
        const current = messages[i]
        let line
        if (current.role === 'assistant' && messages[i - 1]?.role === 'user') {
            line = `Q: ${oneLine(messages[i - 1].content, 120)} A: ${oneLine(current.content, 160)}`
            i--
        } else {
            line = `${current.role}: ${oneLine(current.content, 120)}`
        }
        if (line.length > remaining) {
            if (!lines.length) lines.push(line.slice(-SUMMARY_CHARS))
            break
        }
        lines.push(line)
        remaining -= line.length + 1
        i--
    }
    return { summary: lines.reverse().join('\n'), full: i >= 0 }
}

// Each query returns one complete snapshot, including the raw tail. Short messages
// can fit many turns in the summary, so expand only while older lines might fit.
function recentContext(entry, key) {
    if (!entry) return { messages: [], summary: '' }
    for (let limit = 32; ; limit = Math.min(CONTEXT_MESSAGES, limit * 4)) {
        const rows = entry.recent.all(key, limit).reverse()
        const older = rows.slice(0, -RAW_MESSAGES)
        // A page can begin halfway through a question/answer pair. Skip an initial
        // assistant message while its preceding question might be outside this page.
        const more = rows.length === limit && limit < CONTEXT_MESSAGES
        const { summary, full } = summarizeOlder(more && older[0]?.role === 'assistant' ? older.slice(1) : older)
        if (full || !more) return { messages: rows.slice(-RAW_MESSAGES), summary }
    }
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
    const { summary } = recentContext(entry, key)
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
function scopedPromptContext(name, receipt) {
    const empty = { messages: [], summary: '', pins: [], block: '', selections: [] }
    if (!receipt) return empty
    // Even two empty lines render at least seven characters with the Q/A markers. A
    // bounded candidate set covers the complete summary budget plus the raw tail.
    const limit = Math.ceil(SUMMARY_CHARS / 7) + RAW_TURNS
    const previewChars = 512
    const turns = readRecallTurns(name, receipt, { limit, contentChars: previewChars }).reverse()
    if (!turns.length) return empty
    const userAndAnswer = (t) => [
        { role: 'user', content: t.question, created_at: t.created_at },
        { role: 'assistant', content: t.answer, created_at: t.created_at }
    ]
    const older = turns.slice(0, -RAW_TURNS).flatMap(userAndAnswer)
    // Use SQL's character counts: substr and length agree even for astral characters and SQLite text containing NUL.
    const complete = (t) => Number(t.question_chars) <= previewChars && Number(t.answer_chars) <= previewChars
    const recent = turns.slice(-RAW_TURNS).flatMap((t) => {
        if (complete(t)) return userAndAnswer(t)
        const [row] = readRecallTurns(name, receipt, { runtimeId: t.runtime_id, limit: 1, contentChars: 1024 * 1024 })
        if (!row) return []
        // A single oversized archived turn must not enlarge the provider context without bound.
        for (const side of ['question', 'answer']) if (Number(row[side + '_chars']) > 1024 * 1024) row[side] += '…'
        return userAndAnswer(row)
    })
    const entry = connection(name, { create: false, scope: receipt.storeScope })
    const privateKey = 'recall_' + receipt.ownerScope
    const legacyPins = turns
        .filter((t) => t.source === 'cuttlely_queue' && complete(t))
        .flatMap((t) => [...pinsFromText(t.question), ...pinsFromText(t.answer)])
    const pins = mergePins(legacyPins, parsePins(entry?.memoryGet.get(privateKey)?.pins))
    const { summary } = summarizeOlder(older)
    const raw = entry?.selectionsGet.get(privateKey)?.selections
    let selections = []
    try {
        if (raw && raw.length <= 16000) selections = JSON.parse(raw)
    } catch {
        /* Ignore an unreadable optional selection. */
    }
    return { messages: recent, summary, pins, block: memoryBlock({ summary, pins }), selections }
}

export function readPromptContext(harnessName, chatId, { scope, recallScope } = {}) {
    if (recallScope !== undefined) {
        if (recallScope && (recallScope.sessionKey !== sessionKey(harnessName, chatId) || recallScope.storeScope !== scope))
            throw new HarnessError('bad_session', 'Invalid recall scope.')
        return scopedPromptContext(harnessName, recallScope)
    }

    const key = sessionKey(harnessName, chatId)
    const entry = connection(harnessName, { create: false, scope })
    const { messages, summary } = recentContext(entry, key)
    const stored = readMemory(harnessName, chatId, { scope })
    const memory = { summary, pins: stored.pins }
    const raw = connection(harnessName, { create: false, scope })?.selectionsGet.get(key)?.selections
    let selections = []
    try {
        if (raw && raw.length <= 16000) selections = JSON.parse(raw)
    } catch {
        /* Older or damaged context is unavailable. */
    }
    return { messages, summary, pins: stored.pins, block: memoryBlock(memory), selections }
}

export function appendTurn(harnessName, chatId, question, answer, pins = [], selections, { scope, recall, managedWorkspaces } = {}) {
    const incoming = [...pinsFromText(question), ...pinsFromText(answer), ...pins]
    const key = writeMessages(
        harnessName,
        chatId,
        [
            ['user', question],
            ['assistant', answer]
        ],
        selections,
        scope,
        recall,
        incoming,
        managedWorkspaces
    )
    refreshMemory(harnessName, chatId, incoming, scope)
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
            `SELECT m.content AS content, m.created_at AS "createdAt", m.id AS id
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

// Each row is linked to the two public messages written in the same transaction. Historical rows
// without a receipt, roles from another session, and unowned chats are never candidates.
export function readRecallTurns(name, receipt, { runtimeId, after, before, limit, contentChars }) {
    const legacy = legacyRecallRows(receipt, { runtimeId, after, before, limit, contentChars })
    const db = connection(name, { create: false, scope: receipt.storeScope })?.db
    if (!db || (runtimeId && legacy.length)) return legacy
    const conditions = ['r.owner_scope = ?', 'r.session_key = ?', 'r.runtime_id <> ?']
    const params = [receipt.ownerScope, receipt.sessionKey, receipt.runtimeId]
    for (const [test, value] of [
        ['r.runtime_id = ?', runtimeId],
        ['r.started_at >= ?', after],
        ['r.started_at < ?', before]
    ]) {
        if (value !== undefined) {
            conditions.push(test)
            params.push(value)
        }
    }
    const attested = db
        .prepare(
            `SELECT r.runtime_id,r.started_at,r.model,q.id AS question_id,a.id AS answer_id,
                         length(q.content) AS question_chars,length(a.content) AS answer_chars,
                         substr(q.content,1,?) AS question,substr(a.content,1,?) AS answer,a.created_at
                      FROM recall_turns r
                      JOIN messages q ON q.id=r.question_id AND q.session_key=r.session_key AND q.role='user'
                      JOIN messages a ON a.id=r.answer_id AND a.session_key=r.session_key AND a.role='assistant'
                      WHERE ${conditions.join(' AND ')} ORDER BY r.started_at DESC,r.runtime_id DESC LIMIT ?`
        )
        .all(contentChars, contentChars, ...params, limit)
    return [...attested, ...legacy]
        .sort((a, b) => b.started_at.localeCompare(a.started_at) || b.runtime_id.localeCompare(a.runtime_id))
        .slice(0, limit)
}
