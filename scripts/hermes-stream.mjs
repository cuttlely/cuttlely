// A harness run that is reading a Hermes event stream leaves a short lease here.
// The supervisor must not kill Hermes for a health miss while that lease is fresh.
import fs from 'node:fs'
import path from 'node:path'
import { dataRoot } from '../harness/paths.mjs'

export const HERMES_STREAM_DIR = 'hermes-streams'
const FRESH_MS = 20000

export function hermesStreamDir(dataDir) {
    const dir = dataDir == null || String(dataDir).trim() === '' ? dataRoot() : String(dataDir)
    return path.join(dir, HERMES_STREAM_DIR)
}

function pidAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return false
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

export function beginHermesStream(dataDir) {
    const folder = hermesStreamDir(dataDir)
    fs.mkdirSync(folder, { recursive: true })
    const id = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const file = path.join(folder, id)
    const touch = () => {
        try {
            fs.writeFileSync(file, `${Date.now()}\n`)
        } catch {
            // A missing data dir must not fail the run.
        }
    }
    touch()
    const timer = setInterval(touch, 5000)
    timer.unref?.()
    return () => {
        clearInterval(timer)
        try {
            fs.rmSync(file, { force: true })
        } catch {
            // The supervisor treats a stale file as closed.
        }
    }
}

export function hermesStreamActive(dataDir) {
    const folder = hermesStreamDir(dataDir)
    let names = []
    try {
        names = fs.readdirSync(folder)
    } catch {
        return false
    }
    const now = Date.now()
    let active = false
    for (const name of names) {
        const file = path.join(folder, name)
        let at = 0
        try {
            at = Number(fs.readFileSync(file, 'utf8'))
        } catch {
            continue
        }
        const pid = Number(String(name).split('-')[0])
        if (now - at < FRESH_MS && pidAlive(pid)) {
            active = true
            continue
        }
        if (!(now - at < FRESH_MS)) {
            try {
                fs.rmSync(file, { force: true })
            } catch {
                // Another stream may have removed it.
            }
        }
    }
    return active
}

function cli() {
    if (process.argv[2] !== 'active') return
    process.exit(hermesStreamActive(process.env.CUTTLELY_DATA_DIR) ? 0 : 1)
}

if (process.argv[1] && process.argv[1].endsWith('hermes-stream.mjs')) cli()
