export function applicationPostgresOptions(env: Record<string, string | undefined>) {
    return {
        host: env.DATABASE_HOST,
        port: parseInt(env.DATABASE_PORT || '5432'),
        user: env.DATABASE_USER,
        password: env.DATABASE_PASSWORD,
        database: env.DATABASE_NAME,
        ssl: env.DATABASE_SSL_KEY_BASE64
            ? { rejectUnauthorized: env.DATABASE_REJECT_UNAUTHORIZED === 'true', ca: Buffer.from(env.DATABASE_SSL_KEY_BASE64, 'base64') }
            : env.DATABASE_SSL === 'true' || undefined
    }
}
