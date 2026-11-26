// The runtime reuses its SQLite schema and commits changed blocks to PostgreSQL before acknowledging a write.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { registerSideSchema } from '../harness/side-store-identity.mjs'
import { hermesHome, vendoredHermesDir } from '../harness/paths.mjs'

export const runtimeTables = ['cuttlely_runtime.runtime_settings', 'cuttlely_runtime.session_blocks', 'cuttlely_runtime.session_heads']

export async function initializeRuntimeSessions(source, local, config) {
    await source.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('cuttlely_runtime.session_heads'))")
        const [{ present }] = await tx.query(
            'SELECT count(*)::int AS present FROM unnest($1::text[]) AS t(name) WHERE to_regclass(name) IS NOT NULL',
            [runtimeTables]
        )
        if (present && present !== runtimeTables.length)
            throw new Error('Restore the complete PostgreSQL runtime schema before continuing.')
        await tx.query('CREATE SCHEMA IF NOT EXISTS cuttlely_runtime')
        await registerSideSchema(async (sql, params) => ({ rows: await tx.query(sql, params) }), 'cuttlely_runtime')
        await tx.query('CREATE TABLE IF NOT EXISTS cuttlely_runtime.runtime_settings(scope text PRIMARY KEY, payload bytea NOT NULL)')
        await tx.query(
            'CREATE TABLE IF NOT EXISTS cuttlely_runtime.session_heads(scope text PRIMARY KEY, revision text NOT NULL, digest bytea NOT NULL)'
        )
        await tx.query(
            'CREATE TABLE IF NOT EXISTS cuttlely_runtime.session_blocks(scope text NOT NULL, seq integer NOT NULL, digest bytea NOT NULL, payload bytea NOT NULL, PRIMARY KEY(scope,seq))'
        )
    })
    const rows = await source.query(
        'SELECT scope FROM cuttlely_runtime.session_heads UNION ALL SELECT scope FROM cuttlely_runtime.runtime_settings'
    )
    const scopes = [...new Set([...local.map((name) => name.replace(/^profile\//, 'profiles/')), ...rows.map(({ scope }) => scope)])]
    if (!scopes.length) return
    const bundled = path.join(vendoredHermesDir(), '.venv', 'bin', 'python')
    const python = process.env.HERMES_PYTHON || (fs.existsSync(bundled) ? bundled : 'python3')
    const child = spawn(python, [path.join(vendoredHermesDir(), 'cuttlely_session_store.py'), hermesHome()], {
        env: {
            ...process.env,
            DATABASE_HOST: config.host,
            DATABASE_PORT: String(config.port || 5432),
            DATABASE_NAME: config.database,
            DATABASE_USER: config.user,
            DATABASE_PASSWORD: config.password || ''
        },
        stdio: ['pipe', 'ignore', 'pipe']
    })
    const exited = once(child, 'close')
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(scopes))
    if ((await exited)[0] !== 0)
        throw new Error('Runtime session recovery failed. Verify the runtime, PostgreSQL connection and installation key.')
}
