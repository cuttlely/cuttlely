import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { AppError } from '../../errors/appError'
import { getErrorMessage } from '../../errors/utils'
import { errorEventDetails } from '../../utils/predictionErrors'
import { MODE } from '../../Interface'
import chatflowService from '../../services/chatflows'
import harnessesService from '../../services/harnesses'
import { utilBuildChatflow } from '../../utils/buildChatflow'
import { onAbort, watchClientDisconnect } from '../../utils/clientAbort'
import { bindRequestSession } from '../../utils/sessionOwnership'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { isStreamingRequest } from '../../utils/streaming'

// Send input message and get prediction result (Internal)
const createInternalPrediction = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const workspaceId = req.user?.activeWorkspaceId

        const chatflow = await chatflowService.getChatflowByIdForWorkspace(req.params.id, workspaceId)
        if (!chatflow) {
            throw new AppError(StatusCodes.NOT_FOUND, `Chatflow ${req.params.id} not found`)
        }

        bindRequestSession(req, { chatflow, isInternal: true })

        // A harness canvas is not a chatflow. Building it looks for node.init and throws.
        // The same draft path as a chatflow test chat: this route runs the draft, the public runs route stays on Live.
        if (chatflow.type === 'HARNESS') {
            await runHarnessCanvasChat(req, res, chatflow)
            return
        }

        // Same rule as POST /api/v1/prediction: only `true` or `'true'` asks for a stream.
        if (isStreamingRequest(req)) {
            createAndStreamInternalPrediction(req, res, next)
            return
        } else {
            const apiResponse = await utilBuildChatflow(req, true, undefined, { testDraft: true })
            if (apiResponse) return res.json(apiResponse)
        }
    } catch (error) {
        next(error)
    }
}

// Send input message and stream prediction result using SSE (Internal)
const createAndStreamInternalPrediction = async (req: Request, res: Response, next: NextFunction) => {
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

        const apiResponse = await utilBuildChatflow(req, true, undefined, { testDraft: true })
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
async function runHarnessCanvasChat(
    req: Request,
    res: Response,
    chatflow: { id: string; name: string; flowData: string; workspaceId: string }
) {
    const streaming = isStreamingRequest(req)
    const source = 'playground'
    const run = (extra: { signal?: AbortSignal; onEvent?: (event: { type: string }) => void } = {}) =>
        harnessesService.startCanvasRun(chatflow, req.body || {}, { source, ...extra })
    if (!streaming) {
        const outcome = await run()
        return res.json({ chatId: outcome.chatId, run: outcome.run, ...outcome.payload })
    }
    const signal = watchClientDisconnect(res)
    res.status(StatusCodes.OK)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    const write = (event: string, data: unknown) => {
        if (res.writableEnded) return
        res.write(`message:\ndata:${JSON.stringify({ event, data })}\n\n`)
    }
    try {
        const outcome = await run({
            signal,
            onEvent: (event) => write(`harness.${event.type}`, event)
        })
        const images = harnessesService.chatImages((outcome.payload as { artifacts?: unknown } | undefined)?.artifacts)
        if (images.length) write('artifacts', images)
        write('harness.recorded', { run: outcome.run, chatId: outcome.chatId })
        write('end', {})
        res.end()
    } catch (error) {
        const recorded = (error as { harnessRun?: unknown }).harnessRun || null
        write('error', { message: getErrorMessage(error), run: recorded })
        write('end', {})
        res.end()
    }
}

export default {
    createInternalPrediction
}
