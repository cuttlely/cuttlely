import { AsyncLocalStorage } from 'async_hooks'
import { randomUUID } from 'crypto'
import path from 'path'
import { MessageChannel, receiveMessageOnPort, Worker } from 'worker_threads'
import { encryptionKeyOverwrite } from './settingAlias'
import type { SettingsRequest } from './postgres-worker'

export const POSTGRES_SETTINGS_URL = 'CUTTLELY_SERVER_SETTINGS_POSTGRES_URL'
const PRIVATE_FILES = ['instance-operator.json', 'operator-claim.json', 'operator-installation.json']
export const POSTGRES_SETTINGS_FILES = new Set([
    ...PRIVATE_FILES,
    'server.json',
    'server.last-good.json',
    'server.rolled-back.json',
    'history.jsonl',
    'boot.json',
    'database.previous.json',
    'authkit-test.json',
    'apply-when-idle.json',
    'it-worked.json'
])

export class SettingsStorageError extends Error {
    constructor() {
        super('Could not access Postgres server settings. Check the host connection and the installation encryption key.')
        this.name = 'SettingsStorageError'
    }
}

type Lease = { token: string; active: boolean }

export class PostgresSettings {
    private worker: Worker | undefined
    private readonly context = new AsyncLocalStorage<Lease>()
    private retryAfter = 0

    constructor(private readonly options: { url: string; secret: string; dir: string }) {}

    private request<T>(request: SettingsRequest): T {
        if (request.op !== 'release' && this.retryAfter > Date.now()) throw new SettingsStorageError()
        if (!this.worker) {
            const worker = new Worker(path.join(__dirname, 'postgres-worker.js'), {
                workerData: { ...this.options, files: [...POSTGRES_SETTINGS_FILES], privateFiles: PRIVATE_FILES }
            })
            worker.on('error', () => undefined)
            worker.on('exit', () => {
                if (this.worker === worker) this.worker = undefined
            })
            worker.unref()
            this.worker = worker
        }
        const ready = new Int32Array(new SharedArrayBuffer(4))
        const { port1, port2 } = new MessageChannel()
        try {
            this.worker.postMessage({ request, ready, port: port2 }, [port2])
            if (Atomics.wait(ready, 0, 0, request.op === 'init' ? 6000 : 3000) === 'timed-out') {
                // A stalled worker could still hold a session lock. Dropping it closes that session.
                void this.worker.terminate()
                this.worker = undefined
                this.retryAfter = Date.now() + 3000
                throw new SettingsStorageError()
            }
            const reply = receiveMessageOnPort(port1)?.message as { failed?: boolean; result?: T } | undefined
            if (!reply || reply.failed) {
                if (request.op === 'read' && !request.token) this.retryAfter = Date.now() + 1000
                throw new SettingsStorageError()
            }
            return reply.result as T
        } finally {
            port1.close()
        }
    }

    initialize(): void {
        this.request({ op: 'init' })
    }

    private get token(): string | undefined {
        const lease = this.context.getStore()
        return lease?.active ? lease.token : undefined
    }

    read(file: string): string | null {
        return this.request({ op: 'read', file, token: this.token })
    }

    write(file: string, text: string): void {
        this.writeLocked((token) => this.request({ op: 'write', file, text, token }))
    }

    remove(file: string): void {
        this.writeLocked((token) => this.request({ op: 'remove', file, token }))
    }

    private writeLocked(work: (token: string) => void): void {
        if (this.token) return work(this.token)
        const lease = this.take()
        if (!lease) throw new SettingsStorageError()
        try {
            work(lease.token)
        } finally {
            this.release(lease)
        }
    }

    get locked(): boolean {
        return this.token !== undefined
    }

    take(): Lease | null {
        const token = randomUUID()
        return this.request<boolean>({ op: 'take', token }) ? { token, active: true } : null
    }

    run<T>(lease: Lease, work: () => T): T {
        return this.context.run(lease, work)
    }

    release(lease: Lease): void {
        lease.active = false
        this.request({ op: 'release', token: lease.token })
    }
}

let configured: { dir: string; store: PostgresSettings } | undefined

export function initPostgresSettings(dir: string, env: Record<string, string | undefined>): void {
    const url = env[POSTGRES_SETTINGS_URL]?.trim()
    if (!url) return
    if (!/^postgres(?:ql)?:\/\//i.test(url) || !URL.canParse(url) || new URL(url).pathname.length < 2) {
        throw new Error('Set CUTTLELY_SERVER_SETTINGS_POSTGRES_URL to the connection URL of a Postgres database.')
    }
    const secret = encryptionKeyOverwrite(env)
    if (!secret?.trim()) throw new Error('Postgres server settings require CUTTLELY_SECRETKEY_OVERWRITE to be set on the host.')
    const store = new PostgresSettings({ url, secret, dir })
    store.initialize()
    configured = { dir: path.resolve(dir), store }
}

export function postgresSettings(dir: string, file?: string): PostgresSettings | undefined {
    if (!configured || configured.dir !== path.resolve(dir) || (file && !POSTGRES_SETTINGS_FILES.has(file))) return undefined
    return configured.store
}
