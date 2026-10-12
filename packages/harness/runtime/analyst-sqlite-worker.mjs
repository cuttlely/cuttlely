// Runs analyst SQLite statements for packages/harness/runtime/analyst-store.mjs, one at a time.
// node:sqlite cannot stop a running statement, so the parent kills this process when a statement
// passes the analyst timeout. It exits when the parent goes away.
import { runAnalystSqliteRequest } from './analyst-store.mjs'

process.on('disconnect', () => process.exit(0))
process.on('message', async (request) => {
    process.send(await runAnalystSqliteRequest(request))
})
process.send({ ready: true })
