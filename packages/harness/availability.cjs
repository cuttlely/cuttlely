// Shared run refusal. The server registers the boot-compile check.
// run.mjs wraps runHarness and runQueuedHarness with guardHarnessRun, so chatflow runs get the same refusal.

let availabilityCheck = null

const fs = require('node:fs')
const path = require('node:path')

function runtimeState(dataDir = process.env.CUTTLELY_DATA_DIR) {
    if (!dataDir) return 'unknown'
    try {
        const body = JSON.parse(fs.readFileSync(path.join(dataDir, 'hermes-supervisor.json'), 'utf8'))
        return ['up', 'down', 'restarting', 'degraded', 'cooldown', 'exhausted'].includes(body?.state) ? body.state : 'unknown'
    } catch {
        // Direct runtime starts do not have a supervisor status file.
        return 'unknown'
    }
}

// Call only after caller and resource authorization. Never echo supervisor details to an API caller.
function assertRuntimeAvailable(dataDir = process.env.CUTTLELY_DATA_DIR) {
    if (!['down', 'restarting', 'cooldown', 'exhausted'].includes(runtimeState(dataDir))) return
    throw Object.assign(new Error('The agent runtime is unavailable. Try again shortly or contact the instance operator.'), {
        code: 'RUNTIME_UNAVAILABLE',
        statusCode: 503,
        retryAfterSeconds: 5
    })
}

function setHarnessAvailabilityCheck(check) {
    availabilityCheck = typeof check === 'function' ? check : null
}

// Async so a refusal is a rejected promise, the same as a failed run.
async function guardHarnessRun(name, run) {
    if (typeof availabilityCheck === 'function') availabilityCheck(name)
    return run()
}

module.exports = { setHarnessAvailabilityCheck, guardHarnessRun, runtimeState, assertRuntimeAvailable }
