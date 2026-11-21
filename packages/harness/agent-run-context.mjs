import { database, immediate } from './lock.mjs'
import { publicTask, redactSecrets } from './trace.mjs'

// The roster runs in a child process. Keep its steps with the admitted turn until the parent saves one run.
function ensure(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_turns (
        session_id TEXT PRIMARY KEY,
        profile_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        steps_json TEXT NOT NULL
    )`)
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
    })
}

export function endAgentTurn(profileName, sessionId) {
    const db = database()
    ensure(db)
    db.prepare('DELETE FROM agent_turns WHERE session_id = ? AND profile_name = ?').run(sessionId, profileName)
}
