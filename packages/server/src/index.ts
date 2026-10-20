import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { Request, Response } from 'express'
import 'global-agent/bootstrap'
import http from 'http'
import { DataSource } from 'typeorm'
import { AbortControllerPool } from './AbortControllerPool'
import { CachePool } from './CachePool'
import { ChatFlow } from './database/entities/ChatFlow'
import { getDataSource } from './DataSource'
import { initAuthSecrets } from './identity/authSecrets'
import { applyAuthKitSwitchOnBoot } from './identity/production'
import { localAdminEnabled } from './identity/constants'
import { ossIdentity, OssIdentity } from './identity/ossPlatform'
import type { LoggedInUser } from './identity/types'
import { MODE, Platform } from './Interface'
import { IMetricsProvider } from './Interface.Metrics'
import { OpenTelemetry } from './metrics/OpenTelemetry'
import { Prometheus } from './metrics/Prometheus'
import { registerCuttlelyTraces, shutdownCuttlelyTraces } from './metrics/tracing'
import errorHandlerMiddleware from './middlewares/errors'
import { NodesPool } from './NodesPool'
import type { QueueManager } from './queue/QueueManager'
import { ScheduleBeat } from './schedule/ScheduleBeat'
import { RedisEventSubscriber } from './queue/RedisEventSubscriber'
import { initWebhookListenerRegistry } from './services/webhook-listener'
import harnessesService from './services/harnesses'
import { startHarnessSchedulerIfReady, stopHarnessScheduler } from './services/harnesses/schedules'
import { warnKeysMissingBoundHarnesses } from './services/harnesses/apiAccess'
import etlService from './services/etl'
import flowVersionsService from './services/flow-versions'
import flowiseApiV1Router from './routes'
import { orchestrateContentTypeGuard, orchestrateJsonParser } from './routes/orchestrate'
import { a2aBodyErrorHandler, a2aContentTypeGuard, a2aJsonParser, assertA2aPublicBaseUrl } from './routes/a2a'
import { mcpJsonParser, unlessExternalJson, whenMcpEndpoint } from './utils/externalJsonLimit'
import { attachIdentitySession } from './identity'
import { apiV1Auth, isMcpEndpointPath, withoutDenylisted } from './identity/apiGate'
import { sendMcpMethodNotAllowed } from './routes/mcp-endpoint/http'
import { resolveTrustProxy } from './utils/trustProxy'
import { UsageCacheManager } from './UsageCacheManager'
import { getEncryptionKey, getNodeModulesPackagePath } from './utils'
import { fileSizeLimit } from './settings/settingAlias'
import { API_KEY_BLACKLIST_URLS, READ_ONLY_WHITELIST_URLS, WHITELIST_URLS } from './utils/constants'
import logger, { expressRequestLogger } from './utils/logger'
import { RateLimiterManager, uiAssetMiddleware, uiPageRateLimiter } from './utils/rateLimit'
import { chatWidgetScript } from './utils/chatWidget'
import { resolveUiBuild } from './utils/uiBuild'
import { SSEStreamer } from './utils/SSEStreamer'
import { Telemetry } from './utils/telemetry'
import { validateAPIKey } from './utils/validateKey'
import { getCorsOptions, getIframeSecurityHeaders, sanitizeMiddleware, validateCorsConfig } from './utils/XSS'
import { identityStore } from './identity/production'
import { announceFirstRunSetup } from './identity/setupCode'
import { readyBanner, setBootStep, startStartingPage } from './startup/startingPage'
import { DatabaseHealth, databaseWhere, setDatabaseHealth } from './startup/databaseHealth'
import { drainTimeoutMs, refuseWhileShuttingDown, shutdownDrain } from './settings/runs'
import { logUnsupportedFlowiseUpgrade, runSupportedMigrations } from './startup/flowiseUpgradeGuard'

declare global {
    namespace Express {
        interface User extends LoggedInUser {}
        interface Request {
            user?: LoggedInUser
            orchestrate?: unknown
        }
        namespace Multer {
            interface File {
                bucket: string
                key: string
                acl: string
                contentType: string
                contentDisposition: null
                storageClass: string
                serverSideEncryption: null
                metadata: any
                location: string
                etag: string
            }
        }
    }
}

