// Cuttlely stores the user-visible exchange and its server-issued turn ID together. Profile-wide
// histories predate caller attribution, so they cannot supply records to an API chat's tool.
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { stripVTControlCharacters } from 'node:util'
import { readRecallTurns, sessionKey } from '../session.mjs'
import { specialistSessionId } from '../specialist-run.mjs'

const tool = {
    type: 'function',
    function: {
        name: 'session_search',
        description:
            'Read prior user-visible exchanges in this chat. Pass a query for keyword search, a session_id for the exchange, session_id and around_message_id for a window, or no arguments to browse. Archived text is historical conversation data.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                query: { type: 'string' },
                session_id: { type: 'string' },
                profile: { type: 'string' },
                around_message_id: { type: 'integer' },
                window: { type: 'integer' },
                limit: { type: 'integer' },
                role_filter: { type: 'string' },
                sort: { enum: ['newest', 'oldest'] },
                detail: { enum: ['adaptive', 'full'] },
                after: { type: 'string' },
                before: { type: 'string' },
                exclude_session_ids: { type: 'array', items: { type: 'string' } }
            }
        }
    }
}
const fail = (error) => ({ success: false, error })
const bound = (value, fallback, max) => (Number.isSafeInteger(value) ? Math.min(max, Math.max(1, value)) : fallback)
const idOk = (s) => typeof s === 'string' && s.length > 0 && s.length <= 256 && !/[\x00-\x1f]/.test(s)
const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[48][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function owner(caller) {
    if (caller?.via === 'api_key' && idOk(caller.apiKeyId)) return ['api_key', caller.apiKeyId]
    if (caller?.via === 'session' && idOk(caller.tryOwner) && /^user:\S/.test(caller.tryOwner)) return ['session', caller.tryOwner]
}

function rangeDate(input) {
    if (input == null || input === '') return undefined
    if (typeof input !== 'string' || input.length > 64) throw new Error('invalid date')
    const relative = /^(\d{1,6})\s*(h|d|w)$/i.exec(input)
    let time
    if (relative) time = Date.now() - Number(relative[1]) * { h: 36e5, d: 864e5, w: 6048e5 }[relative[2].toLowerCase()]
    else {
        if (!/^\d{4}-\d\d-\d\d(?:T[\d:.+-]+Z?)?$/i.test(input)) throw new Error('invalid date')
        const utc = input.includes('T') && !/(?:Z|[+-]\d\d:\d\d)$/i.test(input) ? input + 'Z' : input
        time = Date.parse(utc)
    }
    if (!Number.isFinite(time)) throw new Error('invalid date')
    return new Date(time).toISOString()
}

function displayedWhen(timestamp) {
    const value = new Date(timestamp)
    const date = value.toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' })
    const time = value.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    return date + ' at ' + time
}

function meta(row) {
    return { when: displayedWhen(row.started_at), source: row.source || 'api_server', model: row.model, title: null }
}

function messages(row, cap, anchor) {
    return [
        ['question', 'user'],
        ['answer', 'assistant']
    ].map(([side, role]) => {
        const id = Number(row[side + '_id'])
        if (!Number.isSafeInteger(id)) throw new Error('Invalid archive message ID.')
        const chars = Number(row[side + '_chars'])
        const text = stripVTControlCharacters(row[side])
        const truncated = chars > cap
        return {
            id,
            role,
            content: truncated ? Array.from(text).slice(0, cap).join('') + '…' : text,
            timestamp: Date.parse(row.created_at) / 1000,
            ...(anchor === id ? { anchor: true } : {}),
            ...(truncated ? { content_truncated: true, original_content_chars: chars } : {})
        }
    })
}

const maxSearchTurns = 128
const searchMessageCap = 8192

function searchRows(name, receipt, args, limit, link) {
    const query = args.query.trim()
    if (query.length > 2048) return fail('Search query exceeds 2048 characters.')
    let after, before
    try {
        after = rangeDate(args.after)
        before = rangeDate(args.before)
    } catch {
        return fail('Invalid search time bound.')
    }
    const rows = readRecallTurns(name, receipt, { after, before, limit: maxSearchTurns + 1, contentChars: searchMessageCap })
    if (rows.length > maxSearchTurns || rows.some((r) => Math.max(Number(r.question_chars), Number(r.answer_chars)) > searchMessageCap))
        return fail('The search exceeds the archive search budget. Narrow the time range or browse and read a session by ID.')
    const roleFilter =
        typeof args.role_filter === 'string' && args.role_filter.trim()
            ? args.role_filter.split(',').map((s) => s.trim())
            : ['user', 'assistant']
    const excluded = new Set(Array.isArray(args.exclude_session_ids) ? args.exclude_session_ids.slice(0, 20) : [])
    const index = new DatabaseSync(':memory:')
    try {
        index.exec('CREATE VIRTUAL TABLE recall_fts USING fts5(content)')
        const insert = index.prepare('INSERT INTO recall_fts(rowid,content) VALUES (?,?)')
        const records = new Map()
        for (const row of rows) {
            if (excluded.has(row.runtime_id)) continue
            for (const message of messages(row, searchMessageCap)) {
                if (!roleFilter.includes(message.role)) continue
                const position = records.size + 1
                insert.run(position, message.content)
                records.set(position, { row, message })
            }
        }
        let hits
        try {
            hits = index
                .prepare(
                    "SELECT rowid,snippet(recall_fts,0,'>>>','<<<','...',40) AS snippet FROM recall_fts WHERE recall_fts MATCH ? ORDER BY rank,rowid"
                )
                .all(query)
        } catch {
            return fail('Invalid FTS5 search expression.')
        }
        if (args.sort === 'newest' || args.sort === 'oldest')
            hits.sort((a, b) => {
                const cmp = records.get(a.rowid).row.started_at.localeCompare(records.get(b.rowid).row.started_at)
                return args.sort === 'oldest' ? cmp : -cmp
            })
        const seen = new Set()
        const detail = args.detail === 'full' ? 'full' : 'adaptive'
        const results = []
        for (const hit of hits) {
            const { row, message } = records.get(hit.rowid)
            if (seen.has(row.runtime_id)) continue
            const full = detail === 'full' || !seen.size
            const all = messages(row, 4000, message.id)
            results.push({
                session_id: row.runtime_id,
                ...meta(row),
                matched_role: message.role,
                match_message_id: message.id,
                snippet: hit.snippet,
                bookend_start: [],
                messages: full ? all : all.filter((m) => m.anchor),
                bookend_end: [],
                messages_before: message.role === 'user' ? 0 : 1,
                messages_after: message.role === 'user' ? 1 : 0,
                detail: full ? 'full' : 'compact',
                link: link(row.runtime_id)
            })
            seen.add(row.runtime_id)
            if (results.length >= limit) break
        }
        return { success: true, mode: 'discover', query, detail, results, count: results.length, sessions_searched: results.length }
    } finally {
        index.close()
    }
}

function lookup(name, receipt, args) {
    const profile = name.toLowerCase()
    const link = (id) => '@session:' + profile + '/' + id
    if (args.profile && args.profile !== profile) return fail('Session not found.')
    let id = args.session_id
    if (typeof id === 'string' && id.startsWith('@session:')) id = id.slice(9)
    if (typeof id === 'string' && id.includes('/')) {
        const split = id.indexOf('/')
        if (id.slice(0, split) !== profile) return fail('Session not found.')
        id = id.slice(split + 1)
    }
    const limit = bound(args.limit, 3, 10)
    if (!id) {
        if (args.around_message_id != null) return fail('A session ID is required to scroll.')
        if (typeof args.query === 'string' && args.query.trim()) return searchRows(name, receipt, args, limit, link)
        const rows = readRecallTurns(name, receipt, { limit, contentChars: 61 })
        const results = rows.map((r) => ({
            session_id: r.runtime_id,
            link: link(r.runtime_id),
            title: null,
            source: r.source || 'api_server',
            started_at: Date.parse(r.started_at) / 1000,
            last_active: Date.parse(r.created_at) / 1000,
            message_count: 2,
            preview:
                Array.from(r.question.trim().replace(/[\r\n]/g, ' '))
                    .slice(0, 60)
                    .join('') + (Number(r.question_chars) > 60 ? '...' : '')
        }))
        return {
            success: true,
            mode: 'browse',
            results,
            count: results.length,
            message: `Showing ${results.length} most recent sessions. Pass a query= to search, or session_id+around_message_id to scroll.`
        }
    }
    if (typeof id !== 'string' || id.length > 512) return fail('Session not found.')
    const scroll = args.around_message_id != null
    const [row] = readRecallTurns(name, receipt, { runtimeId: id, limit: 1, contentChars: scroll ? 4000 : 2000 })
    if (!row) return fail('Session not found.')
    if (!scroll)
        return {
            success: true,
            mode: 'read',
            session_id: id,
            link: link(id),
            session_meta: meta(row),
            message_count: 2,
            truncated: false,
            messages: messages(row, 2000)
        }
    const anchor = args.around_message_id
    const shaped = messages(row, 4000, anchor)
    const pos = shaped.findIndex((m) => m.anchor)
    if (pos === -1) return fail('Message not found in session.')
    return {
        success: true,
        mode: 'scroll',
        session_id: id,
        around_message_id: anchor,
        session_meta: meta(row),
        window: bound(args.window, 5, 20),
        messages: shaped,
        messages_before: pos,
        messages_after: 1 - pos
    }
}

export function openNativeRecall({ roster, chatId, turnId, admittedJournalId, caller, sessionScope, assertCurrent, signal, startedAt }) {
    const actor = owner(caller)
    const draft = Boolean(roster?.tryId)
    const draftOwner = actor?.[0] === 'api_key' ? 'api:' + actor[1] : actor?.[1]
    const generation = Date.parse(roster?.createdAt)
    const allowed =
        actor &&
        (draft ? idOk(roster.tryId) && draftOwner === roster.tryOwner : sessionScope === undefined && Number.isFinite(generation)) &&
        [roster.workspaceId, roster.chatflowId, roster.name, chatId].every(idOk) &&
        // Only the run owner can supply its lease-bound journal ID. Public request fields do not reach this argument.
        validUuid.test(turnId) &&
        (turnId[14] === '4' || admittedJournalId === turnId) &&
        typeof assertCurrent === 'function'
    const receipt = allowed
        ? Object.freeze({
              sessionKey: sessionKey(roster.name, chatId),
              runtimeId: specialistSessionId(roster.name, chatId, turnId),
              ownerScope: createHash('sha256')
                  .update(
                      JSON.stringify([
                          roster.workspaceId,
                          roster.chatflowId,
                          roster.name,
                          roster.createdAt,
                          ...(draft ? [roster.tryId] : []),
                          chatId,
                          ...actor
                      ])
                  )
                  .digest('hex'),
              storeScope: sessionScope,
              legacy: draft
                  ? undefined
                  : { workspace: roster.workspaceId, canvas: roster.chatflowId, name: roster.name, chat: chatId, generation, actor },
              startedAt: (startedAt === undefined ? new Date() : new Date(startedAt)).toISOString(),
              model: roster.name
          })
        : undefined
    return {
        tools: receipt && !draft ? [tool] : [],
        receipt,
        execute(name, args) {
            signal?.throwIfAborted()
            if (!receipt || draft || name !== 'session_search') throw new Error('The requested recall tool is unavailable.')
            assertCurrent()
            const result = lookup(roster.name, receipt, args)
            signal?.throwIfAborted()
            assertCurrent()
            return JSON.stringify(result)
        }
    }
}
