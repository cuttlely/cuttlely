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
    'email'
])
const REDACTED_QUERY_NAMES = new Set(['chatid', 'sessionid', 'sessiontoken', 'token', 'q', 'cursor'])

function decodeQueryName(raw: string): string {
    try {
        return decodeURIComponent(raw.replace(/\+/g, ' '))
    } catch {
        return raw
    }
}

// q[]= and q[0]= keep the search when only the exact name q= is redacted. %71= is q after decoding.
function isRedactedQueryName(raw: string): boolean {
    const name = decodeQueryName(raw).toLowerCase()
    if (REDACTED_QUERY_NAMES.has(name)) return true
    return name.startsWith('q[') || name.startsWith('cursor[')
}

function redactQueryString(query: string): string {
    return query
        .split('&')
        .map((part) => {
            if (!part) return part
            const eq = part.indexOf('=')
            if (eq === -1) return part
            const rawName = part.slice(0, eq)
            if (!isRedactedQueryName(rawName)) return part
            return `${rawName}=[redacted]`
        })
        .join('&')
}

function redactFragment(hash: string): string {
    return hash.replace(/(token=)[^&#]*/gi, '$1[redacted]')
}

/** Drop client session ids, session tokens, searches, page cursors, and API keys before a request line is written. */
export function redactLoggedUrl(url: string): string {
    const hashAt = url.indexOf('#')
    const hash = hashAt === -1 ? '' : redactFragment(url.slice(hashAt))
    const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt)
    const queryAt = beforeHash.indexOf('?')
    const path = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt)
    const redactedPath = path.replace(/(\/api\/v1\/(?:chatflows|verify)\/apikey\/)[^/]*/gi, '$1[redacted]')
    if (queryAt === -1) return redactedPath + hash
    return `${redactedPath}?${redactQueryString(beforeHash.slice(queryAt + 1))}${hash}`
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

// Session cookies, the sealed AuthKit session, and the one-time invite token. Names are matched without letter case.
const REDACTED_COOKIES = /(^|;\s*)(cuttlely_session|cuttlely-local-session|cuttlely-invite|wos-session)=[^;]*/gi

export function redactLoggedCookies(header: string): string {
    return header.replace(REDACTED_COOKIES, (_match, lead: string, name: string) => `${lead}${name}=[redacted]`)
}

export function expressRequestLogger(req: Request, res: Response, next: NextFunction): void {
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
            const sanitizedHeaders = { ...req.headers }

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

        const getRequestEmoji = (method: string) => {
            const requetsEmojis: Record<string, string> = {
                GET: '⬇️',
                POST: '⬆️',
                PUT: '🖊',
                DELETE: '❌',
                OPTION: '🔗'
            }

            return requetsEmojis[method] || '?'
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
