import { createCipheriv, createHmac, randomBytes } from 'node:crypto'
import path from 'node:path'
import { guardedEncryptionKeyOverwrite } from '../../scripts/setting-alias.cjs'
import { hermesHome } from './paths.mjs'
import { createRequire } from 'node:module'
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads'
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
        pollJob(id, seq, privateEventPrefix) {
            return request({ scope, op: 'pollJob', params: [id, seq, privateEventPrefix] })
        },
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
