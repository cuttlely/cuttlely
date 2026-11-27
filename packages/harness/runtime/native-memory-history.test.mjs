import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createTestDatabase, skipReason } from '../../etl/check/pg-source.mjs'
import { database, closeQueueDb } from '../lock.mjs'
import { appendTurn, closeSessions, readPromptContext } from '../session.mjs'
import { configureHarnessPostgres } from '../side-store-postgres.mjs'
import { openNativeRecall } from './native-memory.mjs'

const name = 'warehouse',
    chat = 'shared-string'
const roster = { name, chatflowId: 'canvas', workspaceId: 'workspace', createdAt: '2026-01-01T00:00:00.000Z' }
const person = { via: 'session', tryOwner: 'user:one' }
const key = { via: 'api_key', apiKeyId: 'one' }
function open(caller, extra) {
    return openNativeRecall({ roster, chatId: chat, turnId: randomUUID(), assertCurrent() {}, caller, ...extra })
}
function prompt(turn) {
    return readPromptContext(name, chat, { scope: turn?.receipt?.storeScope, recallScope: turn?.receipt ?? null })
}
const answer = (turn, args) => JSON.parse(turn.execute('session_search', args))
function ticket({
    caller = person,
    payload = {},
    status = 'succeeded',
    createdAt = Date.parse('2026-03-01T12:00:00Z'),
    input = 'Remember lavender invoices.',
    output = 'Original delivered answer.'
} = {}) {
    const id = 'job_' + randomUUID()
    const actor = caller.via === 'session' ? { via: 'session' } : caller
    // Stable fields as written by the released v1.7.15 jobPayload() and finishJob().
    const data = {
        name,
        chatId: chat,
        input,
        workspaceId: roster.workspaceId,
        callerChatflowId: roster.chatflowId,
        expectedHarnessChatflowId: null,
        caller: actor,
        nestedFlowCaller: caller,
        apiKeyId: caller.apiKeyId || null,
        ...payload
    }
    database()
        .prepare('INSERT INTO jobs (id,session_key,status,payload,result,cancel_requested,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)')
        .run(id, name + ':' + chat, status, JSON.stringify(data), JSON.stringify({ text: output }), createdAt, createdAt + 300)
    return id
}
for (const backend of ['sqlite', 'postgres'])
    test(
        'released queue ownership, current prompt summary, selections, pins and search are scoped on ' + backend,
        { skip: backend === 'postgres' && skipReason },
        async (t) => {
            const old = process.env.CUTTLELY_DATA_DIR
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-owned-history-'))
            process.env.CUTTLELY_DATA_DIR = root
            let pg
            if (backend === 'postgres') {
                pg = await createTestDatabase()
                configureHarnessPostgres(pg.connection)
            }
            t.after(async () => {
                closeSessions()
                closeQueueDb()
                configureHarnessPostgres(null)
                await pg?.cleanup()
                fs.rmSync(root, { recursive: true, force: true })
                if (old === undefined) delete process.env.CUTTLELY_DATA_DIR
                else process.env.CUTTLELY_DATA_DIR = old
            })
            const legacy = ticket()
            const keyTicket = ticket({ caller: key, input: 'Private keyed iris receipt.', output: 'Key-owned answer.' })
            for (const options of [
                { caller: { via: 'session' } },
                { caller: { via: 'flow' } },
                { caller: { via: 'session', tryOwner: 'user:other' } },
                { payload: { workspaceId: 'other' } },
                { payload: { expectedHarnessChatflowId: 'foreign' } },
                { payload: { callerChatflowId: 'foreign' } },
                { payload: { caller: { via: 'flow' } } },
                { payload: { name: 'wrong' } },
                { payload: { chatId: 'wrong' } },
                { payload: { engine: 'native' } },
                { status: 'running' },
                { status: 'failed' },
                { createdAt: Date.parse('2020-01-01') }
            ])
                ticket({ ...options, input: 'FOREIGN private data.', output: 'FOREIGN answer.' })
            appendTurn(name, chat, 'Untagged shared legacy transcript.', 'Untagged answer.', ['unknown pin'], [{ id: 'unknown-selection' }])
            const one = open(person),
                api = open(key)
            assert.deepEqual(
                prompt(one).messages.map((m) => m.content),
                ['Remember lavender invoices.', 'Original delivered answer.']
            )
            assert.deepEqual(
                prompt(api).messages.map((m) => m.content),
                ['Private keyed iris receipt.', 'Key-owned answer.']
            )
            assert.deepEqual(prompt(open({ via: 'flow' })).messages, [])
            assert.equal(answer(one, { session_id: legacy }).session_meta.source, 'cuttlely_queue')
            assert.equal(answer(one, { query: 'lavender' }).results[0].session_id, legacy)
            assert.equal(answer(one, { session_id: keyTicket }).success, false)
            assert.equal(answer(one, { query: 'FOREIGN' }).count, 0)
            assert.equal(answer(api, { session_id: legacy }).success, false)
            appendTurn(name, chat, 'Owned new turn', 'Owned reply.', ['private pin'], [{ id: 'owned-selection' }], { recall: one.receipt })
            appendTurn(name, chat, 'Foreign key turn', 'Foreign key reply.', ['key pin'], [{ id: 'key-selection' }], {
                recall: api.receipt
            })
            for (let i = 0; i < 3; i++) {
                const local = open(person)
                appendTurn(name, chat, 'My follow-up ' + i, 'Mine ' + i, [], undefined, { recall: local.receipt })
            }
            closeSessions()
            const ours = prompt(open(person))
            assert.ok(ours.summary.includes('Original delivered answer.'))
            assert.ok(ours.summary.includes('Owned reply.'))
            assert.deepEqual(ours.pins, ['private pin'])
            assert.deepEqual(ours.selections, [{ id: 'owned-selection' }])
            assert.ok(!JSON.stringify(ours).includes('key reply'))
            const theirs = prompt(open(key))
            assert.deepEqual(theirs.pins, ['key pin'])
            assert.deepEqual(theirs.selections, [{ id: 'key-selection' }])
            assert.equal(prompt(open(person, { roster: { ...roster, createdAt: '2026-05-01T00:00:00Z' } })).messages.length, 0)
            const preview = open(person, { roster: { ...roster, tryId: 'try-one', tryOwner: 'user:one' } })
            assert.deepEqual(preview.tools, [])
            assert.equal(prompt(preview).messages.length, 0)
            appendTurn(name, chat, 'Preview turn', 'Draft only', [], undefined, { recall: preview.receipt })
            assert.equal(prompt(open(person, { roster: { ...roster, tryId: 'try-two', tryOwner: 'user:one' } })).messages.length, 0)
            assert.equal(answer(open(person), { query: 'Draft' }).count, 0)

            const longId = ticket({ input: 'Review the cobalt case.', output: 'Long report detail. '.repeat(500) })
            const found = answer(one, { query: 'cobalt', role_filter: 'user' })
            assert.equal(found.count, 1)
            assert.equal(found.results[0].session_id, longId)
            assert.equal(found.results[0].matched_role, 'user')
            const reportPreview = found.results[0].messages.find((m) => m.role === 'assistant')
            assert.ok(reportPreview.content_truncated)
            assert.ok(reportPreview.content.length <= 4001)
            assert.equal(answer(api, { query: 'cobalt', role_filter: 'user' }).count, 0)
            assert.match(answer(one, { query: 'detail', role_filter: 'assistant' }).error, /search budget/)
            assert.match(answer(one, { query: 'cobalt' }).error, /search budget/)
            assert.equal(answer(one, { query: 'lavender', exclude_session_ids: [longId] }).count, 1)
        }
    )
