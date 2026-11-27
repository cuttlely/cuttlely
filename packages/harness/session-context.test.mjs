import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createTestDatabase, skipReason } from '../etl/check/pg-source.mjs'
import { appendTurn, closeSessions, draftSessionScope, readMemory, readMessages, readPromptContext } from './session.mjs'
import { harnessSchema } from './side-store-identity.mjs'
import { configureHarnessPostgres } from './side-store-postgres.mjs'

const scope = draftSessionScope({ workspaceId: 'test-workspace', chatflowId: 'test-canvas' })
const name = 'long-session'
const date = '2026-01-02T03:04:05.000Z'
const clean = (rows) => rows.map(({ role, content }) => [role, content])

// Compute the expected transcript summary chronologically, independent of the reader's fetch order.
function referenceSummary(messages) {
    function clip(text, length) {
        const value = text.replace(/\s+/g, ' ').trim()
        return value.length > length ? value.slice(0, length) + '...' : value
    }
    const older = messages.slice(0, -4)
    const lines = []
    for (let i = 0; i < older.length; i++) {
        const [role, text] = older[i]
        if (role === 'user' && older[i + 1]?.[0] === 'assistant') {
            lines.push('Q: ' + clip(text, 120) + ' A: ' + clip(older[++i][1], 160))
        } else {
            lines.push(role + ': ' + clip(text, 120))
        }
    }
    let remaining = lines.join('\n').length
    let start = 0
    while (remaining > 1600 && start < lines.length - 1) remaining -= lines[start++].length + 1
    return lines.slice(start).join('\n').slice(-1600)
}

function restoredHistories() {
    const roles = ['assistant', 'user', 'assistant', 'tool', 'user', 'user', 'system', '']
    const mixed = Array.from({ length: 4094 }, (_, i) => [roles[i % roles.length], i + '\n  ' + 'text 🌿  '.repeat(i % 4 === 0 ? 31 : 4)])
    const short = Array.from({ length: 1024 }, () => ['', ''])
    // A DESC page starts on an assistant whose user message may be just outside that page.
    for (const page of [32, 128, 512]) {
        short[short.length - page - 1] = ['user', 'q' + page]
        short[short.length - page] = ['assistant', 'a' + page]
    }
    const longRole = [['system', 'older'], ['exported-'.repeat(245), 'oversized role'], ...Array.from({ length: 4 }, () => ['', ''])]
    return { mixed, short, longRole }
}

async function restoreTranscript({ pg, root, chat, history }) {
    const key = name + ':' + chat
    if (pg) {
        const { Client } = createRequire(new URL('../server/package.json', import.meta.url))('pg')
        const client = new Client(pg.connection)
        try {
            await client.connect()
            const table = harnessSchema('draft:' + scope) + '.messages'
            await client.query(
                `INSERT INTO ${table}(session_key,role,content,created_at)
                 SELECT $1, pair->>0, pair->>1, $3 FROM jsonb_array_elements($2::jsonb)
                 WITH ORDINALITY AS input(pair, position) ORDER BY position`,
                [key, JSON.stringify(history), date]
            )
        } finally {
            await client.end()
        }
        return
    }
    const db = new DatabaseSync(path.join(root, 'harness-draft-sessions', scope, 'sessions.sqlite'))
    try {
        db.exec('BEGIN')
        const insert = db.prepare('INSERT INTO messages(session_key,role,content,created_at) VALUES(?,?,?,?)')
        for (const [role, text] of history) insert.run(key, role, text, date)
        db.exec('COMMIT')
    } finally {
        db.close()
    }
}

for (const backend of ['sqlite', 'postgres']) {
    test(
        backend + ' retains the full restored transcript while supplying a bounded prompt and durable pins',
        { skip: backend === 'postgres' && skipReason },
        async () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-session-context-'))
            const oldRoot = process.env.CUTTLELY_DATA_DIR
            process.env.CUTTLELY_DATA_DIR = root
            let pg
            try {
                if (backend === 'postgres') {
                    pg = await createTestDatabase()
                    configureHarnessPostgres(pg.connection)
                }
                for (const [chat, history] of Object.entries(restoredHistories())) {
                    const priorPins = Array.from({ length: 8 }, (_, i) => 'saved-' + i)
                    appendTurn(name, chat, 'first question', 'first answer', priorPins, undefined, { scope })
                    const expected = [['user', 'first question'], ['assistant', 'first answer'], ...history]
                    await restoreTranscript({ pg, root, chat, history })
                    closeSessions()
                    const before = readPromptContext(name, chat, { scope })
                    assert.deepEqual(clean(before.messages), expected.slice(-4))
                    assert.equal(before.summary, referenceSummary(expected))
                    assert.deepEqual(before.pins, priorPins)
                    assert.deepEqual(readMemory(name, chat, { scope }), { summary: '', pins: priorPins })

                    const question = 'continuation\npin: saved-2',
                        answer = 'complete\npin: newest'
                    const selections = [{ label: 'example' }]
                    appendTurn(name, chat, question, answer, [], selections, { scope })
                    expected.push(['user', question], ['assistant', answer])
                    closeSessions()
                    const pins = ['saved-1', 'saved-3', 'saved-4', 'saved-5', 'saved-6', 'saved-7', 'saved-2', 'newest']
                    const summary = referenceSummary(expected)
                    const context = readPromptContext(name, chat, { scope })
                    assert.deepEqual(clean(context.messages), expected.slice(-4))
                    assert.equal(context.summary, summary)
                    assert.deepEqual(context.pins, pins)
                    assert.equal(context.block, [summary, 'Pins:', ...pins.map((p) => '* ' + p)].filter(Boolean).join('\n'))
                    assert.deepEqual(context.selections, selections)
                    assert.deepEqual(readMemory(name, chat, { scope }), { summary, pins })
                    const transcript = readMessages(name, chat, undefined, { scope })
                    assert.deepEqual(clean(transcript), expected)
                    assert.ok(transcript.slice(2, -2).every((m) => m.created_at === date))
                    assert.deepEqual(readMessages(name, chat, 7, { scope }), transcript.slice(-7))
                }
                assert.deepEqual(readMessages(name, 'no-chat', undefined, { scope }), [])
            } finally {
                closeSessions()
                configureHarnessPostgres(undefined)
                if (oldRoot === undefined) delete process.env.CUTTLELY_DATA_DIR
                else process.env.CUTTLELY_DATA_DIR = oldRoot
                fs.rmSync(root, { recursive: true, force: true })
                await pg?.cleanup()
            }
        }
    )
}