export class App {
    app: express.Application
    nodesPool: NodesPool
    abortControllerPool: AbortControllerPool
    cachePool: CachePool
    telemetry: Telemetry
    rateLimiterManager: RateLimiterManager
    AppDataSource: DataSource = getDataSource()
    sseStreamer: SSEStreamer
    identityManager: OssIdentity
    metricsProvider: IMetricsProvider
    queueManager: QueueManager
    redisSubscriber: RedisEventSubscriber
    usageCacheManager: UsageCacheManager
    sessionStore: any
    /** Set when initDatabase failed: the server must not count as started (see settings/safeboot). */
    initError: unknown = undefined

    constructor() {
        this.app = express()
    }

    async initDatabase() {
        // Initialize database
        try {
            setBootStep('Opening the database')
            await this.AppDataSource.initialize()
            logger.info('📦 [server]: Data Source initialized successfully')

            // Run Migrations Scripts
            setBootStep('Updating the database')
            await runSupportedMigrations(this.AppDataSource)
            logger.info('🔄 [server]: Database migrations completed successfully')
            const authKitSwitch = await applyAuthKitSwitchOnBoot(this.AppDataSource)
            if (authKitSwitch) {
                logger.info(
                    `🔐 [server]: AuthKit is configured. Ended ${authKitSwitch.ended} local session(s). Password sign-in stays available only for the owner break-glass account.`
                )
            }

            // Open source identity. SSO providers are not loaded or started.
            this.identityManager = ossIdentity()
            logger.info('🔐 [server]: Open source identity ready')

            // Initialize nodes pool
            setBootStep('Loading the building blocks (the slowest step)')
            logger.info('🔧 [server]: Loading nodes. This is the slowest boot step, a few seconds.')
            this.nodesPool = new NodesPool()
            await this.nodesPool.initialize()
            logger.info('🔧 [server]: Nodes pool initialized successfully')

            // Initialize abort controllers pool
            this.abortControllerPool = new AbortControllerPool()
            logger.info('⏹️ [server]: Abort controllers pool initialized successfully')

            // Initialize encryption key
            await getEncryptionKey()
            logger.info('🔑 [server]: Encryption key initialized successfully')

            // Auth secrets: environment, then a file under SECRETKEY_PATH.
            await initAuthSecrets()
            logger.info('🔐 [server]: Auth initialized successfully')

            // Initialize Rate Limit
            this.rateLimiterManager = RateLimiterManager.getInstance()
            await this.rateLimiterManager.initializeRateLimiters(await getDataSource().getRepository(ChatFlow).find())
            logger.info('🚦 [server]: Rate limiters initialized successfully')

            // Initialize cache pool
            this.cachePool = new CachePool()
            logger.info('💾 [server]: Cache pool initialized successfully')

            // Initialize usage cache manager
            this.usageCacheManager = await UsageCacheManager.getInstance()
            logger.info('📊 [server]: Usage cache manager initialized successfully')

            // Initialize telemetry
            this.telemetry = new Telemetry()
            logger.info('📈 [server]: Telemetry initialized successfully')

            // Initialize SSE Streamer
            this.sseStreamer = new SSEStreamer()
            this.sseStreamer.startHeartbeat()
            logger.info('🌊 [server]: SSE Streamer initialized successfully')

            // Init Queues
            if (process.env.MODE === MODE.QUEUE) {
                this.queueManager = (require('./queue/QueueManager') as typeof import('./queue/QueueManager')).QueueManager.getInstance()
                const { ExpressAdapter } = require('@bull-board/express') as typeof import('@bull-board/express')
                const serverAdapter = new ExpressAdapter()
                serverAdapter.setBasePath('/admin/queues')
                this.queueManager.setupAllQueues({
                    componentNodes: this.nodesPool.componentNodes,
                    telemetry: this.telemetry,
                    cachePool: this.cachePool,
                    appDataSource: this.AppDataSource,
                    abortControllerPool: this.abortControllerPool,
                    usageCacheManager: this.usageCacheManager,
                    identityManager: this.identityManager,
                    serverAdapter
                })
                logger.info('✅ [Queue]: All queues setup successfully')

                this.redisSubscriber = new RedisEventSubscriber(this.sseStreamer)
                await this.redisSubscriber.connect()
                this.redisSubscriber.startPeriodicCleanup()
                logger.info('🔗 [server]: Redis event subscriber connected successfully')
            }

            await initWebhookListenerRegistry(this.sseStreamer, this.redisSubscriber)
            logger.info('📡 [server]: Webhook listener registry initialized successfully')

            // Init ScheduleBeat (works in both queue and non-queue mode)
            await ScheduleBeat.getInstance().init()
            logger.info('⏰ [server]: ScheduleBeat initialized successfully')

            logger.info('🎉 [server]: All initialization steps completed successfully!')
        } catch (error) {
            this.initError = error
            if (!logUnsupportedFlowiseUpgrade(error, logger)) {
                logger.error('❌ [server]: Error during Data Source initialization:', error)
            }
        }
    }

