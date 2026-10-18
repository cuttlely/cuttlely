// The server's schedule tick, end to end on a real schedule store: the tick claims a due time, checks the owner,
// starts the run through the harness service's startBackgroundRun, and audits it. A deleted harness starts nothing.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, beforeEach, describe, it } from 'node:test'

// The server logger handles uncaught errors without exiting (exitOnError: false). A failure while this file loads, such
// as a package that is not built, would end it with code 0 and no case run, and node --test would count that as a pass.
let ran = 0
process.on('uncaughtException', (error) => {
    process.exitCode = 1
    console.error(error)
})
process.on('exit', () => {
    if (ran > 0) return
    process.exitCode = 1
    console.error('harness-schedule-tick ran no tests')
})

const root = path.join(import.meta.dirname, '..')
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cuttlely-schedule-tick-'))
process.env.CUTTLELY_DATA_DIR = dataDir

const serverRequire = createRequire(path.join(root, 'packages', 'server', 'package.json'))
serverRequire('ts-node').register({
    transpileOnly: true,
    skipProject: true,
    compilerOptions: {
        module: 'commonjs',
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        strict: false,
        skipLibCheck: true,
        target: 'ES2022'
    }
})

const WORKSPACE = '11111111-1111-4111-8111-111111111111'
const audits = []

const appMod = serverRequire('./src/utils/getRunningExpressApp.ts')
appMod.getRunningExpressApp = () => ({
    AppDataSource: { getRepository: () => ({ findOneBy: async () => ({ id: WORKSPACE, organizationId: 'org-1' }) }) },
    nodesPool: { componentNodes: {} },
    cachePool: {}
})
serverRequire('./src/identity/production.ts').applicationSql = () => ({})
serverRequire('./src/identity/auditLog.ts').safeRecordAudit = async (_sql, event) => {
    audits.push(event)
}
const rbac = serverRequire('./src/identity/rbac.ts')
rbac.setTeamPermissionLookup({ accessFor: async () => ({ owner: false, permissions: ['chatflows:view', 'chatflows:create'] }) })

const servicesIndex = serverRequire('./src/services/harnesses/index.ts')
// The real harness modules, never a test double another script left under services/harnesses/harness.
servicesIndex.loadHarness = (file) => import(pathToFileURL(path.join(root, 'packages', 'harness', file)).href)
const harnesses = servicesIndex.default
const realStartBackgroundRun = harnesses.startBackgroundRun
const ticks = serverRequire('./src/services/harnesses/schedules.ts')
const schedules = await import(pathToFileURL(path.join(root, 'packages', 'harness', 'schedule.mjs')).href)
const history = await import(pathToFileURL(path.join(root, 'packages', 'harness', 'history.mjs')).href)

after(async () => {
    rbac.setTeamPermissionLookup(null)
    harnesses.startBackgroundRun = realStartBackgroundRun
    ;(await import(pathToFileURL(path.join(root, 'packages', 'harness', 'lock.mjs')).href)).closeQueueDb()
    await rm(dataDir, { recursive: true, force: true })
})

function saveDue(name) {
    const saved = schedules.saveSchedule(
        name,
        { cron: '* * * * *', timezone: 'UTC', question: 'Summarise yesterday’s orders.' },
        { workspaceId: WORKSPACE, ownerId: 'user-1', now: new Date(Date.now() - 120000) }
    )
    assert.ok(Date.parse(saved.nextRunAt) <= Date.now())
    return saved
}

