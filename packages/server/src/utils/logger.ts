import { NextFunction, Request, Response } from 'express'
import { StorageProviderFactory } from '@cuttlely/components'
import * as fs from 'fs'
import { createLogger, format, transports } from 'winston'
import config from './config' // should be replaced by node-config or similar
import { isServerSettingsUrl } from '../settings/redact'

const isExternalAgentLogUrl = (url: string): boolean => {
    const lower = url.toLowerCase()
    return lower.includes('/api/v1/a2a/') || lower.includes('/api/v1/orchestrate/')
}

const { combine, timestamp, printf, errors } = format

let requestLogger: any

const provider = StorageProviderFactory.getProvider()
const serverTransports = provider.getLoggerTransports('server', config)
const errorTransports = provider.getLoggerTransports('error', config)
const requestTransports = provider.getLoggerTransports('requests', config)
const auditTransports = provider.getLoggerTransports('audit', config)

// expect the log dir be relative to the projects root
const logDir = config.logging.dir

// Create the log directory if it doesn't exist
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir)
}

const logger = createLogger({
    format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.json(),
        printf(({ level, message, timestamp, stack }) => {
            const text = `${timestamp} [${level.toUpperCase()}]: ${message}`
            return stack ? text + '\n' + stack : text
        }),
        errors({ stack: true })
    ),
    defaultMeta: {
        package: 'server'
    },
    exitOnError: false,
    transports: [new transports.Console(), ...serverTransports],
    exceptionHandlers: [...(process.env.DEBUG && process.env.DEBUG === 'true' ? [new transports.Console()] : []), ...errorTransports],
    rejectionHandlers: [
        ...(process.env.DEBUG && process.env.DEBUG === 'true' ? [new transports.Console()] : []),
        ...errorTransports,
        // Always provide a fallback rejection handler when no other handlers are configured
        ...((!process.env.DEBUG || process.env.DEBUG !== 'true') && errorTransports.length === 0 ? [new transports.Console()] : [])
    ]
})

requestLogger = createLogger({
    format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), format.json(), errors({ stack: true })),
    defaultMeta: {
        package: 'server'
    },
    transports: [...(process.env.DEBUG && process.env.DEBUG === 'true' ? [new transports.Console()] : []), ...requestTransports]
})

function getSensitiveBodyFields(): string[] {
    if (!process.env.LOG_SANITIZE_BODY_FIELDS) return []
    return (process.env.LOG_SANITIZE_BODY_FIELDS as string)
        .toLowerCase()
        .split(',')
        .map((f) => f.trim())
}

function getSensitiveHeaderFields(): string[] {
    if (!process.env.LOG_SANITIZE_HEADER_FIELDS) return []
    return (process.env.LOG_SANITIZE_HEADER_FIELDS as string)
        .toLowerCase()
        .split(',')
        .map((f) => f.trim())
}

// Always redacted in a debug request body. The key match is case-insensitive. `token` is the GitHub token sent when connecting version history.
const SESSION_LOG_FIELDS = new Set([
    'chatid',
    'sessionid',
    'sessiontoken',
    'token',
    'password',
    'currentpassword',
    'newpassword',
    'credential',
    'setupcode',
    'code',
    'email'
])
const REDACTED_QUERY_NAMES = new Set(['chatid', 'sessionid', 'sessiontoken', 'token', 'code', 'setupcode', 'q', 'cursor'])
const MAX_NAME_DECODES = 16
const PARAM_DELIMS = new Set(['?', '#', '&', ';', ' ', '\t', '\n', '\r'])

/** Percent-decode a name until it stops changing. Rounds are capped. */
function fullyDecodeName(raw: string): string {
    let current = raw
    for (let i = 0; i < MAX_NAME_DECODES; i++) {
        let next: string
        try {
            next = decodeURIComponent(current.replace(/\+/g, ' '))
        } catch {
            return current
        }
        if (next === current) return current
        current = next
    }
    return current
}

// q[]= and q[0]= keep the search when only the exact name q= is redacted. Names are matched after full decoding.
function isRedactedQueryName(raw: string): boolean {
    const name = fullyDecodeName(raw).toLowerCase()
    if (REDACTED_QUERY_NAMES.has(name)) return true
    return name.startsWith('q[') || name.startsWith('cursor[')
}

