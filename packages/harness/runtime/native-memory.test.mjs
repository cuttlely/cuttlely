import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createTestDatabase, createTestSource, skipReason } from '../../etl/check/pg-source.mjs'
import { snapshotSqlite, copyHarnessSnapshot } from '../../etl/migrate-postgres.mjs'
import { publishedSessionScope } from '../session-scope.mjs'
import { harnessSchema } from '../side-store-identity.mjs'
import { DatabaseSync } from 'node:sqlite'
import { appendTurn, closeSessions, readMessages } from '../session.mjs'
import { configureHarnessPostgres } from '../side-store-postgres.mjs'
import { openNativeRecall } from './native-memory.mjs'

const roster = {
    createdAt: '2026-01-20T12:00:00.000Z',
    name: 'research',
    workspaceId: 'qa-workspace',
    chatflowId: 'research-canvas',
    chief: { model: { modelName: 'simulated-model' } }
}
const caller = { via: 'session', tryOwner: 'user:person-a' }
const chatId = 'one-chat'
const open = (options) => openNativeRecall({ roster, chatId, turnId: randomUUID(), caller, assertCurrent: () => {}, ...options })
const ask = (turn, args) => JSON.parse(turn.execute('session_search', args))
const save = (recall, question, answer) => appendTurn(roster.name, chatId, question, answer, [], undefined, { recall: recall.receipt })
function freshRoot(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-recall-'))
    process.env.CUTTLELY_DATA_DIR = dir
    t.after(() => {
        closeSessions()
        fs.rmSync(dir, { force: true, recursive: true })
        delete process.env.CUTTLELY_DATA_DIR
    })
    return dir
}

for (const backend of ['sqlite', 'postgres']) {
    test(
        'native session recall proves ownership, persists both messages atomically and survives restart on ' + backend,
        { skip: backend === 'postgres' && skipReason },
        async (t) => {
            const dir = freshRoot(t)
            if (backend === 'postgres') {
                const db = await createTestDatabase()
                configureHarnessPostgres(db.connection)
                t.after(async () => {
                    closeSessions()
                    configureHarnessPostgres(null)
                    await db.cleanup()
                })
            }
            const first = open({ startedAt: '2024-01-02T03:04:05Z' })
            save(first, 'Remember the green turnip receipt.', 'It was delivered.')
            assert.equal(ask(first, {}).count, 0)
            assert.throws(() => save(first, 'duplicate secret', 'duplicate secret'))
            assert.equal(readMessages(roster.name, chatId).length, 2)
            appendTurn(roster.name, chatId, 'legacy unowned input', 'legacy unowned output')
            const otherPerson = open({ caller: { via: 'session', tryOwner: 'user:person-b' } })
            save(otherPerson, 'foreign tomato secret', 'foreign tomato result')
            const otherKey = open({ caller: { via: 'api_key', apiKeyId: 'a-key' } })
            save(otherKey, 'foreign pumpkin secret', 'other api result')
            const otherCanvas = open({ roster: { ...roster, chatflowId: 'other-canvas' } })
            save(otherCanvas, 'foreign canvas secret', 'other canvas result')
            closeSessions()
            if (backend === 'postgres') {
                fs.rmSync(dir, { force: true, recursive: true })
                fs.mkdirSync(dir)
            }
            const rd = open({})
            const list = ask(rd, {})
            assert.equal(list.count, 1)
            const hit = list.results[0]
            assert.equal(hit.session_id, first.receipt.runtimeId)
            const read = ask(rd, { session_id: hit.link })
            assert.equal(read.message_count, 2)
            assert.deepEqual(
                read.messages.map((m) => m.content),
                ['Remember the green turnip receipt.', 'It was delivered.']
            )
            for (const args of [
                { query: 'foreign' },
                { query: 'legacy' },
                { query: 'turnip', role_filter: 'assistant' },
                { query: 'turnip', after: '2025-01-01' },
                { query: 'turnip', exclude_session_ids: [hit.session_id] }
            ]) {
                assert.equal(ask(rd, args).count, 0)
            }
            for (const args of [
                { session_id: otherPerson.receipt.runtimeId },
                { session_id: hit.session_id, profile: 'other' },
                { session_id: '@session:other/' + hit.session_id },
                { session_id: hit.session_id, around_message_id: 99321 }
            ])
                assert.equal(ask(rd, args).success, false)
            const found = ask(rd, { query: '"green turnip" OR pumpkin', role_filter: 'user' })
            assert.equal(found.count, 1)
            assert.equal(found.results[0].messages[0].anchor, true)
            const scroll = ask(rd, { session_id: hit.session_id, around_message_id: found.results[0].match_message_id })
            assert.equal(scroll.mode, 'scroll')
            assert.deepEqual(
                scroll.messages.map((m) => m.role),
                ['user', 'assistant']
            )
            assert.equal(ask(open({ chatId: 'different' }), { session_id: hit.session_id }).success, false)
            assert.equal(ask(open({ roster: { ...roster, workspaceId: 'other-workspace' } }), {}).count, 0)
        }
    )
}

test('anonymous flows, missing principals, previews, cancellation and revoked canvases fail closed', (t) => {
    freshRoot(t)
    for (const options of [
        { caller: { via: 'flow' } },
        { caller: { via: 'session' } },
        { caller: { via: 'api_key', apiKeyId: '' } },
        { sessionScope: 'try' },
        { roster: { ...roster, tryId: 'preview' } },
        { turnId: 'not a server uuid' }
    ]) {
        const disabled = open(options)
        assert.deepEqual(disabled.tools, [])
        assert.equal(disabled.receipt, undefined)
        assert.throws(() => ask(disabled, {}))
    }
    const controller = new AbortController()
    const cancelled = open({ signal: controller.signal })
    controller.abort()
    assert.throws(() => ask(cancelled, {}), { name: 'AbortError' })
    const revoked = open({
        assertCurrent() {
            throw new Error('revoked')
        }
    })
    assert.throws(() => ask(revoked, {}), /revoked/)
})

