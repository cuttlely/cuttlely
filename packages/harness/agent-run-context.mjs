import { sessionKey } from './session.mjs'
import { journalSession, journalTeam, matchesJournalTurn } from './roster-journal.mjs'
import { AGENT_SCHEMA } from './side-store-schema.mjs'
import { database, immediate } from './lock.mjs'
import { publicTask, redactSecrets } from './trace.mjs'

// The roster runs in a child process. Keep its steps with the admitted turn until the parent saves one run.
function ensure(db) {
    if (db.dialect === 'postgres') return
    db.exec(AGENT_SCHEMA)
}

export function beginAgentTurn(profileName, sessionId, chatId, turnId) {
    immediate((db) => {
        ensure(db)
        db.prepare('INSERT INTO agent_turns VALUES (?, ?, ?, ?, ?)').run(sessionId, profileName, chatId, turnId, '[]')
    })
}

export function agentTurn(profileName, sessionId) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 4096) return null
    const db = database()
    ensure(db)
    const row = db.prepare('SELECT * FROM agent_turns WHERE session_id = ? AND profile_name = ?').get(sessionId, profileName)
    return row ? { chatId: row.chat_id, turnId: row.turn_id, steps: JSON.parse(row.steps_json) } : null
}

// Return the stable journal slot so parallel delegations update their own admission record.
export function recordAgentStep(profileName, sessionId, step, slot) {
    return immediate((db) => {
        ensure(db)
        const turn = agentTurn(profileName, sessionId)
        return writeStep(db, turn, profileName, sessionId, step, slot)
    })
}

function writeStep(db, turn, profileName, sessionId, step, slot) {
    if (!turn) return
    if (slot === undefined) {
        if (turn.steps.length >= 160) return
        slot = turn.steps.length
    } else if (!Number.isInteger(slot) || slot < 0 || slot >= turn.steps.length) return
    const tokens = step.usage
    turn.steps[slot] = {
        name: step.name,
        task: publicTask(redactSecrets(step.task)),
        status: step.status,
        ...(step.model ? { model: step.model } : {}),
        ...(step.fallback ? { fallback: step.fallback } : {}),
        ...(step.tools?.length ? { tools: step.tools } : {}),
        startedAt: step.startedAt,
        ms: Math.max(0, Date.now() - step.startedAt),
        ...(step.error ? { error: redactSecrets(step.error).slice(0, 1000) } : {}),
        ...(tokens
            ? {
                  tokens: {
                      prompt: Number(tokens.prompt_tokens ?? tokens.input_tokens) || 0,
                      completion: Number(tokens.completion_tokens ?? tokens.output_tokens) || 0
                  }
              }
            : {})
    }
    db.prepare('UPDATE agent_turns SET steps_json = ? WHERE session_id = ? AND profile_name = ?').run(
        JSON.stringify(turn.steps),
        sessionId,
        profileName
    )
    return slot
}

export function endAgentTurn(profileName, sessionId) {
    const db = database()
    ensure(db)
    db.prepare('DELETE FROM agent_turns WHERE session_id = ? AND profile_name = ?').run(sessionId, profileName)
}

// This endpoint journals the existing roster subprocess. It never invokes a model, specialist or tool.
export function updateBundledJournal(meta, current, body) {
    function deny() {
        throw Object.assign(new Error('The agent turn is no longer active.'), { statusCode: 403 })
    }
    if (
        meta.role !== 'chief' ||
        meta.tryProfile ||
        !journalTeam(current) ||
        current.name !== meta.harnessName ||
        !journalSession(body?.sessionId) ||
        !current.specialists.some((role) => role.name === body.name)
    )
        deny()
    const opening = body.phase === 'begin'
    const fields = opening
        ? ['sessionId', 'name', 'phase', 'task']
        : ['sessionId', 'name', 'phase', 'slot', 'status', 'prompt', 'completion']
    if (Object.keys(body).some((k) => !fields.includes(k)) || (!opening && body.phase !== 'end')) deny()
    if (opening && (typeof body.task !== 'string' || !body.task.trim() || body.task !== publicTask(redactSecrets(body.task)))) deny()
    if (
        !opening &&
        (!['completed', 'failed', 'cancelled'].includes(body.status) ||
            !Number.isInteger(body.slot) ||
            ![body.prompt, body.completion].every((n) => Number.isSafeInteger(n) && n >= 0))
    )
        deny()
    return immediate((db) => {
        if (db.dialect !== 'postgres') deny()
        const turn = agentTurn(meta.harnessName, body.sessionId)
        if (!turn) deny()
        const lease = db
            .prepare('SELECT owner FROM turns WHERE session_key = ? AND expires_at > ? FOR UPDATE')
            .get(sessionKey(current.name, turn.chatId), Date.now())
        if (!matchesJournalTurn(lease?.owner, current, turn.chatId, turn.turnId, body.sessionId)) deny()
        const existing = turn.steps[body.slot]
        if (!opening && (existing?.name !== body.name || existing.status !== 'running')) deny()
        const step = opening
            ? { name: body.name, task: body.task, status: 'running', startedAt: Date.now() }
            : { ...existing, status: body.status, usage: { prompt_tokens: body.prompt, completion_tokens: body.completion } }
        const slot = writeStep(db, turn, current.name, body.sessionId, step, opening ? undefined : body.slot)
        if (slot === undefined) deny()
        return opening ? { chatId: turn.chatId, turnId: turn.turnId, slot } : { recorded: true }
    })
}