describe('the server schedule tick', () => {
    beforeEach(() => {
        ran += 1
        audits.length = 0
        harnesses.startBackgroundRun = realStartBackgroundRun
    })

    it('starts a due schedule through startBackgroundRun as a schedule run, and audits it with the run id', async () => {
        saveDue('bakery-team')
        const calls = []
        harnesses.startBackgroundRun = async (name, body, opts) => {
            calls.push({ name, body, opts })
            const queued = history.queueHarnessRun({ name, chatId: 'schedule-1', source: opts.source, input: body.question })
            return { runId: queued.id, harness: name, chatId: 'schedule-1', status: 'queued' }
        }
        const outcomes = await ticks.tickHarnessSchedules()
        const started = outcomes.find((row) => row.harness === 'bakery-team')
        assert.equal(started?.result, 'running')
        assert.equal(calls.length, 1)
        assert.equal(calls[0].name, 'bakery-team')
        assert.deepEqual(calls[0].body, { question: 'Summarise yesterday’s orders.' })
        assert.equal(calls[0].opts.workspaceId, WORKSPACE)
        assert.equal(calls[0].opts.source, 'schedule')
        assert.deepEqual(calls[0].opts.caller, { via: 'session' })
        assert.equal(typeof calls[0].opts.track, 'function')
        assert.equal(typeof calls[0].opts.onSettled, 'function')
        const runStarted = audits.find((event) => event.detail?.action === 'run_started')
        assert.equal(runStarted?.type, 'harness_schedule')
        assert.equal(runStarted?.detail?.runId, started.runId)
        assert.equal(runStarted?.userId, 'user-1')
        const stored = schedules.getSchedule('bakery-team')
        assert.equal(stored.lastRunId, started.runId)
        assert.equal(stored.lastResult, 'running')
        assert.ok(Date.parse(stored.nextRunAt) > Date.now())
        const again = await ticks.tickHarnessSchedules()
        assert.equal(calls.length, 1, 'the same due time does not start a second run')
        assert.ok(!again.some((row) => row.harness === 'bakery-team'))
        schedules.deleteSchedule('bakery-team')
    })

    it('starts nothing for a schedule whose harness was deleted, and records why', async () => {
        saveDue('deleted-team')
        const outcomes = await ticks.tickHarnessSchedules()
        const row = outcomes.find((item) => item.harness === 'deleted-team')
        assert.equal(row?.result, 'failed')
        assert.match(row?.reason || '', /not found/i)
        assert.equal(history.listRuns('deleted-team').length, 0)
        assert.ok(!audits.some((event) => event.detail?.action === 'run_started'))
        assert.equal(schedules.getSchedule('deleted-team').lastResult, 'failed')
        schedules.deleteSchedule('deleted-team')
    })

    it('shows an API key the owner name only and the question redacted, and a redacted save keeps the question', async () => {
        await mkdir(path.join(dataDir, 'harnesses'), { recursive: true })
        await writeFile(
            path.join(dataDir, 'harnesses', 'view-team.json'),
            JSON.stringify({ name: 'view-team', workspaceId: WORKSPACE, chief: { model: { nodeName: 'chatOpenAI' } }, specialists: [] })
        )
        const secret = 'postgres://bakery:s3cret-pass@db.example/orders'
        const question = `Compare the orders in ${secret} with last week.`
        schedules.saveSchedule('view-team', { cron: '0 7 * * *', timezone: 'UTC', question }, { workspaceId: WORKSPACE, ownerId: 'user-1' })
        const viaKey = (await harnesses.getHarnessSchedule('view-team', WORKSPACE, { apiKeyCaller: true })).schedule
        assert.deepEqual(Object.keys(viaKey.owner), ['name'])
        assert.ok(!('ownerId' in viaKey) && !('workspaceId' in viaKey))
        assert.ok(!viaKey.question.includes('s3cret-pass'), viaKey.question)
        const person = (await harnesses.getHarnessSchedule('view-team', WORKSPACE)).schedule
        assert.equal(person.owner.id, 'user-1')
        assert.ok(!person.question.includes('s3cret-pass'))
        await harnesses.saveHarnessSchedule(
            'view-team',
            { cron: '0 8 * * *', timezone: 'UTC', question: person.question },
            { workspaceId: WORKSPACE, ownerId: 'user-2' }
        )
        assert.equal(schedules.getSchedule('view-team').question, question)
        assert.equal(schedules.getSchedule('view-team').cron, '0 8 * * *')
        schedules.deleteSchedule('view-team')
    })

    it('starts nothing while the server is shutting down', async () => {
        saveDue('quiet-team')
        let called = 0
        harnesses.startBackgroundRun = async () => {
            called += 1
            return { runId: 'run_00000000-0000-4000-8000-000000000001' }
        }
        const runs = serverRequire('./src/settings/runs.ts')
        const draining = runs.drainRuns(0)
        await draining
        try {
            assert.deepEqual(await ticks.tickHarnessSchedules(), [])
            assert.equal(called, 0)
            assert.ok(Date.parse(schedules.getSchedule('quiet-team').nextRunAt) <= Date.now(), 'the due time stays due')
        } finally {
            runs.resetRuns()
            schedules.deleteSchedule('quiet-team')
        }
    })

    it('stops starting due schedules once a drain begins partway through one tick, and leaves the rest due', async () => {
        saveDue('first-team')
        saveDue('second-team')
        const runs = serverRequire('./src/settings/runs.ts')
        const startedNames = []
        harnesses.startBackgroundRun = async (name, body, opts) => {
            startedNames.push(name)
            await runs.drainRuns(0)
            const queued = history.queueHarnessRun({ name, chatId: `schedule-${name}`, source: opts.source, input: body.question })
            return { runId: queued.id, harness: name, chatId: `schedule-${name}`, status: 'queued' }
        }
        try {
            const outcomes = await ticks.tickHarnessSchedules()
            assert.equal(startedNames.length, 1)
            assert.equal(outcomes.length, 1)
            const left = startedNames[0] === 'first-team' ? 'second-team' : 'first-team'
            assert.ok(Date.parse(schedules.getSchedule(left).nextRunAt) <= Date.now(), 'the schedule not reached stays due')
            assert.equal(schedules.getSchedule(left).lastResult, null)
        } finally {
            runs.resetRuns()
            schedules.deleteSchedule('first-team')
            schedules.deleteSchedule('second-team')
        }
    })

    it('counts a background run as in progress before its first await, so a drain that begins then waits for it', async () => {
        const runs = serverRequire('./src/settings/runs.ts')
        try {
            const pending = realStartBackgroundRun(
                'missing-team',
                { question: 'q' },
                { workspaceId: WORKSPACE, source: 'schedule', caller: { via: 'session' }, track: runs.trackBackgroundRun }
            )
            assert.equal(runs.runsInProgress(), 1, 'tracked in the same turn as the call')
            const order = []
            const drained = runs.drainRuns(5000, 5).then((left) => {
                order.push('drained')
                return left
            })
            await assert.rejects(pending.finally(() => order.push('settled')))
            assert.equal(await drained, 0)
            assert.deepEqual(order, ['settled', 'drained'])
        } finally {
            runs.resetRuns()
        }
    })

    it('stops the scheduler when a drain begins, as a restart does', async () => {
        const runs = serverRequire('./src/settings/runs.ts')
        try {
            ticks.startHarnessScheduler(60000)
            assert.equal(ticks.harnessSchedulerRunning(), true)
            await runs.drainRuns(0)
            assert.equal(ticks.harnessSchedulerRunning(), false)
        } finally {
            ticks.stopHarnessScheduler()
            runs.resetRuns()
        }
    })

    it('shows a due time still starting after a minute as failed, and a fresh one as starting', async () => {
        await mkdir(path.join(dataDir, 'harnesses'), { recursive: true })
        await writeFile(
            path.join(dataDir, 'harnesses', 'stuck-team.json'),
            JSON.stringify({ name: 'stuck-team', workspaceId: WORKSPACE, chief: { model: { nodeName: 'chatOpenAI' } }, specialists: [] })
        )
        const due = saveDue('stuck-team')
        const claimedAt = new Date(Date.now() - 90000)
        assert.ok(schedules.claimSchedule('stuck-team', { dueAt: due.nextRunAt, next: Date.now() + 3600000, now: claimedAt }))
        assert.equal(schedules.getSchedule('stuck-team').lastResult, 'starting')
        const stuck = (await harnesses.getHarnessSchedule('stuck-team', WORKSPACE)).schedule
        assert.equal(stuck.lastResult, 'failed')
        assert.match(stuck.lastReason, /did not start/)
        const fresh = await servicesIndex.presentSchedule({ ...schedules.getSchedule('stuck-team'), updatedAt: new Date().toISOString() })
        assert.equal(fresh.schedule.lastResult, 'starting')
        schedules.deleteSchedule('stuck-team')
    })

    it('keeps a harness and its schedule when the schedule cannot be removed, then deletes both and its key grants', async () => {
        await mkdir(path.join(dataDir, 'harnesses'), { recursive: true })
        const file = path.join(dataDir, 'harnesses', 'gone-team.json')
        await writeFile(
            file,
            JSON.stringify({ name: 'gone-team', workspaceId: WORKSPACE, chief: { model: { nodeName: 'chatOpenAI' } }, specialists: [] })
        )
        schedules.saveSchedule(
            'gone-team',
            { cron: '0 7 * * *', timezone: 'UTC', question: 'q' },
            { workspaceId: WORKSPACE, ownerId: 'user-1' }
        )
        const keyRows = [{ id: 'key-1', workspaceId: WORKSPACE, harnesses: ['gone-team', 'kept-team'] }]
        const dataSourceMod = serverRequire('./src/DataSource.ts')
        const realGetDataSource = dataSourceMod.getDataSource
        const realRemoveSchedule = servicesIndex.harnessDeleteHooks.removeSchedule
        dataSourceMod.getDataSource = () => ({
            transaction: async (work) =>
                work({
                    getRepository: () => ({
                        findBy: async () => keyRows.map((row) => ({ ...row })),
                        save: async (row) => {
                            keyRows.splice(0, 1, row)
                            return row
                        }
                    })
                })
        })
        try {
            servicesIndex.harnessDeleteHooks.removeSchedule = async () => {
                throw new Error('made-up schedule failure')
            }
            await assert.rejects(
                () => harnesses.deleteHarness('gone-team', WORKSPACE),
                (error) => error.statusCode === 500 && /schedule could not be removed/.test(error.message)
            )
            assert.ok(schedules.getSchedule('gone-team'), 'the schedule stays with the harness')
            assert.ok((await import('node:fs')).existsSync(file), 'the harness file stays')
            // Key lists are cleaned first, so the grants are already gone; ticking the harness again restores them.
            assert.deepEqual(keyRows[0].harnesses, ['kept-team'])
            servicesIndex.harnessDeleteHooks.removeSchedule = realRemoveSchedule
            assert.deepEqual(await harnesses.deleteHarness('gone-team', WORKSPACE), { name: 'gone-team', deleted: true })
            assert.equal(schedules.getSchedule('gone-team'), null)
            assert.equal((await import('node:fs')).existsSync(file), false)
            assert.deepEqual(keyRows[0].harnesses, ['kept-team'])
        } finally {
            servicesIndex.harnessDeleteHooks.removeSchedule = realRemoveSchedule
            dataSourceMod.getDataSource = realGetDataSource
        }
    })

    it('makes the person who resumes a schedule its owner', async () => {
        await mkdir(path.join(dataDir, 'harnesses'), { recursive: true })
        await writeFile(
            path.join(dataDir, 'harnesses', 'resume-team.json'),
            JSON.stringify({ name: 'resume-team', workspaceId: WORKSPACE, chief: { model: { nodeName: 'chatOpenAI' } }, specialists: [] })
        )
        schedules.saveSchedule(
            'resume-team',
            { cron: '0 7 * * *', timezone: 'UTC', question: 'q' },
            { workspaceId: WORKSPACE, ownerId: 'user-1' }
        )
        await harnesses.setHarnessScheduleStatus('resume-team', 'paused', WORKSPACE)
        assert.equal(schedules.getSchedule('resume-team').ownerId, 'user-1')
        await harnesses.setHarnessScheduleStatus('resume-team', 'active', WORKSPACE, { ownerId: 'user-2' })
        assert.equal(schedules.getSchedule('resume-team').ownerId, 'user-2')
        schedules.deleteSchedule('resume-team')
    })
})
