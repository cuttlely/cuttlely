// A canvas draft try and a public harness run both finish in startRun. The draft try compiles
// its own roster and must still store that run's tokens once, not again on top of the public path.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

const root = path.join(import.meta.dirname, '..')
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
const LIVE = '{"nodes":[{"id":"live"}],"edges":[]}'
const DRAFT = '{"nodes":[{"id":"draft"}],"edges":[]}'
const stubDir = path.join(root, 'packages', 'server', 'src', 'services', 'harnesses', 'harness')
const logFile = path.join(tmpdir(), `harness-draft-usage-${process.pid}.log`)
process.env.CUTTLELY_HARNESS_STUB_LOG = logFile

const { writeFile, mkdir } = await import('node:fs/promises')

await rm(stubDir, { recursive: true, force: true })
await mkdir(stubDir, { recursive: true })
await writeFile(logFile, '')

const note = `import { appendFileSync } from 'node:fs'
export function note(row) { appendFileSync(process.env.CUTTLELY_HARNESS_STUB_LOG, JSON.stringify(row) + '\\n') }
`
await writeFile(path.join(stubDir, 'note.mjs'), note)
await writeFile(
    path.join(stubDir, 'store.mjs'),
    `export function getHarness(name) {
  return { name, workspaceId: ${JSON.stringify(WORKSPACE)}, chatflowId: '22222222-2222-4222-8222-222222222222' }
}
`
)
await writeFile(
    path.join(stubDir, 'gateway.mjs'),
    `export async function startGateway() {}
export function holdGatewayHealth() { return () => {} }
`
)
await writeFile(
    path.join(stubDir, 'history.mjs'),
    `export function listRuns() { return [] }
export function getRun() { return null }
export function chatBelongsToOtherCaller() { return false }
`
)
await writeFile(
    path.join(stubDir, 'sync-from-flow.mjs'),
    `import { note } from './note.mjs'
export function rosterFromFlow(input) {
  note({ kind: 'roster', flowData: input.flowData, name: input.name })
  return { name: input.name, workspaceId: input.workspaceId, chatflowId: input.chatflowId, agents: [{ id: 'draft-specialist' }] }
}
`
)
await writeFile(
    path.join(stubDir, 'run.mjs'),
    `import { note } from './note.mjs'
const payload = {
  text: 'baked',
  harnessPayload: { trace: { route: { model: 'gpt-4.1-mini', tokens: { prompt: 20, completion: 8 } } } }
}
async function finish(kind, opts) {
  note({ kind, hasRecord: !!opts.record, tryId: opts.record && opts.record.tryId })
  if (typeof opts.onRecorded === 'function') opts.onRecorded({ id: 'run-1', chatId: opts.chatId })
  return payload
}
export function configureHarnessRuntime() {}
export function warmHarnessProfiles() {}
export function runHarness(opts) { return finish('inline', opts) }
export function runQueuedHarness(opts) { return finish('queued', opts) }
`
)

const { DataSource } = serverRequire('typeorm')
const { AddTokenUsageDay1791900000000: SqliteMigration } = serverRequire(
    './src/database/migrations/sqlite/1791900000000-AddTokenUsageDay.ts'
)
const { queryTokenUsage } = serverRequire('./src/services/usage/index.ts')
const drafts = serverRequire('./src/services/flow-drafts/index.ts')
drafts.default.flowDataForTestChat = async () => DRAFT
const harnesses = serverRequire('./src/services/harnesses/index.ts').default
const appMod = serverRequire('./src/utils/getRunningExpressApp.ts')

const dirs = []
after(async () => {
    await rm(stubDir, { recursive: true, force: true })
    await rm(logFile, { force: true })
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function openSqlite() {
    const dir = await mkdtemp(path.join(tmpdir(), 'cuttlely-harness-draft-'))
    dirs.push(dir)
    const dataSource = new DataSource({
        type: 'sqlite',
        database: path.join(dir, 'database.sqlite'),
        synchronize: false,
        migrations: [SqliteMigration]
    })
    await dataSource.initialize()
    await dataSource.runMigrations()
    dataSource.getRepository = () => ({ findOneBy: async () => null })
    return dataSource
}

async function totals(dataSource) {
    const report = await queryTokenUsage(dataSource, {
        workspaceId: WORKSPACE,
        startDate: '2020-01-01',
        endDate: '2099-01-01',
        flowId: 'bakery-team'
    })
    return report.totals
}

async function settle(dataSource, input, output) {
    for (let i = 0; i < 30; i += 1) {
        const row = await totals(dataSource)
        if (row.inputTokens === input && row.outputTokens === output) return row
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return totals(dataSource)
}

async function calls() {
    const text = await readFile(logFile, 'utf8')
    return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
}

describe('harness draft try usage', () => {
    it('stores a public run and a canvas draft try once each', async () => {
        const dataSource = await openSqlite()
        appMod.getRunningExpressApp = () => ({
            AppDataSource: dataSource,
            nodesPool: { componentNodes: {} },
            cachePool: {}
        })

        const chatflow = {
            id: '22222222-2222-4222-8222-222222222222',
            name: 'bakery-team',
            type: 'HARNESS',
            flowData: LIVE,
            workspaceId: WORKSPACE
        }

        await harnesses.startRun(
            'bakery-team',
            { question: 'How many loaves?' },
            { source: 'api', workspaceId: WORKSPACE, caller: { via: 'session' } }
        )
        const afterPublic = await settle(dataSource, 20, 8)
        assert.deepEqual(afterPublic, { inputTokens: 20, outputTokens: 8 })

        const outcome = await harnesses.startCanvasRun(
            chatflow,
            { question: 'Try the draft' },
            { source: 'playground', caller: { via: 'session' } }
        )
        assert.equal(outcome.payload.text, 'baked')
        const afterDraft = await settle(dataSource, 40, 16)
        assert.deepEqual(afterDraft, { inputTokens: 40, outputTokens: 16 })

        const seen = await calls()
        const queued = seen.filter((row) => row.kind === 'queued')
        const inline = seen.filter((row) => row.kind === 'inline')
        const rosters = seen.filter((row) => row.kind === 'roster')
        assert.equal(queued.length, 1)
        assert.equal(queued[0].hasRecord, false)
        assert.equal(inline.length, 1)
        assert.equal(inline[0].hasRecord, true)
        assert.equal(typeof inline[0].tryId, 'string')
        assert.equal(inline[0].tryId.length, 16)
        assert.equal(rosters.length, 1)
        assert.equal(rosters[0].flowData, DRAFT)
        assert.equal(rosters[0].name, 'bakery-team')
    })
})
