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
        throw new EtlError(
            gateReason?.code ?? 'store_moving',
            gateReason?.message ?? 'ETL is moving to the application database. Try again in a minute.',
            503,
            30
        )
    }
}

export function useBackend(newBackend) {
    backend = newBackend
}

export function postgresVectorCollection(collection) {
    checkGate()
    return backend?.vectors?.(collection)
}

export function sharedExecution() {
    return Boolean(backend?.tryLease)
}
export function tryLease(key) {
    checkGate()
    return backend.tryLease(key)
}
async function pipelineWork(id, fn) {
    if (!sharedExecution()) return fn()
    let release
    while (!(release = await tryLease('pipeline:' + id))) await new Promise((resolve) => setTimeout(resolve, 50))
    try {
        return await fn()
    } finally {
        await release()
    }
}

export function backendName() {
    return backend ? 'postgres' : 'sqlite'
}

export const gate = {
    closed: () => !gateOpen,
    assertOpen: checkGate,
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

// Register every admitted operation before yielding. The drain must include work waiting behind a transaction.
async function enqueue(work) {
    checkGate()
    held += 1
    const result = queue.then(work)
    queue = result.then(release, release)
    return result
}

function executeOnBackend(method, ...args) {
    const store = backend || standalone
    return enqueue(() => store[method](...args))
}

export function all(sql, params) {
    return executeOnBackend('all', sql, params)
}

export function get(sql, params) {
    return executeOnBackend('get', sql, params)
}

export function run(sql, params) {
    return executeOnBackend('run', sql, params)
}

export function exec(sql) {
    return executeOnBackend('exec', sql)
}

async function sqliteTransaction(fn) {
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

export function tx(fn) {
    const store = backend
    return enqueue(() => (store ? store.tx(fn) : sqliteTransaction(fn)))
}

// In-process keyed lock: calls for one pipeline run one after another, other pipelines are not held up.
const pipelineLocks = new Map()

export function withPipelineLock(pipelineId, fn) {
    const key = String(pipelineId)
    const result = (pipelineLocks.get(key) || Promise.resolve()).then(() => pipelineWork(key, fn))
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
