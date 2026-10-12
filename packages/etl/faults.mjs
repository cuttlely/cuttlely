// Test-only fault injection for etl:check (spec section 7). Faults are honored only when ETL_CHECK=1, so a context
// built from settings or request data can never switch one on.

// A simulated process kill: the runner rethrows it without writing a status, which leaves the run `running` exactly
// like a SIGKILL. etl:check then calls resumeInterruptedRuns(), the way a restart does.
export class CrashSignal extends Error {
    constructor(point) {
        super(`Simulated crash at ${point}.`)
        this.name = 'CrashSignal'
        this.code = 'crash'
        this.crash = true
    }
}

export function isCrash(error) {
    return error instanceof CrashSignal || error?.crash === true
}

export function faultsFor(ctx) {
    return process.env.ETL_CHECK === '1' && ctx?.faults ? ctx.faults : null
}

// Runs the fault registered at `point`, if any: 'crash' throws a CrashSignal, a function is called with `args` and its
// result returned (it may throw to inject an error).
export function fault(ctx, point, ...args) {
    const handler = faultsFor(ctx)?.[point]
    if (!handler) return undefined
    if (handler === 'crash') throw new CrashSignal(point)
    if (typeof handler === 'function') return handler(...args)
    return handler
}
