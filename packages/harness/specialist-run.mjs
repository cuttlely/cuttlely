import crypto from 'node:crypto'

// Each turn is its own Hermes session, so a specialist does not replay every earlier turn of the chat. The chat
// part before the turn mark still scopes the analyst page cursor, so "show more" keeps working across turns.
export const TURN_MARK = '#turn-'

export function specialistSessionId(profileName, chat, turnId = crypto.randomUUID()) {
    return `${profileName}:${chat}${TURN_MARK}${turnId}`
}

export function sessionChat(sessionId) {
    const text = String(sessionId ?? '')
    const mark = text.lastIndexOf(TURN_MARK)
    return mark === -1 ? text : text.slice(0, mark)
}

// The run Harness Prime starts with run_specialist. The specialist's instructions are already in its Hermes
// profile (SOUL.md), so the run carries only the task; sending them again would put them in the prompt twice.
export function rosterSpecialistBody(specialist, task, turnId) {
    return {
        input: String(task ?? ''),
        session_id: specialistSessionId(specialist.profileName, 'tool', turnId),
        provider: 'custom',
        model: specialist.profileName
    }
}
