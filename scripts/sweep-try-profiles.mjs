// Bound the synchronous filesystem sweep so a failed cleanup cannot delay a runtime restart.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.argv[2] === '--sweep') {
    const { sweepAbandonedTryProfiles } = await import('../packages/harness/gateway.mjs')
    sweepAbandonedTryProfiles()
} else {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--sweep'], {
        stdio: 'ignore',
        timeout: 2000,
        killSignal: 'SIGKILL'
    })
    process.exitCode = child.status === 0 ? 0 : 1
}
