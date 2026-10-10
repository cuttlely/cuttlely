#!/usr/bin/env node
/* eslint-disable no-console -- command-line tool; output is the interface */
// Safe boot check on the real server, with its own HOME and data folder. A start that cannot open the database after a
// settings change must stop (exit 76) instead of running half-started, must never become the last good copy, and the
// third start must put back the last settings that worked and get ready. The third start goes the start script's way
// (its settings helper first), which must tell the server that safe boot rolled back, so the banner shows. A fifth start
// with the host's own database unreachable stays up but is never ready: ping answers 503 and the log says why.
//
//   pnpm safeboot:check
//
// Made-up values only: the "bad" database is Postgres on 127.0.0.1 port 1, which refuses at once.
// Needs packages/server/dist (pnpm build). Run by pnpm verify as the safeboot step.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dataEnv, freePort, request, startServer, waitForPing } from './upgrade-check.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
export const SETTINGS_FAILED_EXIT_CODE = 76
const FAIL_MS = 90 * 1000
const KEY = 'safeboot-check-made-up-key-0123456789abcdef'
const BAD = { DATABASE_TYPE: 'postgres', DATABASE_HOST: '127.0.0.1', DATABASE_PORT: '1', DATABASE_NAME: 'bakery', DATABASE_USER: 'bakery' }

function read(file) {
    try {
        return fs.readFileSync(file, 'utf8')
    } catch {
        return null
    }
}

async function waitForExit(server, ms) {
    const timer = new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))
    const exited = new Promise((resolve) => {
        if (server.child.exitCode !== null) resolve(server.child.exitCode)
        else server.child.once('exit', (code) => resolve(code))
    })
    return Promise.race([exited, timer])
}

export async function main() {
    const dist = path.join(ROOT, 'packages', 'server', 'dist', 'settings', 'store.js')
    if (!fs.existsSync(dist)) throw new Error('packages/server/dist is missing. Run pnpm build first.')
    const store = require(dist)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-safeboot-check-'))
    const dataRoot = path.join(tmp, 'data')
    const home = path.join(tmp, 'home')
    fs.mkdirSync(home, { recursive: true })
    const dir = path.join(dataRoot, 'settings')
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const env = dataEnv(dataRoot, port, { HOME: home, FLOWISE_SECRETKEY_OVERWRITE: KEY, CUTTLELY_LOCAL_ADMIN: 'true' })
    delete env.DATABASE_TYPE // the settings file must be able to choose the database
    delete env.CUTTLELY_SUPERVISED
    const step = (text) => console.log(`  ${text}`)
    const lastGood = () => read(path.join(dir, store.LAST_GOOD_FILE))
    try {
        console.log('safe boot check (isolated HOME and data folder)')
        store.writeSettingsFile(dir, { LOG_LEVEL: 'info' }, { key: KEY, by: 'safeboot check' })
        let server = startServer(ROOT, env)
        await waitForPing(base, server)
        await server.stop()
        const good = lastGood()
        if (good === null || good !== read(path.join(dir, store.SETTINGS_FILE)))
            throw new Error('a start that got ready did not save the last good copy')
        step('start 1 with working settings: ready, saved as the last good copy')

        store.writeSettingsFile(dir, { LOG_LEVEL: 'info', ...BAD }, { key: KEY, by: 'safeboot check' })
        for (const n of [2, 3]) {
            server = startServer(ROOT, env)
            const code = await waitForExit(server, FAIL_MS)
            if (code === 'timeout') {
                await server.stop()
                throw new Error(`start ${n} with a database that cannot be opened kept running half-started`)
            }
            if (code !== SETTINGS_FAILED_EXIT_CODE)
                throw new Error(`start ${n} exited ${code}, expected ${SETTINGS_FAILED_EXIT_CODE}\n${server.logs.join('').slice(-3000)}`)
            if (lastGood() !== good) throw new Error(`start ${n} saved settings that did not start as the last good copy`)
            const res = await request(`${base}/api/v1/ping`, { timeoutMs: 1500 }).catch(() => null)
            if (res && res.status === 200) throw new Error(`something still answers on the port after start ${n}`)
            step(`start ${n} with an unreachable database: stopped with ${code}, last good copy unchanged`)
        }

        // Start 4 as scripts/start-cuttlely.sh does it: the settings helper runs safe boot and hands its records over.
        // The records hold setting values, so they are only parsed here, never printed.
        const helper = spawnSync(process.execPath, [path.join(ROOT, 'packages', 'server', 'dist', 'settings', 'env-cli.js'), 'start'], {
            env,
            encoding: 'utf8'
        })
        if (helper.status !== 0) throw new Error(`the start script's settings helper exited ${helper.status}`)
        const records = helper.stdout.split('\0').filter(Boolean)
        if (!records.includes('CUTTLELY_SETTINGS_ROLLED_BACK=1'))
            throw new Error('the settings helper did not tell the server it rolled back')
        if (!/starts did not finish/.test(helper.stderr)) throw new Error('start 4 did not say it rolled back')
        const scriptEnv = { ...env }
        for (const record of records) scriptEnv[record.slice(0, record.indexOf('='))] = record.slice(record.indexOf('=') + 1)
        server = startServer(ROOT, scriptEnv)
        await waitForPing(base, server)
        await server.stop()
        if (read(path.join(dir, store.SETTINGS_FILE)) !== good) throw new Error('start 4 did not put back the last settings that worked')
        if (!fs.existsSync(path.join(dir, 'server.rolled-back.json')))
            throw new Error('the settings that did not start were not kept aside')
        step('start 4 the start script way: safe boot put back the last settings that worked, told the server, and got ready')

        // Start 5: the host's own database cannot be reached (not a settings change, so it stays up). It must not say it
        // is ready, ping must answer 503 with a plain reason (Docker and Render see it unhealthy), and the log must name
        // host and port, never the password.
        const PW = 'safeboot-check-made-up-db-password'
        server = startServer(ROOT, { ...env, ...BAD, DATABASE_PASSWORD: PW, CUTTLELY_IGNORE_ADMIN_SETTINGS: '1' })
        let ping = null
        for (const until = Date.now() + FAIL_MS; Date.now() < until; ) {
            if (server.child.exitCode !== null)
                throw new Error(`start 5 exited ${server.child.exitCode}\n${server.logs.join('').slice(-3000)}`)
            ping = await request(`${base}/api/v1/ping`, { timeoutMs: 3000 }).catch(() => null)
            if (ping && ping.text.startsWith('database unreachable')) break
            await new Promise((resolve) => setTimeout(resolve, 500))
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const log5 = server.logs.join('')
        await server.stop()
        if (!ping || ping.status !== 503 || ping.text !== 'database unreachable: connection refused')
            throw new Error(`start 5 ping answered ${ping ? `${ping.status} ${ping.text.slice(0, 80)}` : 'nothing'}`)
        if (/Cuttlely is ready/.test(log5)) throw new Error('start 5 said Cuttlely is ready without its database')
        if (!log5.includes("can't reach its database (postgres at 127.0.0.1:1): connection refused"))
            throw new Error('start 5 did not log that the database cannot be reached, with host and port')
        if (log5.includes(PW)) throw new Error('start 5 printed the database password')
        step('start 5 with the host database unreachable: ping 503 with the reason, one log line with host and port, never ready')
        console.log('safe boot check passed')
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error)
        process.exit(1)
    })
}
