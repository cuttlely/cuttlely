// The server's schedule tick, end to end on a real schedule store: the tick claims a due time, checks the owner,
// starts the run through the harness service's startBackgroundRun, and audits it. A deleted harness starts nothing.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, beforeEach, describe, it } from 'node:test'

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
        assert.equal(calls[0].opts.apiKeyId, null)
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
})
