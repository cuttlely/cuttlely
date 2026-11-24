// Runs the asynchronous Postgres driver off the thread that reads settings during CLI bootstrap.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto'
import fs from 'fs'
import path from 'path'
import { parentPort, workerData, MessagePort } from 'worker_threads'
import { readPrivateFile } from './privateFile'

const { Pool } = require('pg')
const { url, secret, dir, files, privateFiles } = workerData as {
    url: string
    secret: string
    dir: string
    files: string[]
    privateFiles: string[]
}
const pool = new Pool({
    connectionString: url,
    application_name: 'Cuttlely server settings',
    connectionTimeoutMillis: 1500,
    keepAlive: true,
    statement_timeout: 1500,
    query_timeout: 2200,
    max: 4
})
pool.on('error', () => undefined)
const key = Buffer.from(hkdfSync('sha256', secret, '', 'Cuttlely service settings Postgres v1', 32))
const marker = 'backend-version'
const lockKey = '1945290148, 577'

type Client = {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }>
    release: (destroy?: boolean) => void
    on: (event: 'error', callback: () => void) => void
    off: (event: 'error', callback: () => void) => void
}
const sessions = new Map<string, { client: Client; onError: () => void }>()

export type SettingsRequest =
    | { op: 'init' }
    | { op: 'take' | 'release'; token: string }
    | { op: 'read' | 'remove'; file: string; token?: string }
    | { op: 'write'; file: string; text: string; token?: string }

function seal(file: string, text: string): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(file))
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
}

function unseal(file: string, value: Buffer): string {
    const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
    cipher.setAAD(Buffer.from(file)).setAuthTag(value.subarray(12, 28))
    return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8')
}

async function put(client: Client, file: string, text: string): Promise<void> {
    await client.query(
        'INSERT INTO public.cuttlely_server_settings (name, payload) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET payload = EXCLUDED.payload',
        [file, seal(file, text)]
    )
}

async function initialize(): Promise<void> {
    const client: Client = await pool.connect()
    try {
        const table = await client.query("SELECT to_regclass('public.cuttlely_server_settings') AS present")
        if (!table.rows[0].present) {
            await client.query('BEGIN')
            await client.query(`SELECT pg_advisory_xact_lock(${lockKey})`)
            const current = await client.query("SELECT to_regclass('public.cuttlely_server_settings') AS present")
            if (!current.rows[0].present) {
                await client.query('CREATE TABLE public.cuttlely_server_settings (name text PRIMARY KEY, payload bytea NOT NULL)')
                for (const file of files) {
                    const local = path.join(dir, file)
                    let text: string
                    try {
                        text = privateFiles.includes(file) ? readPrivateFile(local) : fs.readFileSync(local, 'utf8')
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
                        throw error
                    }
                    await put(client, file, text)
                }
                await put(client, marker, '1')
            }
            await client.query('COMMIT')
        }
        const record = await client.query('SELECT payload FROM public.cuttlely_server_settings WHERE name = $1', [marker])
        if (!record.rows[0] || unseal(marker, record.rows[0].payload) !== '1') throw new Error('invalid settings store')
    } finally {
        // Closing also rolls back an interrupted import or releases any locks the connection still holds.
        client.release(true)
    }
}

async function take(token: string): Promise<boolean> {
    const client: Client = await pool.connect()
    try {
        const result = await client.query(`SELECT pg_try_advisory_lock(${lockKey}) AS acquired`)
        if (!result.rows[0].acquired) {
            client.release()
            return false
        }
    } catch {
        client.release(true)
        throw new Error('settings lock failed')
    }
    const onError = () => {
        sessions.delete(token)
        client.release(true)
    }
    client.on('error', onError)
    sessions.set(token, { client, onError })
    return true
}

async function release(token: string): Promise<void> {
    const session = sessions.get(token)
    if (!session) return
    const { client, onError } = session
    sessions.delete(token)
    client.off('error', onError)
    try {
        await client.query(`SELECT pg_advisory_unlock(${lockKey})`)
        client.release()
    } catch (error) {
        client.release(true)
        throw error
    }
}

async function execute(request: SettingsRequest): Promise<unknown> {
    if (request.op === 'init') return initialize()
    if (request.op === 'take') return take(request.token)
    if (request.op === 'release') return release(request.token)
    if (!('file' in request) || !files.includes(request.file)) throw new Error('unknown settings document')
    const client = request.token ? sessions.get(request.token)?.client : pool
    if (!client) throw new Error('settings lock was lost')
    if (request.op === 'read') {
        const result = await client.query('SELECT payload FROM public.cuttlely_server_settings WHERE name = $1', [request.file])
        const payload = result.rows[0]?.payload
        return payload ? unseal(request.file, payload) : null
    }
    if (request.op === 'write') return put(client, request.file, request.text)
    await client.query('DELETE FROM public.cuttlely_server_settings WHERE name = $1', [request.file])
}

parentPort!.on('message', async ({ request, port, ready }: { request: SettingsRequest; port: MessagePort; ready: Int32Array }) => {
    try {
        port.postMessage({ result: await execute(request) })
    } catch {
        // PostgreSQL errors may contain connection details or query parameters.
        port.postMessage({ failed: true })
    } finally {
        Atomics.store(ready, 0, 1)
        Atomics.notify(ready, 0)
        port.close()
    }
})
