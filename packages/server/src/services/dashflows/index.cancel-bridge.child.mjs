// Runs refreshDashboard (index.ts) against the real tool bridge (packages/harness/bridge.mjs), so the order in which the
// bridge prepares a node, awaits beforeCall, runs assertCall, awaits beforeRetry and starts the source is the shipped
// one, not a copy. Jest cannot import the ESM bridge without --experimental-vm-modules, so index.test.ts runs this in a
// child Node process.
// Arguments: the store mode, "sqlite" (switch off) or "postgres" (switch on), and the scenario:
// - "prepare" (default): the cancel lands while the bridge prepares the source node.
// - "retry-cancel": the source's first attempt fails with an argument-shape error, and the cancel lands during it.
// - "retry": the same shape error with no cancel, so the bridge retries with the next argument shape.
// Prints one JSON line with the outcome.
import Module, { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const requireFromHere = createRequire(import.meta.url)
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'commonjs', moduleResolution: 'node', esModuleInterop: true })
requireFromHere('ts-node/register/transpile-only')

const mode = process.argv[2]
if (mode !== 'sqlite' && mode !== 'postgres') throw new Error(`Unknown store mode: ${mode}`)
const scenario = process.argv[3] || 'prepare'
if (!['prepare', 'retry-cancel', 'retry'].includes(scenario)) throw new Error(`Unknown scenario: ${scenario}`)
const realBridge = await import(pathToFileURL(path.join(here, '../../../../harness/bridge.mjs')).href)
const { z } = requireFromHere('zod')
// The real bridge, with a count of the beforeRetry calls the refresh service passes it.
let beforeRetryCalls = 0
const bridge = {
    ...realBridge,
    executeSpecialistTool: (harnessName, specialistName, toolName, args, options) =>
        realBridge.executeSpecialistTool(harnessName, specialistName, toolName, args, {
            ...options,
            beforeRetry: options.beforeRetry && (() => (beforeRetryCalls++, options.beforeRetry()))
        })
}

class DashFlowError extends Error {
    constructor(message, status) {
        super(message)
        this.status = status
    }
}
// Cancel clears the lease in both stores, so every later check refuses with 409. Switch off: the SQLite store's check
// is synchronous, wrapped in an async method (asyncStore in packages/harness/dashflows.mjs). Switch on: the
// application-database store awaits a query before it refuses.
let cancelled = false
let refusals = 0
const refuse = () => {
    refusals++
    throw new DashFlowError('This refresh was cancelled, replaced or interrupted.', 409)
}
const claim = { token: 'lease', revision: 1, definition: { harness: 'synthetic-contract' } }
let settled
let cachePuts = 0
const store = {
    assertActive:
        mode === 'sqlite'
            ? async () => {
                  if (cancelled) refuse()
              }
            : async () => {
                  await new Promise((resolve) => setImmediate(resolve))
                  if (cancelled) refuse()
              },
    heartbeat: async () => true,
    cancel: async () => undefined,
    progress: async () => undefined,
    queryCache: async () => ({ get: async () => undefined, put: async () => void cachePuts++ }),
    claim: async () => claim,
    settle: async (_id, _workspace, _claim, snapshot, error) => {
        settled = { snapshot, error }
        return { snapshot }
    }
}
// One card, one source query, with each progress write awaited and the result cached as materializeCached does.
const materializeCached = async (_definition, _record, invoke, cache, _preferCache, progress) => {
    await progress({ phase: 'views', completed: 0, total: 1, active: [] })
    const rows = await invoke({ specialist: 'analyst', name: 'query', bindingIndex: 0 }, { month: '2026-10-01' })
    await cache.put('query', rows)
    return { id: 'new' }
}

// The source node; invoke() is the source start. In "prepare" the cancel lands while the bridge is preparing it. In the
// retry scenarios the tool takes object input, and its first attempt fails schema validation, as a tool does when the
// model's argument names do not match its schema; the bridge then retries with the next argument shape (text).
let sourceStarts = 0
const parse = z.object({ month: z.number() }).parse
class SourceNode {
    async init() {
        if (scenario === 'prepare') {
            cancelled = true
            await new Promise((resolve) => setImmediate(resolve))
            return { name: 'query', invoke: async () => (sourceStarts++, 'late-source-result') }
        }
        return {
            name: 'query',
            schema: { type: 'object', properties: { month: { type: 'string' } }, required: ['month'] },
            invoke: async (arg) => {
                sourceStarts++
                if (sourceStarts > 1) return 'retried-source-result'
                if (scenario === 'retry-cancel') cancelled = true
                await new Promise((resolve) => setImmediate(resolve))
                return parse(arg)
            }
        }
    }
}
const record = {
    name: 'synthetic-contract',
    workspaceId: 'team-a',
    specialists: [{ name: 'analyst', modules: [{ nodeName: 'sourceNode', nodeId: 'source', inputs: {} }] }]
}

const stub = (request, exports) => {
    const file = requireFromHere.resolve(path.join(here, request))
    const module = new Module(file)
    module.filename = file
    module.loaded = true
    module.exports = exports
    requireFromHere.cache[file] = module
}
stub('../harnesses', {
    __esModule: true,
    default: { getHarness: async () => record },
    contextFor: async () => ({ flowOptions: { appDataSource: {}, workspaceId: 'team-a' }, loadNode: async () => SourceNode }),
    loadHarness: async (name) => (name === 'dashflows.mjs' ? { dashStore: () => store, materializeCached, DashFlowError } : bridge)
})
stub('../../identity/rbac', { resolveTeamAccess: async () => ({ owner: false, permissions: [] }) })
stub('../../utils/logger', { __esModule: true, default: { warn() {}, info() {}, error() {} } })
stub('../../settings/runs', {
    isDraining: () => false,
    isShuttingDown: () => false,
    trackBackgroundRun: (run) => run,
    onDrainStart: () => () => undefined
})
const { refreshDashboard } = requireFromHere('./index.ts')

let outcome
try {
    await refreshDashboard('dashboard', 'team-a')
    outcome = { resolved: true }
} catch (error) {
    outcome = { statusCode: error?.statusCode ?? null }
}
process.stdout.write(
    `${JSON.stringify({
        mode,
        scenario,
        ...outcome,
        refusals,
        sourceStarts,
        beforeRetryCalls,
        cachePuts,
        settledSnapshot: settled?.snapshot ?? null
    })}\n`
)
