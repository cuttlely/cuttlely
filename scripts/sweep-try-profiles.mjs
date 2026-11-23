// Bound the synchronous filesystem sweep so a failed cleanup cannot delay a runtime restart.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.argv[2] === '--sweep') {
    // MCP bridges a stopped runtime left behind (try profiles only) go first, then the abandoned try folders.
    const { sweepOrphanTryBridges } = await import('../packages/harness/try-bridges.mjs')
    await sweepOrphanTryBridges({ graceMs: 1500 })
    const { sweepAbandonedTryProfiles } = await import('../packages/harness/gateway.mjs')
    sweepAbandonedTryProfiles()
} else {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--sweep'], {
        stdio: 'ignore',
        timeout: 5000,
        killSignal: 'SIGKILL'
    })
    process.exitCode = child.status === 0 ? 0 : 1
}
