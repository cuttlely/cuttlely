import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto'

/**
 * Bearer tokens presented to the API. Longer values are not keys this server issued.
 * scrypt on an unbounded header is a cheap denial of service.
 */
export const MAX_API_KEY_LENGTH = 256

/** The key from `Authorization: Bearer <key>`, or '' when the header is missing or has another shape. */
export const bearerApiKey = (authorization: unknown): string => {
    if (typeof authorization !== 'string') return ''
    const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization)
    return match ? match[1] : ''
}

/** Message for a GET that still puts the key in the URL, where proxies and browser history keep it. */
export const API_KEY_IN_URL_MESSAGE =
    'Send the API key in the Authorization header (Authorization: Bearer <key>). A key in the URL is not accepted.'

/**
 * Prefix on apikey.apiKey after the plaintext is replaced.
 * A second migration must not hash this value, and a client that sends the
 * stored column must not be treated as the bearer token.
 */
const LOOKUP_PREFIX = 'sha256:'

/**
 * Generate the api key
 * @returns {string}
 */
export const generateAPIKey = (): string => {
    const buffer = randomBytes(32)
    return buffer.toString('base64url')
}

/**
 * Generate the secret key
 * @param {string} apiKey
 * @returns {string}
 */
export const generateSecretHash = (apiKey: string): string => {
    const salt = randomBytes(8).toString('hex')
    const buffer = scryptSync(apiKey, salt, 64) as Buffer
    return `${buffer.toString('hex')}.${salt}`
}

/**
 * scrypt check that does not throw on a malformed stored secret.
 * @param {string} storedKey
 * @param {string} suppliedKey
 * @returns {boolean}
 */
export const secretMatches = (storedKey: string, suppliedKey: string): boolean => {
    if (!storedKey || !suppliedKey || !storedKey.includes('.')) return false
    const [hashedPassword, salt] = storedKey.split('.')
    if (!hashedPassword || !salt || !/^[0-9a-f]+$/i.test(hashedPassword) || !/^[0-9a-f]+$/i.test(salt)) return false
    try {
        const buffer = scryptSync(suppliedKey, salt, 64) as Buffer
        const stored = Buffer.from(hashedPassword, 'hex')
        if (stored.length !== buffer.length) return false
        return timingSafeEqual(stored, buffer)
    } catch {
        return false
    }
}

/**
 * Verify valid keys
 * @param {string} storedKey
 * @param {string} suppliedKey
 * @returns {boolean}
 */
export const compareKeys = (storedKey: string, suppliedKey: string): boolean => {
    return secretMatches(storedKey, suppliedKey)
}

/** Lookup column value for a bearer token. Not the scrypt verifier. */
export const storedApiKeyLookup = (apiKey: string): string => {
    const digest = createHash('sha256').update(apiKey, 'utf8').digest('hex')
    return `${LOOKUP_PREFIX}${digest}`
}

export const isStoredApiKeyLookup = (stored: string): boolean => {
    return typeof stored === 'string' && /^sha256:[0-9a-f]{64}$/.test(stored)
}

export type ApiKeyRewritePlan = { action: 'skip' } | { action: 'replace'; lookup: string }

/**
 * Plaintext rows are replaced. Rows that already hold a lookup digest are left alone.
 * An empty value is not a key. The scrypt secret is not an input: a row whose
 * secret does not match is still rewritten so the plaintext does not stay.
 */
export const planApiKeyRewrite = (stored: string | null | undefined): ApiKeyRewritePlan => {
    if (!stored) return { action: 'skip' }
    if (isStoredApiKeyLookup(stored)) return { action: 'skip' }
    return { action: 'replace', lookup: storedApiKeyLookup(stored) }
}

export type StoredApiKeyRow = { id: string; apiKey: string; apiSecret: string }

export type StoredApiKeyAuth =
    | { status: 'absent' }
    | { status: 'accept' }
    | { status: 'reject' }
    | { status: 'accept-rewrite'; lookup: string }
    | { status: 'reject-rewrite'; lookup: string }

/**
 * lookup: the column is already sha256:<digest of the bearer>.
 * legacy: the column still holds the bearer. Rewrite it after the check.
 * A bearer that equals the stored digest is rejected and not rewritten.
 */
export const decideStoredApiKeyAuth = (
    row: StoredApiKeyRow | null | undefined,
    suppliedKey: string,
    mode: 'lookup' | 'legacy'
): StoredApiKeyAuth => {
    if (!row) return { status: 'absent' }
    if (mode === 'lookup') {
        if (row.apiKey !== storedApiKeyLookup(suppliedKey)) return { status: 'reject' }
        if (!secretMatches(row.apiSecret, suppliedKey)) return { status: 'reject' }
        return { status: 'accept' }
    }
    if (row.apiKey !== suppliedKey) return { status: 'reject' }
    if (isStoredApiKeyLookup(row.apiKey)) return { status: 'reject' }
    const lookup = storedApiKeyLookup(suppliedKey)
    if (!secretMatches(row.apiSecret, suppliedKey)) return { status: 'reject-rewrite', lookup }
    return { status: 'accept-rewrite', lookup }
}

type SqlRunner = {
    connection: { options: { type?: string } }
    query: (sql: string, parameters?: unknown[]) => Promise<unknown>
}

function quoteIdent(db: string, name: string): string {
    if (db === 'mysql' || db === 'mariadb') return `\`${name}\``
    return `"${name}"`
}

function rowField(row: Record<string, unknown>, name: string): string {
    if (row[name] != null) return String(row[name])
    const match = Object.keys(row).find((key) => key.toLowerCase() === name.toLowerCase())
    if (match == null || row[match] == null) return ''
    return String(row[match])
}

/**
 * Replace plaintext apikey.apiKey values with a sha256 lookup. apiSecret is unchanged.
 * Safe to run again: a stored lookup is skipped, so the digest is not hashed twice.
 */
export const rewritePlaintextApiKeys = async (queryRunner: SqlRunner): Promise<{ rewritten: number; skipped: number }> => {
    const db = String(queryRunner.connection.options.type || 'sqlite')
    const table = quoteIdent(db, 'apikey')
    const idCol = quoteIdent(db, 'id')
    const keyCol = quoteIdent(db, 'apiKey')
    const updatedCol = quoteIdent(db, 'updatedDate')
    const rows = (await queryRunner.query(`SELECT ${idCol} AS id, ${keyCol} AS storedkey FROM ${table}`)) as Record<string, unknown>[]
    const list = Array.isArray(rows) ? rows : []
    let rewritten = 0
    let skipped = 0
    const ph = (index: number) => (db === 'postgres' ? `$${index}` : '?')
    for (const row of list) {
        const id = rowField(row, 'id')
        const stored = rowField(row, 'storedkey')
        const plan = planApiKeyRewrite(stored)
        if (plan.action === 'skip') {
            skipped += 1
            continue
        }
        await queryRunner.query(
            `UPDATE ${table} SET ${keyCol} = ${ph(1)}, ${updatedCol} = ${updatedCol} WHERE ${idCol} = ${ph(2)} AND ${keyCol} = ${ph(3)}`,
            [plan.lookup, id, stored]
        )
        rewritten += 1
    }
    return { rewritten, skipped }
}
