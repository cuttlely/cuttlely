import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { closeQueueDb, acquireTurn, releaseTurn, acquireTryProfileTurn, releaseTryProfileTurn, queueDbPath } from '../../harness/lock.mjs'
import { configureHarnessPostgres } from '../../harness/side-store-postgres.mjs'
import { appendTurn, closeSessions, draftSessionScope, readMessages, removeDraftSessions } from '../../harness/session.mjs'
import { getSchedule, saveSchedule } from '../../harness/schedule.mjs'
import { copyHarnessSnapshot, snapshotSqlite } from '../migrate-postgres.mjs'

export async function checkHarnessUpgrade(source, config) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-upgrade-'))
    const name = 'team'
    const canvas = { workspaceId: 'w', chatflowId: 'canvas' }
    const scope = draftSessionScope(canvas)
    process.env.CUTTLELY_DATA_DIR = path.join(root, 'old')
    try {
        appendTurn(name, 'chat', 'question', 'answer')
        appendTurn(name, 'chat', 'draft question', 'draft answer', [], [], { scope })
        const schedule = saveSchedule(
            name,
            { cron: '* * * * *', question: 'test', timezone: 'UTC' },
            { workspaceId: 'w', ownerId: 'owner' }
        )
        for (const [id, file] of [
            ['queue', queueDbPath()],
            ['profile:team', path.join(root, 'old/hermes/profiles/team/sessions.sqlite')],
            ['draft:' + scope, path.join(root, 'old/harness-draft-sessions', scope, 'sessions.sqlite')]
        ]) {
            const snapshot = await snapshotSqlite(file, root)
            const report = await copyHarnessSnapshot(source, snapshot, id)
            assert.deepEqual(await copyHarnessSnapshot(source, snapshot, id), report)
        }
        closeQueueDb()
        closeSessions()
        process.env.CUTTLELY_DATA_DIR = path.join(root, 'fresh')
        configureHarnessPostgres(config)
        assert.deepEqual(getSchedule(name), schedule)
        assert.equal(readMessages(name, 'chat').at(-1).content, 'answer')
        assert.equal(readMessages(name, 'chat', undefined, { scope }).at(-1).content, 'draft answer')
        const held = acquireTurn(name, 'chat')
        const trial = await acquireTryProfileTurn('canvas')
        // A second OS process uses the same database from another empty data mount.
        const child = fork(new URL('./harness-upgrade-worker.mjs', import.meta.url), [], {
            execArgv: [],
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            env: { ...process.env, CUTTLELY_DATA_DIR: path.join(root, 'worker') }
        })
        const done = once(child, 'exit')
        child.send({ config })
        const [code] = await done
        assert.equal(code, 0)
        releaseTryProfileTurn(trial)
        releaseTurn(held)
        assert.equal(readMessages(name, 'chat').at(-1).content, 'worker answer')
        removeDraftSessions(canvas)
        assert.equal(readMessages(name, 'chat', undefined, { scope }).length, 0)
        assert.equal(readMessages(name, 'chat').length, 4)
        assert.ok(!fs.existsSync(queueDbPath()))
    } finally {
        closeQueueDb()
        closeSessions()
        configureHarnessPostgres(null)
        fs.rmSync(root, { recursive: true, force: true })
    }
}
