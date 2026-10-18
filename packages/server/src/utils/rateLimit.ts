import express, { NextFunction, Request, Response } from 'express'
import { rateLimit, RateLimitRequestHandler } from 'express-rate-limit'
import { isIP } from 'net'
import { IChatFlow, MODE } from '../Interface'
import { Mutex } from 'async-mutex'
import type Redis from 'ioredis'
import type { QueueEvents, QueueEventsListener, QueueEventsProducer } from 'bullmq'
import { runtimeNumber } from '../settings/runtime'

interface CustomListener extends QueueEventsListener {
    updateRateLimiter: (args: { limitDuration: number; limitMax: number; limitMsg: string; id: string }) => void
}

const QUEUE_NAME = 'ratelimit'
const QUEUE_EVENT_NAME = 'updateRateLimiter'

/** `203.0.113.10:54321` or `[2001:db8::1]:54321` → the address, without the port. */
function stripPort(value: string): string {
    if (value.startsWith('[')) {
        const end = value.indexOf(']')
        if (end > 1) return value.slice(1, end)
    }
    const colon = value.lastIndexOf(':')
    if (colon > 0 && value.indexOf(':') === colon) {
        const host = value.slice(0, colon)
        const port = value.slice(colon + 1)
        if (/^\d{1,5}$/.test(port) && isIP(host) === 4) return host
    }
    return value
}

function normalizeClientIp(value: string | undefined): string | undefined {
    if (!value) return undefined
    let ip = stripPort(value.trim())
    const mapped = ip.toLowerCase().startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ''
    if (mapped && isIP(mapped) === 4) ip = mapped
    return isIP(ip) ? ip : undefined
}

/**
 * Prediction rate-limit bucket for express-rate-limit.
 * `req.ip` already applied TRUST_PROXY (D51). This does not read X-Forwarded-For,
 * X-Real-IP, or Forwarded. A port or a non-IP is not its own bucket: those requests
 * count against the socket peer, so rotating a forged token cannot skip the limit.
 * A hop count still separates the addresses Express attributes to different clients.
 */
export function rateLimitClientKey(req: Request): string {
    return normalizeClientIp(req.ip) || normalizeClientIp(req.socket?.remoteAddress) || 'unknown'
}

export class RateLimiterManager {
    private rateLimiters: Map<string, RateLimitRequestHandler> = new Map()
    private rateLimiterMutex: Mutex = new Mutex()
    private redisClient: Redis
    private static instance: RateLimiterManager
    private queueEventsProducer: QueueEventsProducer
    private queueEvents: QueueEvents

    constructor() {
        if (process.env.MODE === MODE.QUEUE) {
            // Redis and BullMQ load only in queue mode.
            const Redis = require('ioredis') as typeof import('ioredis').default
            const { QueueEvents, QueueEventsProducer } = require('bullmq') as typeof import('bullmq')
            if (process.env.REDIS_URL) {
                this.redisClient = new Redis(process.env.REDIS_URL, {
                    keepAlive:
                        process.env.REDIS_KEEP_ALIVE && !isNaN(parseInt(process.env.REDIS_KEEP_ALIVE, 10))
                            ? parseInt(process.env.REDIS_KEEP_ALIVE, 10)
                            : undefined
                })
            } else {
                this.redisClient = new Redis({
                    host: process.env.REDIS_HOST || 'localhost',
                    port: parseInt(process.env.REDIS_PORT || '6379'),
                    username: process.env.REDIS_USERNAME || undefined,
                    password: process.env.REDIS_PASSWORD || undefined,
                    tls:
                        process.env.REDIS_TLS === 'true'
                            ? {
                                  cert: process.env.REDIS_CERT ? Buffer.from(process.env.REDIS_CERT, 'base64') : undefined,
                                  key: process.env.REDIS_KEY ? Buffer.from(process.env.REDIS_KEY, 'base64') : undefined,
                                  ca: process.env.REDIS_CA ? Buffer.from(process.env.REDIS_CA, 'base64') : undefined
                              }
                            : undefined,
                    keepAlive:
                        process.env.REDIS_KEEP_ALIVE && !isNaN(parseInt(process.env.REDIS_KEEP_ALIVE, 10))
                            ? parseInt(process.env.REDIS_KEEP_ALIVE, 10)
                            : undefined
                })
            }
            this.queueEventsProducer = new QueueEventsProducer(QUEUE_NAME, { connection: this.getConnection() })
            this.queueEvents = new QueueEvents(QUEUE_NAME, { connection: this.getConnection() })
        }
    }

