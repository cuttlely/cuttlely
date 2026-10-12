import { bootHarnessNodePool } from './node-pool.mjs'
import { queueMode, setWorkerContext, startWorkerLoop } from './queue.mjs'

// Separate process for CUTTLELY_HARNESS_QUEUE=external. Inline mode stays in the web process.
// Hermes is not started here. scripts/start-cuttlely.sh keeps it on 127.0.0.1.
if (queueMode() !== 'external') {
    console.error('Set CUTTLELY_HARNESS_QUEUE=external before starting packages/harness/worker.mjs. inline runs jobs in the web process.')
    process.exit(1)
}

const booted = await bootHarnessNodePool()
if (booted.ready) {
    setWorkerContext(booted.contextFor)
    console.info(`[harness] worker ${process.pid} node pool: ${booted.count} nodes`)
} else if (booted.skipped) {
    console.info(`[harness] worker ${process.pid} node pool skipped for the offline model`)
} else {
    console.info(`[harness] worker ${process.pid} node pool unavailable (${booted.reason})`)
}

const worker = startWorkerLoop()
const shutdown = () => worker.stop()
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
await worker.finished
