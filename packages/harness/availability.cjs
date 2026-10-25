// Shared run refusal. The server registers the boot-compile check.
// run.mjs wraps runHarness and runQueuedHarness with guardHarnessRun, so chatflow runs get the same refusal.

let availabilityCheck = null

function setHarnessAvailabilityCheck(check) {
    availabilityCheck = typeof check === 'function' ? check : null
}

// Async so a refusal is a rejected promise, the same as a failed run.
async function guardHarnessRun(name, run) {
    if (typeof availabilityCheck === 'function') availabilityCheck(name)
    return run()
}

module.exports = { setHarnessAvailabilityCheck, guardHarnessRun }