function redactApiKeyPath(value: string): string {
    return value.replace(/(\/api\/v1\/(?:chatflows|verify)\/apikey\/)[^/?#]*/gi, '$1[redacted]')
}

/** Mask sensitive parameter values. The name is matched after it is fully percent-decoded. */
function redactAssignments(value: string): string {
    let out = ''
    let i = 0
    while (i < value.length) {
        const boundary = i === 0 || PARAM_DELIMS.has(value.charAt(i - 1))
        if (!boundary) {
            out += value.charAt(i)
            i += 1
            continue
        }
        let endName = i
        while (endName < value.length && value.charAt(endName) !== '=' && !PARAM_DELIMS.has(value.charAt(endName))) endName += 1
        if (endName >= value.length || value.charAt(endName) !== '=') {
            out += value.charAt(i)
            i += 1
            continue
        }
        const rawName = value.slice(i, endName)
        let endValue = endName + 1
        while (endValue < value.length && !PARAM_DELIMS.has(value.charAt(endValue))) endValue += 1
        if (rawName && isRedactedQueryName(rawName)) out += `${rawName}=[redacted]`
        else out += value.slice(i, endValue)
        i = endValue
    }
    return out
}

/** Drop client session ids, session tokens, searches, page cursors, and API keys before a request line is written. */
export function redactLoggedUrl(url: string): string {
    return redactAssignments(redactApiKeyPath(url))
}

/** Masks setup codes and tokens in any header value that can carry a URL, a query, or a bare name=value. */
export function redactLoggedHeaderValue(value: unknown): unknown {
    if (typeof value === 'string') return redactLoggedUrl(value)
    if (Array.isArray(value)) return value.map((item) => redactLoggedHeaderValue(item))
    return value
}

// A debug query value is untrusted. Two open-ended groups in a regex are polynomial on a long
// repeated string, so email-like text is masked with one left-to-right pass, and a longer value
// is replaced whole.
const EMAIL_LOG_MASK = '**********'
const EMAIL_LOG_LIMIT = 512

function isEmailAtom(ch: string): boolean {
    if (ch === '@') return false
    const code = ch.charCodeAt(0)
    if (code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32) return false
    if (code === 0x00a0 || code === 0x1680 || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f) return false
    if (code === 0x3000 || code === 0xfeff) return false
    if (code >= 0x2000 && code <= 0x200a) return false
    return true
}

function maskEmailLike(value: string): string {
    if (!value.includes('@') || !value.includes('.')) return value
    if (value.length > EMAIL_LOG_LIMIT) return EMAIL_LOG_MASK
    let out = ''
    let i = 0
    while (i < value.length) {
        const at = value.indexOf('@', i)
        if (at === -1) {
            out += value.slice(i)
            break
        }
        let local = at
        while (local > i && isEmailAtom(value.charAt(local - 1))) local -= 1
        let domain = at + 1
        while (domain < value.length && isEmailAtom(value.charAt(domain))) domain += 1
        if (local < at && domain > at + 1) {
            out += value.slice(i, local) + EMAIL_LOG_MASK
            i = domain
        } else {
            out += value.slice(i, at + 1)
            i = at + 1
        }
    }
    return out
}

function sanitizeObject(obj: any): any {
    if (!obj || typeof obj !== 'object') return obj

    const sensitiveFields = getSensitiveBodyFields()
    const sanitized = Array.isArray(obj) ? [...obj] : { ...obj }
    Object.keys(sanitized).forEach((key) => {
        const lowerKey = key.toLowerCase()
        if (sensitiveFields.includes(lowerKey) || SESSION_LOG_FIELDS.has(lowerKey)) {
            sanitized[key] = '[redacted]'
        } else if (sanitized[key] && typeof sanitized[key] === 'object') {
            sanitized[key] = sanitizeObject(sanitized[key])
        } else if (typeof sanitized[key] === 'string') {
            sanitized[key] = maskEmailLike(sanitized[key])
        }
    })

    return sanitized
}

function redactLoggedQuery(query: any): any {
    const sanitized = sanitizeObject(query)
    if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return sanitized
    for (const key of Object.keys(sanitized)) {
        if (isRedactedQueryName(key)) sanitized[key] = '[redacted]'
    }
    return sanitized
}

// Session cookies, the sealed AuthKit session, the one-time invite token, and setup-code names.
// Names are matched without letter case, after the same percent-decoding used for query names.
const REDACTED_COOKIE_NAMES = new Set([
    'cuttlely_session',
    'cuttlely-local-session',
    'cuttlely-invite',
    'cuttlely-oidc-browser',
    'cuttlely-setup',
    'wos-session',
    'code',
    'setupcode',
    'token'
])

export function redactLoggedCookies(header: string): string {
    return header
        .split(';')
        .map((part) => {
            const eq = part.indexOf('=')
            if (eq === -1) return part
            const rawLeft = part.slice(0, eq)
            const leadLen = rawLeft.length - rawLeft.trimStart().length
            const name = rawLeft.slice(leadLen)
            if (!name || !REDACTED_COOKIE_NAMES.has(fullyDecodeName(name).toLowerCase())) return part
            return `${rawLeft.slice(0, leadLen)}${name}=[redacted]`
        })
        .join(';')
}

function requestPath(url: string): string {
    const hashAt = url.indexOf('#')
    const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt)
    const queryAt = beforeHash.indexOf('?')
    return queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt)
}

