// An external queue worker writes the history row in its own process, so onRecorded does not
// run here. The span still gets that saved run id. An inline run keeps the id recorded here.
import assert from 'node:assert/strict'
import { rm, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
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
const CHAT = 'chat-ext'
const EXTERNAL = 'run_cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const INLINE = 'run_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const newerRuns = Array.from({ length: 21 }, (_, index) => ({
    id: `run_dddddddd-dddd-4ddd-8ddd-${String(index).padStart(12, '0')}`,
    chatId: `other-${index}`
}))
const stubDir = path.join(root, 'packages', 'server', 'src', 'services', 'harnesses', 'harness')

await rm(stubDir, { recursive: true, force: true })
await mkdir(stubDir, { recursive: true })
await writeFile(
    path.join(stubDir, 'store.mjs'),
    `export function getHarness(name) {
  return { name, workspaceId: ${JSON.stringify(WORKSPACE)}, chatflowId: '22222222-2222-4222-8222-222222222222' }
}
`
)
await writeFile(
    path.join(stubDir, 'gateway.mjs'),
    'export async function startGateway() {}\nexport function holdGatewayHealth() { return () => {} }\n'
)
await writeFile(
    path.join(stubDir, 'history.mjs'),
    `export function listRuns() {
  return ${JSON.stringify(newerRuns)}
}
export function chatBelongsToOtherCaller() {
  return false
}
`
)
await writeFile(
    path.join(stubDir, 'run.mjs'),
    `export function assertHarnessWorkspace() {}
export function configureHarnessRuntime() {}
export function warmHarnessProfiles() {}
export async function runHarness(opts) {
  if (typeof opts.onRecorded === 'function') opts.onRecorded({ id: ${JSON.stringify(INLINE)}, chatId: opts.chatId })
  return { text: 'baked' }
}
export async function runQueuedHarness(opts) {
  const external = process.env.CUTTLELY_HARNESS_QUEUE === 'external'
  const fail = process.env.CUTTLELY_HARNESS_STUB_FAIL === '1'
  if (!external && typeof opts.onRecorded === 'function') {
    opts.onRecorded({ id: ${JSON.stringify(INLINE)}, chatId: opts.chatId })
  }
  if (fail) {
    const error = new Error('oven failed')
    if (external) error.runId = ${JSON.stringify(EXTERNAL)}
    throw error
  }
  if (external) return { text: 'baked', runId: ${JSON.stringify(EXTERNAL)} }
  return { text: 'baked', runId: ${JSON.stringify(EXTERNAL)} }
}
`
)

process.env.CUTTLELY_OTEL_TRACES = 'true'
delete process.env.CUTTLELY_OTEL_TRACES_CONTENT

const tracing = serverRequire('./src/metrics/tracing.ts')
const memory = tracing.installInMemoryTraces()
const appMod = serverRequire('./src/utils/getRunningExpressApp.ts')
appMod.getRunningExpressApp = () => ({
    AppDataSource: { getRepository: () => ({ findOneBy: async () => null }) },
    nodesPool: { componentNodes: {} },
    cachePool: {}
})
const harnesses = serverRequire('./src/services/harnesses/index.ts').default

after(async () => {
    await rm(stubDir, { recursive: true, force: true })
    delete process.env.CUTTLELY_OTEL_TRACES
    delete process.env.CUTTLELY_HARNESS_QUEUE
    delete process.env.CUTTLELY_HARNESS_STUB_FAIL
})

function rootSpan() {
    return memory.spans().find((span) => span.name === 'harness.run')
}

describe('harness queue run id on the trace', () => {
    it('an external queue run keeps its saved id when newer runs fill the history list', async () => {
        process.env.CUTTLELY_HARNESS_QUEUE = 'external'
        delete process.env.CUTTLELY_HARNESS_STUB_FAIL
        memory.reset()
        const outcome = await harnesses.startRun(
            'bakery',
            { question: 'How many loaves?', chatId: CHAT },
            { source: 'api', workspaceId: WORKSPACE, caller: { via: 'session' } }
        )
        assert.equal(rootSpan()?.attributes['run.id'], EXTERNAL)
        assert.equal(outcome.payload.runId, undefined)
        assert.equal(outcome.run.id, EXTERNAL)
    })

    it('an inline queue run keeps the id recorded in this process', async () => {
        process.env.CUTTLELY_HARNESS_QUEUE = 'inline'
        delete process.env.CUTTLELY_HARNESS_STUB_FAIL
        memory.reset()
        const outcome = await harnesses.startRun(
            'bakery',
            { question: 'How many loaves?', chatId: CHAT },
            { source: 'api', workspaceId: WORKSPACE, caller: { via: 'session' } }
        )
        assert.equal(rootSpan()?.attributes['run.id'], INLINE)
        assert.equal(outcome.payload.runId, undefined)
        assert.equal(outcome.run.id, INLINE)
    })

    it('an external queue failure still puts the saved history id on harness.run', async () => {
        process.env.CUTTLELY_HARNESS_QUEUE = 'external'
        process.env.CUTTLELY_HARNESS_STUB_FAIL = '1'
        memory.reset()
        await assert.rejects(
            () =>
                harnesses.startRun(
                    'bakery',
                    { question: 'How many loaves?', chatId: CHAT },
                    { source: 'api', workspaceId: WORKSPACE, caller: { via: 'session' } }
                ),
            /oven failed/
        )
        assert.equal(rootSpan()?.attributes['run.id'], EXTERNAL)
        assert.equal(rootSpan()?.attributes.status, 'error')
    })

    it('an inline queue failure keeps the id recorded in this process', async () => {
        process.env.CUTTLELY_HARNESS_QUEUE = 'inline'
        process.env.CUTTLELY_HARNESS_STUB_FAIL = '1'
        memory.reset()
        await assert.rejects(
            () =>
                harnesses.startRun(
                    'bakery',
                    { question: 'How many loaves?', chatId: CHAT },
                    { source: 'api', workspaceId: WORKSPACE, caller: { via: 'session' } }
                ),
            /oven failed/
        )
        assert.equal(rootSpan()?.attributes['run.id'], INLINE)
        assert.equal(rootSpan()?.attributes.status, 'error')
    })
})