    async config() {
        // Limit is needed to allow sending/receiving base64 encoded string
        const flowise_file_size_limit = fileSizeLimit(process.env)

        // Preserve raw bytes before JSON parsing for webhook HMAC signature verification
        const captureRawBody = (req: Request, _res: Response, buf: Buffer) => {
            ;(req as any).rawBody = buf
        }
        assertA2aPublicBaseUrl()
        // Parse A2A, Orchestrate, and MCP JSON at 1 MB, then skip the global file-size parser on
        // those prefixes. body-parser leaves an already-parsed body alone, so a later 50 MB
        // express.json would otherwise ignore the 1 MB cap.
        this.app.use('/api/v1/orchestrate', orchestrateContentTypeGuard, orchestrateJsonParser)
        this.app.use('/api/v1/a2a', a2aContentTypeGuard)
        this.app.use('/api/v1/a2a', a2aJsonParser)
        this.app.use('/api/v1/a2a', a2aBodyErrorHandler)
        this.app.use(whenMcpEndpoint(mcpJsonParser))
        this.app.use(unlessExternalJson(express.json({ limit: flowise_file_size_limit, verify: captureRawBody })))
        this.app.use(unlessExternalJson(express.urlencoded({ limit: flowise_file_size_limit, extended: true, verify: captureRawBody })))

        // Unset TRUST_PROXY ignores X-Forwarded-For. Render sets TRUST_PROXY=1.
        this.app.set('trust proxy', resolveTrustProxy(process.env.TRUST_PROXY))

        // Allow access from specified domains
        validateCorsConfig()
        this.app.use(cors(getCorsOptions()))

        // While shutting down, new requests get 503 with Retry-After (settings/runs.ts shutdownDrain).
        this.app.use(refuseWhileShuttingDown)

        // Parse cookies
        this.app.use(cookieParser())

        // Allow embedding from specified domains.
        const iframeSecurityHeaders = getIframeSecurityHeaders()
        this.app.use((req, res, next) => {
            for (const [headerName, headerValue] of Object.entries(iframeSecurityHeaders)) {
                res.setHeader(headerName, headerValue)
            }
            next()
        })

        // Switch off the default 'X-Powered-By: Express' header
        this.app.disable('x-powered-by')

        // Add the expressRequestLogger middleware to log all requests
        this.app.use(expressRequestLogger)

        // Add the sanitizeMiddleware to guard against XSS
        this.app.use(sanitizeMiddleware)

        const whitelistURLs = withoutDenylisted(WHITELIST_URLS, process.env.DENYLIST_URLS)

        this.app.use(
            apiV1Auth({
                whitelistURLs,
                readOnlyWhitelistURLs: READ_ONLY_WHITELIST_URLS,
                apiKeyBlacklistURLs: API_KEY_BLACKLIST_URLS,
                licenseRequired: () =>
                    this.identityManager.getPlatformType() !== Platform.OPEN_SOURCE && !this.identityManager.isLicenseValid(),
                dataSource: this.AppDataSource,
                validateAPIKey,
                attachIdentitySession
            })
        )

        if (process.env.ENABLE_METRICS === 'true') {
            switch (process.env.METRICS_PROVIDER) {
                // default to prometheus
                case 'prometheus':
                case undefined:
                    this.metricsProvider = new Prometheus(this.app)
                    break
                case 'open_telemetry':
                    this.metricsProvider = new OpenTelemetry(this.app)
                    break
                // add more cases for other metrics providers here
            }
            if (this.metricsProvider) {
                await this.metricsProvider.initializeCounters()
                logger.info(`📊 [server]: Metrics Provider [${this.metricsProvider.getName()}] has been initialized!`)
            } else {
                logger.error(
                    "❌ [server]: Metrics collection is enabled, but failed to initialize provider (valid values are 'prometheus' or 'open_telemetry'."
                )
            }
        }

        registerCuttlelyTraces()

        this.app.use('/api/v1', flowiseApiV1Router)

        // ----------------------------------------
        // Configure number of proxies in Host Environment
        // ----------------------------------------
        this.app.get('/api/v1/ip', (request, response) => {
            response.send({
                ip: request.ip,
                msg: 'Check the returned IP address. If it matches your current IP address (http://ip.nfriedly.com/ or https://api.ipify.org/), the proxy hop count is right and the rate limiter sees the client. If it does not match, increase TRUST_PROXY by 1 and restart Cuttlely. See the Deploy section of the Cuttlely README.'
            })
        })

        // Cuttlely does not run queue mode. The BullMQ dashboard is not mounted.
        if (process.env.MODE === MODE.QUEUE && process.env.ENABLE_BULLMQ_DASHBOARD === 'true') {
            this.app.use('/admin/queues', (_req, res) => {
                res.status(404).json({ message: 'Not Found' })
            })
        }

        // ----------------------------------------
        // Chat widget for shared links and website embeds (packages/chat-widget), served by this server so it
        // always matches this version. Public on purpose: it is a static script, any site may load it.
        // ----------------------------------------
        const chatWidget = chatWidgetScript()
        this.app.get(['/embed/chat.js', '/embed/chat.min.js'], (req: Request, res: Response) => {
            if (!chatWidget) return res.status(404).type('text/plain').send('The chat widget is not built. Run pnpm build.')
            res.set({
                'Content-Type': 'application/javascript; charset=utf-8',
                'Cache-Control': 'public, max-age=300, must-revalidate',
                'Access-Control-Allow-Origin': '*',
                'Cross-Origin-Resource-Policy': 'cross-origin',
                'X-Content-Type-Options': 'nosniff',
                'X-Cuttlely-Chat-Version': chatWidget.version,
                ETag: chatWidget.etag
            })
            if (req.headers['if-none-match'] === chatWidget.etag) return res.status(304).end()
            return res.send(chatWidget.body)
        })

        // ----------------------------------------
        // Serve the built UI. The copy in dist/ui, the repo build, and a linked
        // UI package are all valid. A production install does not include the
        // UI package's libraries; the files below are the ones this server serves.
        // ----------------------------------------

        const uiBuild = resolveUiBuild(getNodeModulesPackagePath('@cuttlely/ui'))
        if (uiBuild) {
            this.app.use(uiAssetMiddleware(uiBuild.directory))
            // `/` and `/index.html` fall through to this. Hashed files are served above and are not counted.
            this.app.use(uiPageRateLimiter(), (req: Request, res: Response) => {
                if (isMcpEndpointPath(`${req.baseUrl}${req.path}`)) {
                    sendMcpMethodNotAllowed(res)
                    return
                }
                res.sendFile(uiBuild.indexHtml)
            })
        } else {
            logger.error('❌ [server]: UI build was not found. Build the UI, then build the server.')
        }

        // Error handling
        this.app.use(errorHandlerMiddleware)
    }