    getConnection() {
        let tlsOpts = undefined
        if (process.env.REDIS_URL && process.env.REDIS_URL.startsWith('rediss://')) {
            tlsOpts = {
                rejectUnauthorized: false
            }
        } else if (process.env.REDIS_TLS === 'true') {
            tlsOpts = {
                cert: process.env.REDIS_CERT ? Buffer.from(process.env.REDIS_CERT, 'base64') : undefined,
                key: process.env.REDIS_KEY ? Buffer.from(process.env.REDIS_KEY, 'base64') : undefined,
                ca: process.env.REDIS_CA ? Buffer.from(process.env.REDIS_CA, 'base64') : undefined
            }
        }
        return {
            url: process.env.REDIS_URL || undefined,
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT || '6379'),
            username: process.env.REDIS_USERNAME || undefined,
            password: process.env.REDIS_PASSWORD || undefined,
            tls: tlsOpts,
            maxRetriesPerRequest: null,
            enableReadyCheck: true,
            keepAlive:
                process.env.REDIS_KEEP_ALIVE && !isNaN(parseInt(process.env.REDIS_KEEP_ALIVE, 10))
                    ? parseInt(process.env.REDIS_KEEP_ALIVE, 10)
                    : undefined
        }
    }

    public static getInstance(): RateLimiterManager {
        if (!RateLimiterManager.instance) {
            RateLimiterManager.instance = new RateLimiterManager()
        }
        return RateLimiterManager.instance
    }

    public async addRateLimiter(id: string, duration: number, limit: number, message: string): Promise<void> {
        const release = await this.rateLimiterMutex.acquire()
        try {
            if (process.env.MODE === MODE.QUEUE) {
                this.rateLimiters.set(
                    id,
                    rateLimit({
                        windowMs: duration * 1000,
                        max: limit,
                        standardHeaders: true,
                        legacyHeaders: false,
                        message,
                        keyGenerator: (req) => rateLimitClientKey(req),
                        store: new (require('rate-limit-redis') as typeof import('rate-limit-redis')).RedisStore({
                            prefix: `rl:${id}`,
                            // @ts-expect-error - Known issue: the `call` function is not present in @types/ioredis
                            sendCommand: (...args: string[]) => this.redisClient.call(...args)
                        })
                    })
                )
            } else {
                this.rateLimiters.set(
                    id,
                    rateLimit({
                        windowMs: duration * 1000,
                        max: limit,
                        message,
                        keyGenerator: (req) => rateLimitClientKey(req)
                    })
                )
            }
        } finally {
            release()
        }
    }

    public removeRateLimiter(id: string): void {
        this.rateLimiters.delete(id)
    }

    public getRateLimiter(): (req: Request, res: Response, next: NextFunction) => void {
        return (req: Request, res: Response, next: NextFunction) => {
            const id = req.params.id
            if (typeof id === 'string' && id.length > 0 && this.rateLimiters.has(id)) {
                return this.rateLimiters.get(id)!(req, res, next)
            }
            return next()
        }
    }

    public getRateLimiterById(id: string): (req: Request, res: Response, next: NextFunction) => void {
        return (req: Request, res: Response, next: NextFunction) => {
            if (this.rateLimiters.has(id)) {
                return this.rateLimiters.get(id)!(req, res, next)
            }
            return next()
        }
    }

    public async updateRateLimiter(chatFlow: IChatFlow, isInitialized?: boolean): Promise<void> {
        if (!chatFlow.apiConfig) return
        const apiConfig = JSON.parse(chatFlow.apiConfig)

        const rateLimit: { limitDuration: number; limitMax: number; limitMsg: string; status?: boolean } = apiConfig.rateLimit
        if (!rateLimit) return

        const { limitDuration, limitMax, limitMsg, status } = rateLimit

        if (!isInitialized && process.env.MODE === MODE.QUEUE && this.queueEventsProducer) {
            await this.queueEventsProducer.publishEvent({
                eventName: QUEUE_EVENT_NAME,
                limitDuration,
                limitMax,
                limitMsg,
                id: chatFlow.id
            })
        } else {
            if (status === false) {
                this.removeRateLimiter(chatFlow.id)
            } else if (limitMax && limitDuration && limitMsg) {
                await this.addRateLimiter(chatFlow.id, limitDuration, limitMax, limitMsg)
            }
        }
    }

    public async initializeRateLimiters(chatflows: IChatFlow[]): Promise<void> {
        await Promise.all(
            chatflows.map(async (chatFlow) => {
                await this.updateRateLimiter(chatFlow, true)
            })
        )

        if (process.env.MODE === MODE.QUEUE && this.queueEvents) {
            this.queueEvents.on<CustomListener>(
                QUEUE_EVENT_NAME,
                async ({
                    limitDuration,
                    limitMax,
                    limitMsg,
                    id
                }: {
                    limitDuration: number
                    limitMax: number
                    limitMsg: string
                    id: string
                }) => {
                    await this.addRateLimiter(id, limitDuration, limitMax, limitMsg)
                }
            )
        }
    }
}

