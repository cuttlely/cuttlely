import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads'
import { HarnessError } from './errors.mjs'

let worker
let config
export function configureHarnessPostgres(options) {
    if (worker) void worker.terminate()
    worker = undefined
    config = options
}
export function harnessUsesPostgres() {
    return Boolean(config)
}
function request(data) {
    if (!config) throw new Error('Harness PostgreSQL storage has not been selected.')
    if (!worker) {
        const replica = new Worker(new URL('./side-store-worker.mjs', import.meta.url), { workerData: config, execArgv: [] })
        replica.on('error', () => {})
        replica.on('exit', () => {
            if (worker === replica) worker = undefined
        })
        replica.unref()
        worker = replica
    }
    const { port1, port2 } = new MessageChannel()
    const ready = new Int32Array(new SharedArrayBuffer(4))
    try {
        worker.postMessage({ request: data, port: port2, ready }, [port2])
        if (Atomics.wait(ready, 0, 0, 15000) === 'timed-out') {
            void worker.terminate()
            worker = undefined
            throw new HarnessError('store_unavailable', 'Harness PostgreSQL storage timed out.', 503)
        }
        const reply = receiveMessageOnPort(port1)?.message
        if (!reply || reply.error) throw Object.assign(new Error('Harness PostgreSQL operation failed.'), { code: reply?.error?.code })
        return reply.value
    } finally {
        port1.close()
    }
}

export function openHarnessPostgres(scope) {
    request({ scope, op: 'open' })
    return {
        dialect: 'postgres',
        close() {},
        exec(command) {
            const op = { BEGIN: 'begin', 'BEGIN IMMEDIATE': 'begin', COMMIT: 'commit', ROLLBACK: 'rollback' }[command]
            if (!op) throw new Error('Unsupported harness transaction command.')
            return request({ scope, op })
        },
        prepare(statement) {
            // Harness-owned statements use positional placeholders. Literal question marks stay inside quoted strings.
            let position = 0
            const sql = statement.replace(/'(?:[^']|'')*'|\?/g, (part) => (part === '?' ? '$' + ++position : part))
            const call = (op, params) => request({ scope, op, sql, params })
            return {
                run: (...params) => call('run', params),
                all: (...params) => call('all', params),
                get: (...params) => call('get', params)
            }
        }
    }
}
export const dropDraftPostgres = (scope) => request({ scope: 'draft:' + scope, op: 'dropDraft' })
export const tryProfileLease = (key, owner) => request({ op: 'tryLease', key, owner })
export const releaseProfileLease = (owner) => request({ op: 'releaseLease', owner })