    async warmNodes() {
        const flows = await this.AppDataSource.getRepository(ChatFlow).find({ select: ['flowData'] })
        const names = new Set<string>()
        for (const { flowData } of flows) for (const name of flowNodeNames(flowData)) names.add(name)
        await this.nodesPool.warm(names)
    }

    async stopApp() {
        try {
            this.sseStreamer.stopHeartbeat()
            const removePromises: any[] = []
            removePromises.push(this.telemetry.flush())
            if (this.queueManager) {
                removePromises.push(this.redisSubscriber.disconnect())
            }
            await Promise.all(removePromises)
        } catch (e) {
            logger.error(`❌[server]: Flowise Server shut down error: ${e}`)
        }
    }
}

function flowNodeNames(flowData: string): string[] {
    try {
        const nodes: Array<{ data?: { name?: string } }> = JSON.parse(flowData).nodes ?? []
        return nodes.map((node) => node.data?.name).filter((name): name is string => !!name)
    } catch {
        return []
    }
}

let serverApp: App | undefined
let httpServer: http.Server | undefined
let onInitFailed: (() => Promise<void> | void) | null = null

/** Called when initDatabase fails, before the server listens. The start command uses it for safe boot. */
export function setInitFailureHandler(next: (() => Promise<void> | void) | null): void {
    onInitFailed = next
}

