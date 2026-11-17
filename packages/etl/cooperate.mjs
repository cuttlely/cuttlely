import { performance } from 'node:perf_hooks'

// An await on an already-resolved promise does not service HTTP, timers or cancellation.
// Keep CPU/disk bookkeeping in a bounded slice even when no provider I/O is needed.
export function createLoopYield() {
    let deadline = performance.now() + 20
    return () => {
        if (performance.now() < deadline) return null
        return new Promise((resolve) =>
            setImmediate(() => {
                deadline = performance.now() + 20
                resolve()
            })
        )
    }
}
