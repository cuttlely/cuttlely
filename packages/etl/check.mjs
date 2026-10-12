// Offline checks for the ETL engine. No build, key, or network.
//   node packages/etl/check.mjs            correctness
//   node packages/etl/check.mjs --stress   plus a 1M-row CSV and a generated repository
// The cases live in packages/etl/check/: correctness.mjs, failure.mjs (E9a), hardening.mjs (E5-E8, E16, E17) and
// migration.mjs (E1), workspace.mjs, review.mjs (findings from the pipeline review) and purge.mjs (deleting a
// pipeline deletes its vectors). lib.mjs sets the environment before any engine module loads.
import { tally } from './check/lib.mjs'

await import('./check/correctness.mjs')
await import('./check/failure.mjs')
await import('./check/hardening.mjs')
await import('./check/migration.mjs')
await import('./check/workspace.mjs')
await import('./check/review.mjs')
await import('./check/purge.mjs')

console.log(`${tally.passed} etl checks passed${tally.pending.length ? `, ${tally.pending.length} pending` : ''}`)

if (!process.argv.includes('--stress')) process.exit(process.exitCode || 0)

await import('./check/stress.mjs')