/** The health check's view of the database (see startup/databaseHealth). A start that never opened it stays down. */
function databaseHealthFor(app: App): DatabaseHealth {
    const startError = app.initError !== undefined && !app.AppDataSource.isInitialized ? app.initError : undefined
    const health = new DatabaseHealth(
        async () => {
            if (startError !== undefined) throw startError
            if (!app.AppDataSource.isInitialized) throw Object.assign(new Error('not connected'), { code: 'NOT_CONNECTED' })
            await app.AppDataSource.query('SELECT 1')
        },
        () => databaseWhere(process.env, String(app.AppDataSource.options.database ?? '')),
        { error: (line) => logger.error(line), info: (line) => logger.info(line) }
    )
    if (startError !== undefined) health.markDown(startError)
    setDatabaseHealth(health)
    return health
}

export async function start(): Promise<void> {
    serverApp = new App()

    const host = process.env.HOST
    const port = parseInt(process.env.PORT || '', 10) || 3000
    const server = http.createServer(serverApp.app)
    httpServer = server

    // A browser opened during boot gets a "Cuttlely is starting" page instead of a refused connection.
    const startingPage = await startStartingPage(port, host)
    let database: DatabaseHealth | undefined
    logger.info(`⏳ [server]: Starting Cuttlely on port ${port}.${startingPage ? ' A browser opened now shows the progress.' : ''}`)

    try {
        await serverApp.initDatabase()
        if (serverApp.initError) await onInitFailed?.()
        database = databaseHealthFor(serverApp)
        setBootStep('Getting the app ready')
        await serverApp.config()
    } finally {
        await startingPage?.close()
    }
    if (!serverApp?.initError) {
        await harnessesService.backfillHarnessWorkspaces().catch((error) => {
            logger.warn(`[harness] workspace backfill failed: ${error instanceof Error ? error.message : error}`)
        })
        await harnessesService.closeInterruptedRuns()
        await warnKeysMissingBoundHarnesses()
    }
    server.listen(port, host, () => {
        logger.info(`⚡️ [server]: Cuttlely Server is listening at ${host ? 'http://' + host : ''}:${port}`)
        // Ready only when the start worked. A database that cannot be reached was logged by databaseHealthFor.
        if (!serverApp?.initError) for (const line of readyBanner(port, host)) logger.info(line)
        else if (database?.current().ok) logger.error('⚠️ [server]: Cuttlely started with the error above, so it is not ready.')
        announceFirstRunSetup(
            port,
            () => identityStore().countUsers(),
            (line) => logger.info(line),
            localAdminEnabled()
        ).catch((err) => logger.warn(`[server]: First-run setup check failed: ${err}`))
        serverApp?.warmNodes().catch((err) => logger.warn(`[server]: Node warm-up failed: ${err}`))
        harnessesService.startHarnessRuntime()
        harnessesService.warmHarnesses()
        etlService.resumeEtlRuns()
        startHarnessSchedulerIfReady(serverApp?.initError)
        flowVersionsService.startGithubSync()
        const keepWarmMinutes = Number(process.env.CUTTLELY_HERMES_KEEP_WARM_MINUTES)
        if (keepWarmMinutes > 0) setInterval(() => harnessesService.warmHarnesses(), keepWarmMinutes * 60000).unref()
    })
}

/**
 * SIGTERM and SIGINT: stop taking new requests (503 with Retry-After, the health check too), let requests and streams
 * already running finish for up to CUTTLELY_DRAIN_TIMEOUT_MS (25 seconds by default), end the rest with a 503 or an
 * error event, then stop the app and close the database.
 */
export async function shutdown(limitMs: number = drainTimeoutMs()): Promise<void> {
    const started = Date.now()
    logger.info(`🛑 [server]: Shutting down: finishing open requests (up to ${Math.round(limitMs / 1000)}s), new requests get 503.`)
    // A schedule that comes due now would start a run the drain then has to cut off.
    stopHarnessScheduler()
    const { endedRuns, closedInTime } = await shutdownDrain(httpServer, limitMs)
    if (closedInTime) logger.info(`🛑 [server]: Open requests finished in ${Math.round((Date.now() - started) / 100) / 10}s.`)
    else logger.warn(`🛑 [server]: Drain time is up: ended ${endedRuns} run(s) still answering and closed the remaining connections.`)
    if (serverApp) await serverApp.stopApp()
    await shutdownCuttlelyTraces()
    try {
        if (serverApp?.AppDataSource.isInitialized) await serverApp.AppDataSource.destroy()
    } catch (error) {
        logger.error(`❌[server]: Closing the database failed: ${error}`)
    }
}

export function getInstance(): App | undefined {
    return serverApp
}
