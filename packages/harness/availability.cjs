// Shared run refusal. The server registers the boot-compile check.
// run.mjs wraps runHarness and runQueuedHarness with guardHarnessRun, so chatflow runs get the same refusal.

let availabilityCheck = null

const fs = require('node:fs')
const path = require('node:path')

// The native build creates this file inside the installed server package. Ignore operator
// data and environment flags here: a bundled deployment still defaults to the legacy engine.
const nativeDistribution = fs.existsSync(path.join(__dirname, 'native-distribution.json'))

function runtimeState(dataDir = process.env.CUTTLELY_DATA_DIR) {
    if (nativeDistribution) return 'native'
    if (!dataDir) return 'unknown'
    try {
        const body = JSON.parse(fs.readFileSync(path.join(dataDir, 'hermes-supervisor.json'), 'utf8'))
        return ['up', 'down', 'restarting', 'degraded', 'cooldown', 'exhausted'].includes(body?.state) ? body.state : 'unknown'
    } catch {
        // Direct runtime starts do not have a supervisor status file.
        return 'unknown'
    }
}

function selectAgentEngine(name) {
    if (nativeDistribution) return 'native'
    return process.env.CUTTLELY_NATIVE_PRIME_TEAMS?.split(',').some((entry) => entry.trim() && entry.trim() === name) ? 'native' : 'hermes'
}

function supervisorUnavailable(dataDir) {
    return nativeDistribution || ['down', 'restarting', 'cooldown', 'exhausted'].includes(runtimeState(dataDir))
}

// Call only after caller and resource authorization. Never echo supervisor details to an API caller.
function assertRuntimeAvailable(dataDir = process.env.CUTTLELY_DATA_DIR, admittedEngine) {
    if (admittedEngine === 'native') return
    if (!supervisorUnavailable(dataDir)) return
    throw unavailable()
}

function unavailable() {
    return Object.assign(new Error('The agent runtime is unavailable. Try again shortly or contact the instance operator.'), {
        code: 'RUNTIME_UNAVAILABLE',
        statusCode: 503,
        retryAfterSeconds: 5
    })
}

// Named API preflight runs after authorization and before charging the caller. Read the roster
// only when a native exemption matters. An unresolved, foreign, or unsupported target fails closed.
function assertSelectedHarnessAvailable(name, target) {
    if (!supervisorUnavailable()) return
    if (selectAgentEngine(name) !== 'native') throw unavailable()
    return Promise.all([import('./runtime/native-prime.mjs'), nativeRoster(name, target)]).then(
        ([{ useNativeSpecialists }, roster]) => {
            try {
                if (
                    roster?.name === name &&
                    roster.chief?.model?.nodeName &&
                    roster.specialists?.length &&
                    useNativeSpecialists(roster, 'native')
                )
                    return
            } catch {
                // Unavailable canary capabilities still need the bundled runtime.
            }
            throw unavailable()
        },
        () => {
            throw unavailable()
        }
    )
}

async function nativeRoster(name, target) {
    if (target?.record) return target.record
    if (target?.canvas) {
        const { rosterForCanvasRun, rosterFromFlow } = await import('./sync-from-flow.mjs')
        const { id: chatflowId, workspaceId } = target.canvas
        if (!chatflowId || !workspaceId || target.canvas.name !== name) return
        // Older callers can select a graph without attesting whether it is Live.
        // Inspect that exact graph without inheriting a stored generation or companion grant.
        if (!target.readSelection && target.readFlowData) {
            const { getHarness } = await import('./store.mjs')
            const saved = getHarness(name)
            if (saved && (saved.chatflowId !== chatflowId || saved.workspaceId !== workspaceId)) return
            const flowData = await target.readFlowData()
            return rosterFromFlow({ name, chatflowId, workspaceId, flowData }, { inheritSavedFields: false })
        }
        const selection = target.readSelection ? await target.readSelection() : { flowData: target.canvas.flowData, published: true }
        return rosterForCanvasRun({ name, chatflowId, workspaceId, flowData: selection.flowData }, selection)
    }
    if (!target?.workspaceId) return
    const { getHarness } = await import('./store.mjs')
    const record = getHarness(name)
    return record?.workspaceId === target.workspaceId ? record : undefined
}

function setHarnessAvailabilityCheck(check) {
    availabilityCheck = typeof check === 'function' ? check : null
}

// Async so a refusal is a rejected promise, the same as a failed run.
async function guardHarnessRun(name, run) {
    if (typeof availabilityCheck === 'function') availabilityCheck(name)
    return run()
}

module.exports = {
    setHarnessAvailabilityCheck,
    guardHarnessRun,
    runtimeState,
    supervisorUnavailable,
    assertRuntimeAvailable,
    selectAgentEngine,
    assertSelectedHarnessAvailable
}
