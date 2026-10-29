import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { AppError } from '../../errors/appError'
import { getErrorMessage } from '../../errors/utils'
import { errorEventDetails } from '../../utils/predictionErrors'
import { MODE } from '../../Interface'
import chatflowService from '../../services/chatflows'
import { utilBuildChatflow } from '../../utils/buildChatflow'
import { runHarnessCanvasChat } from '../predictions/runHarnessCanvasChat'
import { onAbort, watchClientDisconnect } from '../../utils/clientAbort'
import { bindRequestSession } from '../../utils/sessionOwnership'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { isStreamingRequest } from '../../utils/streaming'
import { harnessCallerFor, isApiKeyCaller } from '../../services/harnesses/apiAccess'
import type { IHarnessCaller } from '../../Interface'

// Send input message and get prediction result (Internal)
const createInternalPrediction = async (req: Request, res: Response, next: NextFunction) => {
    try {
        // The API gate already refuses a key here. This route runs drafts, so it refuses one on its own as well.
        if (isApiKeyCaller(req)) {
            throw new AppError(StatusCodes.UNAUTHORIZED, 'Unauthorized Access')
        }
        const caller = await harnessCallerFor(req)
        const workspaceId = req.user?.activeWorkspaceId

        const chatflow = await chatflowService.getChatflowByIdForWorkspace(req.params.id, workspaceId)
        if (!chatflow) {
            throw new AppError(StatusCodes.NOT_FOUND, `Chatflow ${req.params.id} not found`)
        }

        bindRequestSession(req, { chatflow, isInternal: true })

        // A harness canvas is not a chatflow. Building it looks for node.init and throws.
        // The same draft path as a chatflow test chat: this route runs the draft, the public runs route stays on Live.
        if (chatflow.type === 'HARNESS') {
            await runHarnessCanvasChat(req, res, chatflow, caller)
            return
        }

        // Same rule as POST /api/v1/prediction: only `true` or `'true'` asks for a stream.
        if (isStreamingRequest(req)) {
            createAndStreamInternalPrediction(req, res, next, caller)
            return
        } else {
            const apiResponse = await utilBuildChatflow(req, true, undefined, { testDraft: true, harnessCaller: caller })
            if (apiResponse) return res.json(apiResponse)
        }
    } catch (error) {
        next(error)
    }
}

// Send input message and stream prediction result using SSE (Internal)
const createAndStreamInternalPrediction = async (req: Request, res: Response, next: NextFunction, caller: IHarnessCaller) => {
    const chatId = req.body.chatId
    const sseStreamer = getRunningExpressApp().sseStreamer
    const isQueueMode = process.env.MODE === MODE.QUEUE
    // Same rule as POST /api/v1/prediction: a client that leaves mid-stream aborts the run
    // (utilBuildChatflow links this signal to the run's controller) and stops the SSE writer.
    const clientAbortSignal = watchClientDisconnect(res)
    const stopWatchingClient = onAbort(clientAbortSignal, () => sseStreamer.removeClient(chatId))

    try {
        sseStreamer.addClient(chatId, res)
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no') //nginx config: https://serverfault.com/a/801629
        res.flushHeaders()

        if (isQueueMode) {
            await getRunningExpressApp().redisSubscriber.subscribe(chatId)
        }

        const apiResponse = await utilBuildChatflow(req, true, undefined, { testDraft: true, harnessCaller: caller })
        sseStreamer.streamMetadataEvent(apiResponse.chatId, apiResponse)
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
}

export default {
    createInternalPrediction
}
