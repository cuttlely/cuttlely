import { NextFunction, Request, Response } from 'express'
import { StorageProviderFactory } from 'flowise-components'
import * as fs from 'fs'
import { createLogger, format, transports } from 'winston'
import config from './config' // should be replaced by node-config or similar
import { isServerSettingsUrl } from '../settings/redact'

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

// Always redacted in a debug request body. `token` is the GitHub token sent when connecting version history.
const SESSION_LOG_FIELDS = new Set(['chatid', 'sessionid', 'sessiontoken', 'token'])

/** Drop client session ids, session tokens, and API keys in the path before a request line is written. */
export function redactLoggedUrl(url: string): string {
    return url
        .replace(/([?&](?:chatId|sessionId|sessionToken)=)[^&#]*/gi, '$1[redacted]')
        .replace(/(\/api\/v1\/(?:chatflows|verify)\/apikey\/)[^/?#]*/gi, '$1[redacted]')
}

function sanitizeObject(obj: any): any {
    if (!obj || typeof obj !== 'object') return obj

    const sensitiveFields = getSensitiveBodyFields()
    const sanitized = Array.isArray(obj) ? [...obj] : { ...obj }
    Object.keys(sanitized).forEach((key) => {
        const lowerKey = key.toLowerCase()
        if (sensitiveFields.includes(lowerKey) || SESSION_LOG_FIELDS.has(lowerKey)) {
            sanitized[key] = '[redacted]'
        } else if (lowerKey === 'overrideconfig' && sanitized[key] && typeof sanitized[key] === 'object') {
            sanitized[key] = sanitizeObject(sanitized[key])
        } else if (typeof sanitized[key] === 'string') {
            if (sanitized[key].includes('@') && sanitized[key].includes('.')) {
                sanitized[key] = sanitized[key].replace(/([^@\s]+)@([^@\s]+)/g, '**********')
            }
        }
    })

    return sanitized
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
            const sanitizedQuery = sanitizeObject(req.query)
            const sanitizedHeaders = { ...req.headers }

            const sensitiveHeaders = getSensitiveHeaderFields()
            sensitiveHeaders.forEach((header) => {
                if (sanitizedHeaders[header]) {
                    sanitizedHeaders[header] = '********'
                }
            })
            if (sanitizedHeaders['x-cuttlely-session-token']) sanitizedHeaders['x-cuttlely-session-token'] = '[redacted]'
            if (typeof sanitizedHeaders.cookie === 'string') {
                sanitizedHeaders.cookie = sanitizedHeaders.cookie.replace(/cuttlely_session=[^;]*/gi, 'cuttlely_session=[redacted]')
            }

            // Server settings bodies can hold secrets (database password, API keys). Never log them, even at debug.
            requestMetadata.request.body = isServerSettingsUrl(req.url) ? '[redacted]' : sanitizedBody
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
        if (req.method !== 'GET') {
            requestLogger.info(`${getRequestEmoji(req.method)} ${req.method} ${loggedUrl}`)
            logger.info(`${getRequestEmoji(req.method)} ${req.method} ${loggedUrl}`)
        } else {
            requestLogger.http(`${getRequestEmoji(req.method)} ${req.method} ${loggedUrl}`)
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
