// Decide which Postgres URL the PostgreSQL MCP node may open.
// The application database (DATABASE_*) is never a fallback. A URL that is
// that database is refused, whether it came from a credential or from
// CUTTLELY_POSTGRES_URL.

const APP_DATABASE_ERROR =
    'PostgreSQL MCP cannot use the application database. Point CUTTLELY_POSTGRES_URL or the Postgres URL credential at a separate database.'
const UNCHECKED_URL_ERROR = 'PostgreSQL MCP refused a database URL it could not check against the application database.'

function clean(value) {
    return typeof value === 'string' ? value.trim() : ''
}

function parseUri(text) {
    let url
    try {
        url = new URL(text)
    } catch {
        return null
    }
    const protocol = url.protocol.toLowerCase()
    if (protocol !== 'postgres:' && protocol !== 'postgresql:') return null
    let database = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
    try {
        database = decodeURIComponent(database).toLowerCase()
    } catch {
        return null
    }
    return {
        host: url.hostname.toLowerCase(),
        port: url.port || '5432',
        database,
        user: url.username || '',
        password: url.password || ''
    }
}

function parseKeywords(text) {
    if (/^(postgres|postgresql):\/\//i.test(text)) return null
    const fields = {}
    // The lookbehind starts a keyword only at the start of a word, so a long run with no `=` is scanned once.
    const pattern = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]*)=(?:'([^']*)'|"([^"]*)"|(\S+))/g
    let match = pattern.exec(text)
    let found = false
    while (match) {
        found = true
        fields[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? ''
        match = pattern.exec(text)
    }
    if (!found || (!fields.host && !fields.dbname && !fields.database)) return null
    return {
        host: (fields.host || '').replace(/^\[|\]$/g, '').toLowerCase(),
        port: fields.port || '5432',
        database: (fields.dbname || fields.database || '').toLowerCase(),
        user: fields.user || fields.username || '',
        password: fields.password || ''
    }
}

export function parseAnalystTarget(text) {
    const value = clean(text)
    if (!value) return null
    return parseUri(value) || parseKeywords(value)
}

function applicationPort(raw) {
    if (raw === '') return '5432'
    return /^\d+$/.test(raw) ? String(parseInt(raw, 10)) : raw
}

export function applicationDatabaseTarget(env) {
    const source = env || {}
    if (clean(source.DATABASE_TYPE).toLowerCase() !== 'postgres') return null
    const host = clean(source.DATABASE_HOST)
        .toLowerCase()
        .replace(/^\[|\]$/g, '')
    const database = clean(source.DATABASE_NAME).toLowerCase()
    if (!host && !database) return null
    return {
        host,
        port: applicationPort(clean(source.DATABASE_PORT)),
        database,
        user: clean(source.DATABASE_USER),
        password: typeof source.DATABASE_PASSWORD === 'string' ? source.DATABASE_PASSWORD : ''
    }
}

function sameApplicationDatabase(target, app) {
    const sameDatabase = app.database && target.database && app.database === target.database
    const sameHost = app.host && target.host && app.host === target.host && app.port === target.port
    if (sameHost && sameDatabase) return true
    const sameUser = app.user && target.user && app.user.toLowerCase() === target.user.toLowerCase()
    const samePassword = app.password !== '' && target.password !== '' && app.password === target.password
    return Boolean(sameUser && samePassword && sameDatabase)
}

export function resolveAnalystPostgresUrl({ credentialUrl, analystUrl, env = process.env } = {}) {
    const postgresUrl = clean(credentialUrl) || clean(analystUrl)
    if (!postgresUrl) throw new Error('No postgres url provided')

    const app = applicationDatabaseTarget(env)
    if (!app) return postgresUrl

    const target = parseAnalystTarget(postgresUrl)
    if (!target) throw new Error(UNCHECKED_URL_ERROR)
    if (sameApplicationDatabase(target, app)) throw new Error(APP_DATABASE_ERROR)
    return postgresUrl
}

// CUTTLELY_ANALYST=auto is the only on switch. Anything else leaves auto storage off.
export function analystModeEnabled(env = process.env) {
    return clean((env || {}).CUTTLELY_ANALYST).toLowerCase() === 'auto'
}

// Credential, then CUTTLELY_POSTGRES_URL, then auto storage. An explicit URL that
// is the application database is refused and does not fall through to auto.
export function resolveAnalystConnection({ credentialUrl, analystUrl, env = process.env } = {}) {
    const credential = clean(credentialUrl)
    const explicit = clean(analystUrl)
    if (credential || explicit) {
        return {
            kind: 'url',
            postgresUrl: resolveAnalystPostgresUrl({ credentialUrl: credential, analystUrl: explicit, env })
        }
    }
    if (analystModeEnabled(env)) return { kind: 'auto' }
    throw new Error('No postgres url provided')
}