/** Client routes that fall through to the UI index. A few thousand a minute is ordinary browsing, refreshes, and deep links. */
export const UI_PAGE_LIMIT_WINDOW_MS = 60 * 1000

export function uiPageLimitMax(): number {
    return runtimeNumber('CUTTLELY_UI_PAGE_LIMIT_MAX')
}

/**
 * Limiter for the UI index fallback, and for the sign-in, API-key check, OAuth, MCP server,
 * and icon routers mounted in routes/index.ts (one counter each). Success responses carry no
 * rate-limit headers, so a page load still looks like the uncounted handler. The key is the
 * same client address the prediction limiter uses.
 */
export function uiPageRateLimiter(max?: number | (() => number)) {
    return rateLimit({
        windowMs: UI_PAGE_LIMIT_WINDOW_MS,
        max: max ?? (() => uiPageLimitMax()),
        standardHeaders: false,
        legacyHeaders: false,
        keyGenerator: (req) => rateLimitClientKey(req),
        message: 'Too many requests, please try again later.'
    })
}

/** How many full cold loads of an icon catalog fit in one window on top of the page budget. */
export const UI_ICON_CATALOG_LOADS = 3

/**
 * The node palette mounts an icon request for every node on a cold load, and the credential
 * dialogs do the same for every credential, so a catalog larger than the page budget would
 * get 429s on ordinary use at a low CUTTLELY_UI_PAGE_LIMIT_MAX.
 */
export function uiIconLimitMax(catalogSize: number): number {
    const size = Number.isFinite(catalogSize) && catalogSize > 0 ? Math.ceil(catalogSize) : 0
    return uiPageLimitMax() + UI_ICON_CATALOG_LOADS * size
}

/** uiPageRateLimiter for an icon router, with its budget read from the loaded catalog on each request. */
export function uiIconRateLimiter(catalogSize: () => number) {
    return uiPageRateLimiter(() => {
        let size = 0
        try {
            size = catalogSize()
        } catch {
            size = 0
        }
        return uiIconLimitMax(size)
    })
}

/**
 * Hashed UI files. `index: false` stops a directory request from reading index.html.
 * A request for the file itself would still match, so `/` and `/index.html` skip this
 * handler and fall through to the page limiter. Directories are not redirected.
 */
export function uiAssetMiddleware(directory: string) {
    const files = express.static(directory, { index: false, redirect: false })
    return (req: Request, res: Response, next: NextFunction) => {
        if ((req.method === 'GET' || req.method === 'HEAD') && (req.path === '/' || req.path === '/index.html')) return next()
        return files(req, res, next)
    }
}