test('browse, read, scroll and discovery of an owned user exchange match released session-search projections', (t) => {
    const timezone = process.env.TZ
    process.env.TZ = 'UTC'
    t.after(() => {
        if (timezone === undefined) delete process.env.TZ
        else process.env.TZ = timezone
    })
    const root = new URL('../../../hermes/', import.meta.url)
    const executable = process.env.HERMES_PYTHON || fileURLToPath(new URL('.venv/bin/python', root))
    if (!fs.existsSync(executable)) return t.skip('released runtime oracle requires its Python environment')
    const dir = freshRoot(t)
    const first = open({})
    save(first, 'Check the quarterly receipt.', 'Accepted.')
    const rd = open({})
    const browse = ask(rd, {})
    const reference = browse.results[0]
    const read = ask(rd, { session_id: reference.session_id })
    const scroll = ask(rd, { session_id: reference.session_id, around_message_id: read.messages[0].id })
    const discover = ask(rd, { query: 'quarterly' })
    const oracle = spawnSync(
        executable,
        [
            '-c',
            `
import json, os, sys
from pathlib import Path
from hermes_state import SessionDB
from tools.session_search_tool import _list_recent_sessions, _read_session, _scroll, _discover
data=json.load(sys.stdin)
sid,profile,source,start,model=data['id'],data['profile'],'api_server',data['time'],data['model']
db=SessionDB(Path(os.environ['HERMES_HOME'])/'state.db')
try:
    db.create_session(sid,source,model=model)
    db._conn.execute('UPDATE sessions SET started_at=? WHERE id=?',(start,sid))
    for item in data['messages']:
        db.append_message(sid,item['role'],item['content'],timestamp=item['timestamp'])
    ref=[_list_recent_sessions(db,3,link_profile=profile), _read_session(db,sid,link_profile=profile),
         _scroll(db,sid,1,5), _discover(db,'quarterly',None,3,None,'adaptive',link_profile=profile)]
    print(json.dumps([json.loads(x) for x in ref]))
finally: db.close()
`
        ],
        {
            cwd: fileURLToPath(root),
            env: { ...process.env, HERMES_HOME: dir, DATABASE_TYPE: 'sqlite' },
            input: JSON.stringify({
                id: reference.session_id,
                profile: roster.name,
                time: reference.started_at,
                model: read.session_meta.model,
                messages: read.messages
            }),
            encoding: 'utf8',
            timeout: 30000
        }
    )
    assert.equal(oracle.status, 0, oracle.stderr)
    const [rb, rr, rs, rdsc] = JSON.parse(oracle.stdout)
    assert.deepEqual(browse, rb)
    assert.deepEqual(read, rr)
    assert.deepEqual(scroll.messages, rs.messages)
    assert.equal(scroll.messages_before, rs.messages_before)
    assert.equal(scroll.messages_after, rs.messages_after)
    assert.deepEqual(discover.results, rdsc.results)
})

test('cutover copies verified receipts and can resume an older migration with no receipts', { skip: skipReason }, async (t) => {
    const dir = freshRoot(t)
    const db = await createTestSource()
    t.after(async () => {
        closeSessions()
        configureHarnessPostgres(null)
        await db.cleanup()
    })
    const sourceFile = path.join(dir, 'hermes', 'profiles', roster.name.toLowerCase(), 'sessions.sqlite')
    const scope = publishedSessionScope(roster.name)
    appendTurn(roster.name, chatId, 'legacy no owner', 'legacy answer')
    closeSessions()
    // Use the preceding release's source layout and stored report shape to exercise resume.
    const sqlite = new DatabaseSync(sourceFile)
    sqlite.exec('DROP TABLE recall_turns; DROP TABLE IF EXISTS managed_file_workspaces')
    sqlite.close()
    const old = await snapshotSqlite(sourceFile, dir)
    const legacyScope = 'profile:pre-receipts'
    const before = await copyHarnessSnapshot(db, old, legacyScope)
    delete before.managed_file_workspaces
    delete before.recall_turns
    await db.query('UPDATE ' + harnessSchema(legacyScope) + '.storage_migration SET report=$1', [JSON.stringify(before)])
    assert.deepEqual(await copyHarnessSnapshot(db, old, legacyScope), before)
    const one = open({})
    save(one, 'new signed exchange', 'recovered answer')
    closeSessions()
    const snapshot = await snapshotSqlite(sourceFile, dir)
    const report = await copyHarnessSnapshot(db, snapshot, scope)
    assert.equal(report.recall_turns.count, 1)
    assert.deepEqual(await copyHarnessSnapshot(db, snapshot, scope), report)
    await assert.rejects(copyHarnessSnapshot(db, snapshot, legacyScope), /migration verification failed/)
    fs.rmSync(dir, { force: true, recursive: true })
    fs.mkdirSync(dir)
    configureHarnessPostgres(db.connection)
    const result = ask(open({}), { session_id: one.receipt.runtimeId })
    assert.equal(result.messages[1].content, 'recovered answer')
    assert.equal(ask(open({}), { query: 'legacy' }).count, 0)
})
