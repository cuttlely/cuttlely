// Switch database: page logic.

/** The values the server gets: the choice, and for Postgres the fields (a blank password keeps the saved one). */
export function switchValues(type, form) {
    if (type === 'sqlite') return { DATABASE_TYPE: 'sqlite' }
    return {
        DATABASE_TYPE: 'postgres',
        DATABASE_HOST: form.DATABASE_HOST.trim(),
        DATABASE_PORT: String(form.DATABASE_PORT).trim() || '5432',
        DATABASE_NAME: form.DATABASE_NAME.trim(),
        DATABASE_USER: form.DATABASE_USER.trim(),
        DATABASE_PASSWORD: form.DATABASE_PASSWORD,
        DATABASE_SSL: form.DATABASE_SSL === 'true' ? 'true' : 'false'
    }
}
