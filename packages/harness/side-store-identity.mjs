import { createHash } from 'node:crypto'

export const queueWakeChannel = 'cuttlely_harness_queue_ready'

export function harnessSchema(scope) {
    return scope === 'queue'
        ? 'cuttlely_harness_queue'
        : 'cuttlely_session_' + createHash('sha256').update(scope).digest('hex').slice(0, 44)
}

export function harnessPgConfig(env = process.env) {
    const ssl = env.DATABASE_SSL_KEY_BASE64
        ? { ca: Buffer.from(env.DATABASE_SSL_KEY_BASE64, 'base64'), rejectUnauthorized: env.DATABASE_REJECT_UNAUTHORIZED === 'true' }
        : env.DATABASE_SSL === 'true'
    return {
        host: env.DATABASE_HOST,
        port: Number(env.DATABASE_PORT || 5432),
        database: env.DATABASE_NAME,
        user: env.DATABASE_USER,
        password: env.DATABASE_PASSWORD,
        ssl,
        application_name: 'Cuttlely side stores',
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 10000
    }
}

// Register only schemas initialized by this upgrade. The OID protects a later rollback against a replaced schema.
export async function registerSideSchema(query, schema) {
    const present = await query("SELECT to_regclass('cuttlely_storage.owned_schema') AS owned")
    if (!present.rows[0].owned) return
    await query(
        'INSERT INTO cuttlely_storage.owned_schema(name,oid) SELECT nspname,oid FROM pg_namespace WHERE nspname=$1 ON CONFLICT DO NOTHING',
        [schema]
    )
}
