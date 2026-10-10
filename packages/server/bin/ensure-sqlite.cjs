'use strict'

// Node 22.5 through 22.12 expose node:sqlite only with --experimental-sqlite.
// packages/server/bin/run is `#!/usr/bin/env node`, so the server can be an older
// binary than the Node 24 the operator installed. Re-exec that same binary with
// the flag when the flag is enough. A binary that still cannot load the built-in
// keeps starting; the ETL list API returns a sentence instead of the module error.

function sqliteMissing(error) {
    if (!error) return false
    const message = error.message ? String(error.message) : ''
    return error.code === 'ERR_UNKNOWN_BUILTIN_MODULE' || /node:sqlite/.test(message)
}

function warn(execPath) {
    console.error(`Cuttlely warning: Node ${process.version} at ${execPath} cannot load node:sqlite. ETL needs Node 24 (.nvmrc).`)
}

function ensureSqliteFlag() {
    try {
        require('node:sqlite')
        return false
    } catch (error) {
        if (!sqliteMissing(error) || process.execArgv.includes('--experimental-sqlite')) {
            if (sqliteMissing(error)) warn(process.execPath)
            return false
        }
        const { spawnSync, spawn } = require('child_process')
        const probe = spawnSync(process.execPath, ['--experimental-sqlite', '-e', 'require("node:sqlite")'], { stdio: 'ignore' })
        if (probe.status !== 0) {
            warn(process.execPath)
            return false
        }
        const child = spawn(process.execPath, ['--experimental-sqlite', ...process.execArgv, ...process.argv.slice(1)], {
            stdio: 'inherit'
        })
        child.on('exit', (code, signal) => {
            if (signal) process.kill(process.pid, signal)
            else process.exit(code == null ? 1 : code)
        })
        child.on('error', () => process.exit(1))
        return true
    }
}

module.exports = { ensureSqliteFlag, sqliteMissing }
