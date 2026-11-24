// Async access to the ETL database, on the SQLite connection db.mjs opens. SQL keeps `?` placeholders.
// That one connection serves every caller, so an `await` between BEGIN IMMEDIATE and COMMIT would let another caller's
// statement run inside the open transaction. A transaction holds the lock for its whole body, and a standalone statement
// waits while one is open or queued. Inside `tx(fn)` use the handle `fn` receives: a module-level call there waits for
// the transaction it is part of and never returns.
import { db, stmt } from './db.mjs'
import { EtlError } from './errors.mjs'

let queue = Promise.resolve()
let held = 0
let backend = null
let gateOpen = true
let gateReason = null

function release() {
    held -= 1
}

async function free() {
    while (held) await queue
}

function bind(params) {
    if (params === undefined) return []
    if (!Array.isArray(params)) throw new TypeError('ETL store parameters must be an array.')
    params.forEach((value, i) => {
        if (typeof value?.then === 'function') throw new TypeError(`ETL store parameter ${i + 1} is a Promise; await it first.`)
    })
    return params
}

function statements(live) {
    return {
        all: async (sql, params) => (live(), stmt(sql).all(...bind(params))),
        get: async (sql, params) => (live(), stmt(sql).get(...bind(params))),
        run: async (sql, params) => {
            live()
            const { changes } = stmt(sql).run(...bind(params))
            return { changes }
        },
        exec: async (sql) => {
            live()
            db().exec(sql)
        }
    }
}

function checkGate() {
    if (!gateOpen) {
        throw new EtlError('store_moving', 'ETL is moving to the application database. Try again in a minute.', 503, 30)
    }
}

export function useBackend(newBackend) {
    backend = newBackend
}

export function backendName() {
    return backend ? 'postgres' : 'sqlite'
}

export const gate = {
    closed: () => !gateOpen,
    close: (reason) => {
        gateOpen = false
        gateReason = reason || null
    },
    open: () => {
        gateOpen = true
        gateReason = null
    }
}

export async function drained() {
    while (held > 0) {
        await queue
    }
}

const standalone = statements(() => {})

async function executeOnBackend(method, ...args) {
    if (backend) {
        held += 1
        const result = queue.then(() => backend[method](...args))
        queue = result.then(
            (value) => {
                release()
                return value
            },
            (error) => {
                release()
                throw error
            }
        )
        return result
    } else {
        return standalone[method](...args)
    }
}

export async function all(sql, params) {
    checkGate()
    if (held) await free()
    return executeOnBackend('all', sql, params)
}

export async function get(sql, params) {
    checkGate()
    if (held) await free()
    return executeOnBackend('get', sql, params)
}

export async function run(sql, params) {
    checkGate()
    if (held) await free()
    return executeOnBackend('run', sql, params)
}

export async function exec(sql) {
    checkGate()
    if (held) await free()
    return executeOnBackend('exec', sql)
}

async function transaction(fn) {
    if (backend) {
        return backend.tx(fn)
    } else {
        const handle = db()
        let open = true
        const t = statements(() => {
            if (!open) throw new Error('This ETL transaction has already ended.')
        })
        handle.exec('BEGIN IMMEDIATE')
        try {
            const result = await fn(t)
            handle.exec('COMMIT')
            return result
        } catch (error) {
            handle.exec('ROLLBACK')
            throw error
        } finally {
            open = false
        }
    }
}

export function tx(fn) {
    try {
        checkGate()
    } catch (error) {
        return Promise.reject(error)
    }
    held += 1
    const result = queue.then(() => transaction(fn))
    queue = result.then(release, release)
    return result
}

// In-process keyed lock: calls for one pipeline run one after another, other pipelines are not held up.
const pipelineLocks = new Map()

export function withPipelineLock(pipelineId, fn) {
    const key = String(pipelineId)
    const result = (pipelineLocks.get(key) || Promise.resolve()).then(() => fn())
    const settled = result.then(
        () => {},
        () => {}
    )
    pipelineLocks.set(key, settled)
    settled.then(() => {
        if (pipelineLocks.get(key) === settled) pipelineLocks.delete(key)
    })
    return result
}
