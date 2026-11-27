import { createCipheriv, createHmac, randomBytes } from 'node:crypto'
import path from 'node:path'
import { guardedEncryptionKeyOverwrite } from '../../scripts/setting-alias.cjs'
import { hermesHome } from './paths.mjs'
import { createRequire } from 'node:module'
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads'
import { queueWakeChannel } from './side-store-identity.mjs'
import { HarnessError } from './errors.mjs'

const requireServer = createRequire(new URL('../server/package.json', import.meta.url))

let worker
let config
let records
export function harnessRecordDatabase() {
    return (records ??= openHarnessPostgres('queue'))
}
export function configureHarnessPostgres(options) {
    if (worker) void worker.terminate()
    worker = undefined
    records = undefined
    config = options
}
export function harnessUsesPostgres() {
    return Boolean(config)
}
// This optional message follows a committed admission. A failed worker, notification or listener
// leaves the durable queue intact and the external workers continue their regular polling.
export function notifyQueueWorkers() {
    try {
        worker?.postMessage({ notifyQueue: true })
    } catch {
        // The store worker may already be shutting down.
    }
}

export function listenForQueueWork(wake) {
    if (!config) return
    const settings = config
    const { Client } = requireServer('pg')
    let stopped = false,
        session,
        retry,
        closing
    function connect() {
        if (stopped) return
        const next = new Client({
            ...settings,
            application_name: 'Cuttlely harness queue listener',
            connectionTimeoutMillis: Math.min(Number(settings.connectionTimeoutMillis) || 5000, 5000),
            query_timeout: 2000
        })
        session = next
        function retire() {
            if (session !== next) return
            session = undefined
            closing = next.end().catch(() => {})
            if (!stopped) {
                retry = setTimeout(connect, 30000)
                retry.unref()
            }
        }
        next.on('error', retire)
        next.once('end', retire)
        next.on('notification', (notice) => {
            if (session === next && notice.channel === queueWakeChannel && !notice.payload) wake()
        })
        next.connect()
            .then(() => !stopped && next.query('LISTEN ' + queueWakeChannel))
            .catch(retire)
    }
    connect()
    return async () => {
        stopped = true
        clearTimeout(retry)
        if (session) {
            const last = session
            session = undefined
            await last.end().catch(() => {})
        }
        await closing
    }
}

function postgresWorker() {
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
    return worker
}

function request(data) {
    const replica = postgresWorker()
    const { port1, port2 } = new MessageChannel()
    const ready = new Int32Array(new SharedArrayBuffer(4))
    try {
        replica.postMessage({ request: data, port: port2, ready }, [port2])
        if (Atomics.wait(ready, 0, 0, STORE_TIMEOUT_MS) === 'timed-out') {
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

// Coalesce callers that became ready on the same turn of the Node event loop. Each
// observer has its own cursor, including two observers waiting for the same job.
const MAX_POLL_BATCH = 16
let pendingPolls
const STORE_TIMEOUT_MS = 15_000

function pollJob(id, seq, privateEventPrefix) {
    const replica = postgresWorker()
    if (
        !pendingPolls ||
        pendingPolls.replica !== replica ||
        pendingPolls.prefix !== privateEventPrefix ||
        pendingPolls.readers.length === MAX_POLL_BATCH
    ) {
        const batch = { replica, prefix: privateEventPrefix, readers: [] }
        pendingPolls = batch
        setImmediate(() => dispatchPolls(batch))
    }
    return new Promise((resolve, reject) => pendingPolls.readers.push({ id, seq, resolve, reject }))
}

function dispatchPolls(batch) {
    if (pendingPolls === batch) pendingPolls = undefined
    const { readers, replica, prefix } = batch
    const { port1, port2 } = new MessageChannel()
    const unavailable = () => new HarnessError('store_unavailable', 'Harness PostgreSQL storage is unavailable.', 503)
    function close() {
        clearTimeout(timer)
        port1.removeAllListeners()
        port1.close()
        port2.close()
    }
    function fail(error) {
        close()
        for (const reader of readers) reader.reject(error)
    }
    const deadline = Date.now() + STORE_TIMEOUT_MS
    const timer = setTimeout(() => fail(unavailable()), STORE_TIMEOUT_MS)
    port1.once('close', () => fail(unavailable()))
    port1.once('message', (reply) => {
        if (worker !== replica || !Array.isArray(reply?.value)) return fail(unavailable())
        const rows = new Map(reply.value.map((row) => [row.poll_index, row]))
        close()
        for (const [index, reader] of readers.entries()) reader.resolve(rows.get(index + 1) ?? null)
    })
    try {
        if (worker !== replica) throw unavailable()
        const params = [readers.map((r) => r.id), readers.map((r) => r.seq), prefix]
        replica.postMessage({ request: { scope: 'queue', op: 'pollJobs', params, deadline }, port: port2 }, [port2])
    } catch (error) {
        fail(error)
    }
}

export function openHarnessPostgres(scope) {
    request({ scope, op: 'open' })
    return {
        dialect: 'postgres',
        ...(scope === 'queue' && {
            pollJob,
            claimQueuedJob(now) {
                return request({ scope, op: 'claimQueuedJob', params: [now] })
            },
            writeTurnLease(action, params) {
                return request({ scope, op: 'writeTurnLease', action, params })
            },
            readJobCancellation(id) {
                return request({ scope, op: 'readJobCancellation', key: id })
            },
            readHarnessRecord(entry) {
                return request({ scope, op: 'readHarnessRecord', key: entry })
            },
            appendJobEvent(id, event, phase) {
                return request({ scope, op: 'appendJobEvent', params: [id, event, phase] })
            }
        }),
        creditUsage(workspaceId, flowId, result, at) {
            const { usageLinesFromRun } = requireServer('./dist/services/usage/lines.js')
            const lines = usageLinesFromRun(result)
            if (lines.length) request({ scope, op: 'creditUsage', usage: { workspaceId, flowId, lines, at } })
        },
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

export function saveRuntimeSetting(file, content) {
    if (!config) return
    const name = path.relative(hermesHome(), file).split(path.sep).join('/')
    if (
        !/^(?:profiles\/[a-zA-Z0-9_-]+\/)?(?:\.env|config\.yaml|SOUL\.md|harness-roster\.json|skills\/harness-playbooks\/[a-zA-Z0-9_-]+\/SKILL\.md)$/.test(
            name
        )
    )
        return
    const secret = guardedEncryptionKeyOverwrite(process.env)
    if (!secret?.trim()) throw new Error('The installation encryption key is required to save runtime settings.')
    const key = createHmac('sha256', secret)
        .update('Cuttlely runtime session v1\0setting/' + name)
        .digest()
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.from(name))
    const payload = Buffer.concat([nonce, cipher.update(content), cipher.final(), cipher.getAuthTag()])
    request({ op: 'saveRuntimeSetting', key: name, payload })
}