/** First-run setup and owner routes. Their logs keep method, path, and status only. */
function isFirstRunSetupLog(url: string): boolean {
    const path = requestPath(url).replace(/\/+$/, '') || '/'
    const lower = path.toLowerCase()
    if (lower === '/api/v1/account/register') return true
    if (lower === '/organization-setup' || lower === '/server-setup' || lower === '/setup') return true
    return lower === '/api/v1/server-setup' || lower.startsWith('/api/v1/server-setup/')
}

function getRequestEmoji(method: string): string {
    const requetsEmojis: Record<string, string> = {
        GET: '⬇️',
        POST: '⬆️',
        PUT: '🖊',
        DELETE: '❌',
        OPTION: '🔗'
    }
    return requetsEmojis[method] || '?'
}

export function expressRequestLogger(req: Request, res: Response, next: NextFunction): void {
    const rawUrl = req.originalUrl || req.url || ''
    if (isFirstRunSetupLog(rawUrl)) {
        const pathOnly = requestPath(rawUrl)
        const write = () => {
            const line = `${getRequestEmoji(req.method)} ${req.method} ${pathOnly} ${res.statusCode}`
            requestLogger.info(line)
            logger.info(line)
        }
        if (typeof res?.on === 'function') res.on('finish', write)
        next()
        return
    }

    const unwantedLogURLs = ['/api/v1/node-icon/', '/api/v1/components-credentials-icon/', '/api/v1/ping']

    if (/\/api\/v1\//i.test(req.url) && !unwantedLogURLs.some((url) => new RegExp(url, 'i').test(req.url))) {
        const isDebugLevel = logger.level === 'debug' || process.env.DEBUG === 'true'

        const requestMetadata: any = {
            request: {
                method: req.method,
                url: redactLoggedUrl(req.url),
                params: req.params
            }
        }

        // Only include headers, body, and query if log level is debug
        if (isDebugLevel) {
            const sanitizedBody = sanitizeObject(req.body)
            const sanitizedQuery = redactLoggedQuery(req.query)
            const sanitizedHeaders: Record<string, unknown> = {}
            for (const [name, value] of Object.entries(req.headers)) {
                sanitizedHeaders[name] = name === 'cookie' ? value : redactLoggedHeaderValue(value)
            }

            const sensitiveHeaders = getSensitiveHeaderFields()
            sensitiveHeaders.forEach((header) => {
                if (sanitizedHeaders[header]) {
                    sanitizedHeaders[header] = '********'
                }
            })
            if (sanitizedHeaders['x-cuttlely-session-token']) sanitizedHeaders['x-cuttlely-session-token'] = '[redacted]'
            if (sanitizedHeaders.authorization) sanitizedHeaders.authorization = '[redacted]'
            if (sanitizedHeaders['x-api-key']) sanitizedHeaders['x-api-key'] = '[redacted]'
            if (sanitizedHeaders['x-ibm-thread-id']) sanitizedHeaders['x-ibm-thread-id'] = '[redacted]'
            if (typeof sanitizedHeaders.cookie === 'string') sanitizedHeaders.cookie = redactLoggedCookies(sanitizedHeaders.cookie)

            // Server settings bodies can hold secrets (database password, API keys). Never log them, even at debug.
            // Orchestrate and A2A bodies hold question text and raw context ids.
            requestMetadata.request.body = isServerSettingsUrl(req.url) || isExternalAgentLogUrl(req.url) ? '[redacted]' : sanitizedBody
            requestMetadata.request.query = sanitizedQuery
            requestMetadata.request.headers = sanitizedHeaders
        }

        const loggedUrl = redactLoggedUrl(req.url)
        const line = `${getRequestEmoji(req.method)} ${req.method} ${loggedUrl}`
        // The debug record is the only line that copies req.query. q and cursor are already redacted there.
        if (req.method !== 'GET') {
            if (isDebugLevel) {
                requestLogger.info(line, requestMetadata)
                logger.info(line, requestMetadata)
            } else {
                requestLogger.info(line)
                logger.info(line)
            }
        } else if (isDebugLevel) {
            requestLogger.http(line, requestMetadata)
        } else {
            requestLogger.http(line)
        }
    }

    next()
}

export const auditLogger = createLogger({
    format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), format.json(), errors({ stack: true })),
    defaultMeta: { package: 'server' },
    exitOnError: false,
    transports: [...(process.env.DEBUG === 'true' ? [new transports.Console()] : []), ...auditTransports]
})

export default logger
