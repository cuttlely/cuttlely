#!/usr/bin/env node
/* eslint-disable no-console -- command-line check that reports its result on stdout and stderr */
// Checks which sqlite3 driver the server's TypeORM loads, the same way TypeORM does it: sqlite3 is
// resolved from TypeORM's own package directory, not from the caller. Prints the versions and exits
// non-zero unless the driver is the expected version and its native binding opens a database.
// Usage: node scripts/check-sqlite-driver.mjs [--expect 6.0.1] [--json]
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const DEFAULT_EXPECTED = '6.0.1'
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const findPackageDir = (entryFile, name) => {
    let dir = path.dirname(entryFile)
    while (dir !== path.dirname(dir)) {
        const manifest = path.join(dir, 'package.json')
        if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === name) return dir
        dir = path.dirname(dir)
    }
    throw new Error(`could not find the ${name} package directory above ${entryFile}`)
}

export const resolveServerSqliteDriver = (serverDir = path.join(repoRoot, 'packages', 'server')) => {
    const serverRequire = createRequire(path.join(serverDir, 'package.json'))
    const typeormDir = findPackageDir(serverRequire.resolve('typeorm'), 'typeorm')
    const typeormRequire = createRequire(path.join(typeormDir, 'package.json'))
    const sqlite3Manifest = typeormRequire.resolve('sqlite3/package.json')
    return {
        typeormVersion: JSON.parse(fs.readFileSync(path.join(typeormDir, 'package.json'), 'utf8')).version,
        typeormDir: fs.realpathSync(typeormDir),
        sqlite3Version: JSON.parse(fs.readFileSync(sqlite3Manifest, 'utf8')).version,
        sqlite3Dir: fs.realpathSync(path.dirname(sqlite3Manifest)),
        loadDriver: () => typeormRequire('sqlite3')
    }
}

const openMemoryDatabase = (sqlite3) =>
    new Promise((resolve, reject) => {
        const db = new sqlite3.Database(':memory:', (openErr) => {
            if (openErr) return reject(openErr)
            db.get('select sqlite_version() as v', (queryErr, row) => {
                db.close()
                return queryErr ? reject(queryErr) : resolve(row.v)
            })
        })
    })

const main = async () => {
    const args = process.argv.slice(2)
    const expectIndex = args.indexOf('--expect')
    const expected = expectIndex >= 0 ? args[expectIndex + 1] : DEFAULT_EXPECTED
    const driver = resolveServerSqliteDriver()
    const sqliteLibraryVersion = await openMemoryDatabase(driver.loadDriver())
    const result = {
        typeorm: driver.typeormVersion,
        sqlite3: driver.sqlite3Version,
        sqliteLibrary: sqliteLibraryVersion,
        sqlite3Dir: driver.sqlite3Dir,
        expected,
        ok: driver.sqlite3Version === expected
    }
    if (args.includes('--json')) console.log(JSON.stringify(result))
    else
        console.log(
            `server typeorm ${result.typeorm} loads sqlite3 ${result.sqlite3} (SQLite ${result.sqliteLibrary}) from ${result.sqlite3Dir}`
        )
    if (!result.ok) {
        console.error(`expected sqlite3 ${expected}, found ${result.sqlite3}`)
        process.exitCode = 1
    }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error(err)
        process.exitCode = 1
    })
}
