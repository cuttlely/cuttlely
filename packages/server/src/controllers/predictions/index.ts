import { Request, Response, NextFunction } from 'express'
import { RateLimiterManager } from '../../utils/rateLimit'
import chatflowsService from '../../services/chatflows'
import logger from '../../utils/logger'
import predictionsServices from '../../services/predictions'
import { AppError } from '../../errors/appError'
import { StatusCodes } from 'http-status-codes'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { getErrorMessage } from '../../errors/utils'
import { errorEventDetails } from '../../utils/predictionErrors'
import { bindRequestSession } from '../../utils/sessionOwnership'
import { MODE } from '../../Interface'
import { checkChatflowOrigin } from '../../utils/domainValidation'
import { onAbort, watchClientDisconnect } from '../../utils/clientAbort'
import { isStreamingRequest } from '../../utils/streaming'
import { validateFlowAPIKey } from '../../utils/validateKey'

// Send input message and get prediction result (External)
const createPrediction = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: predictionsController.createPrediction - id not provided!`)
        }
        if (!req.body) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: predictionsController.createPrediction - body not provided!`)
        }
        const workspaceId = req.user?.activeWorkspaceId

        const chatflow = await chatflowsService.getChatflowById(req.params.id, workspaceId)
        if (!chatflow) {
            throw new AppError(StatusCodes.NOT_FOUND, `Chatflow ${req.params.id} not found`)
        }
        logger.info(`[server]: Request originated from ${req.headers.origin || 'UNKNOWN ORIGIN'}`)
        // authorizePrediction already applied this rule before multer; kept here so the controller stays safe on its own.
        const { allowed: isDomainAllowed, error: unauthorizedOriginError } = checkChatflowOrigin(chatflow.chatbotConfig, req.headers.origin)
        if (isDomainAllowed) {
            // flushHeaders() commits HTTP 200. A missing or wrong flow key has to fail here, before any SSE
            // header, because the same check inside utilBuildChatflow cannot change the status once the stream has started.
            if (!(await validateFlowAPIKey(req, chatflow))) {
                throw new AppError(StatusCodes.UNAUTHORIZED, 'Unauthorized')
            }
            const streamable = await chatflowsService.checkIfChatflowIsValidForStreaming(req.params.id)
            if (streamable?.isStreaming && isStreamingRequest(req)) {
                const sseStreamer = getRunningExpressApp().sseStreamer

                // Register the SSE client on the bound id. A client-supplied session id is not used as the channel.
                const chatId = bindRequestSession(req, { chatflow, isInternal: false }).chatId
                const isQueueMode = process.env.MODE === MODE.QUEUE
                // A client that disconnects mid-stream aborts the run (utilBuildChatflow links this signal to the run's
                // controller) and stops the SSE writer, so nothing more is generated or written for it.
                const clientAbortSignal = watchClientDisconnect(res)
                const stopWatchingClient = onAbort(clientAbortSignal, () => sseStreamer.removeClient(chatId))
                try {
                    sseStreamer.addExternalClient(chatId, res)
                    res.setHeader('Content-Type', 'text/event-stream')
                    res.setHeader('Cache-Control', 'no-cache')
                    res.setHeader('Connection', 'keep-alive')
                    res.setHeader('X-Accel-Buffering', 'no') //nginx config: https://serverfault.com/a/801629
                    res.flushHeaders()

                    if (isQueueMode) {
                        await getRunningExpressApp().redisSubscriber.subscribe(chatId)
                    }

                    const apiResponse = await predictionsServices.buildChatflow(req)
                    sseStreamer.streamMetadataEvent(apiResponse.chatId, apiResponse, { sessionToken: true })
                } catch (error) {
                    if (chatId) {
                        sseStreamer.streamErrorEvent(chatId, getErrorMessage(error), errorEventDetails(error))
                    }
                    next(error)
                } finally {
                    stopWatchingClient()
                    if (isQueueMode && chatId) {
                        await getRunningExpressApp().redisSubscriber.unsubscribe(chatId)
                    }
                    sseStreamer.removeClient(chatId)
                }
            } else {
                const apiResponse = await predictionsServices.buildChatflow(req)
                return res.json(apiResponse)
            }
        } else {
            if (isStreamingRequest(req)) {
                return res.status(StatusCodes.FORBIDDEN).send(unauthorizedOriginError)
            }
            throw new AppError(StatusCodes.FORBIDDEN, unauthorizedOriginError)
        }
    } catch (error) {
        next(error)
    }
}

const getRateLimiterMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return RateLimiterManager.getInstance().getRateLimiter()(req, res, next)
    } catch (error) {
        next(error)
    }
}

export default {
    createPrediction,
    getRateLimiterMiddleware
}
