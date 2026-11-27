import { database } from '../lock.mjs'

// Version 1.7.15 kept the exact accepted input and delivered output on successful queue
// tickets. Read only tickets for which the worker retained the authenticated principal and
// the admitted canvas/workspace. A timestamp or an unowned profile transcript alone is insufficient.
export function legacyRecallRows(receipt, { runtimeId, after, before, limit, contentChars }) {
    const legacy = receipt.legacy
    if (!legacy || (runtimeId !== undefined && !/^job_[0-9a-f-]{36}$/i.test(runtimeId))) return []
    const db = database()
    function field(column, path) {
        // All column and component names are compiler constants. Data stays in bound parameters.
        return db.dialect === 'postgres'
            ? `${column}::jsonb #>> '{${path.join(',')}}'`
            : `json_extract(CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END,'$.${path.join('.')}')`
    }
    const payload = (...path) => field('payload', path)
    const input = payload('input'),
        output = field('result', ['text'])
    const principal = legacy.actor[0] === 'session' ? 'tryOwner' : 'apiKeyId'
    const gates = [
        "status='succeeded'",
        'session_key=?',
        'created_at>=?',
        'updated_at>=created_at',
        payload('engine') + ' IS NULL',
        field('result', ['trace', 'engine']) + ' IS NULL',
        payload('workspaceId') + '=?',
        payload('name') + '=?',
        payload('chatId') + '=?',
        '(' +
            payload('expectedHarnessChatflowId') +
            '=? OR (' +
            payload('expectedHarnessChatflowId') +
            ' IS NULL AND ' +
            payload('callerChatflowId') +
            '=?))',
        payload('caller', 'via') + '=?',
        payload('nestedFlowCaller', 'via') + '=?',
        payload('nestedFlowCaller', principal) + '=?',
        input + ' IS NOT NULL',
        output + ' IS NOT NULL'
    ]
    // Reject non-string inputs/results before selecting any text from a legacy ticket.
    const textField = (column, key) =>
        db.dialect === 'postgres'
            ? `jsonb_typeof(${column}::jsonb -> '${key}')='string'`
            : `json_type(CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END,'$.${key}')='text'`
    gates.push(textField('payload', 'input'), textField('result', 'text'))
    const [kind, id] = legacy.actor
    const args = [
        receipt.sessionKey,
        legacy.generation,
        legacy.workspace,
        legacy.name,
        legacy.chat,
        legacy.canvas,
        legacy.canvas,
        kind,
        kind,
        id
    ]
    if (kind === 'api_key') {
        gates.push(payload('caller', 'apiKeyId') + '=?', '(' + payload('apiKeyId') + ' IS NULL OR ' + payload('apiKeyId') + '=?)')
        args.push(id, id)
    }
    if (runtimeId !== undefined) {
        gates.push('id=?')
        args.push(runtimeId)
    }
    if (after !== undefined) {
        gates.push('created_at>=?')
        args.push(Date.parse(after))
    }
    if (before !== undefined) {
        gates.push('created_at<?')
        args.push(Date.parse(before))
    }
    const rows = db
        .prepare(
            `SELECT id,created_at,updated_at,length(${input}) AS question_chars,length(${output}) AS answer_chars,
        substr(${input},1,?) AS question,substr(${output},1,?) AS answer
        FROM jobs WHERE ${gates.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`
        )
        .all(contentChars, contentChars, ...args, limit)
    return rows.map((row) => ({
        runtime_id: row.id,
        source: 'cuttlely_queue',
        model: null,
        started_at: new Date(Number(row.created_at)).toISOString(),
        created_at: new Date(Number(row.updated_at)).toISOString(),
        question: row.question,
        answer: row.answer,
        // A released queue ticket has two public messages and no stored Hermes message IDs.
        // Its anchor is the position inside that specific ticket, and is always paired with its ID.
        question_id: 1,
        answer_id: 2,
        question_chars: row.question_chars,
        answer_chars: row.answer_chars
    }))
}
