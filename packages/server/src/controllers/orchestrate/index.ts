import { randomUUID } from 'crypto'
import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { MODE } from '../../Interface'
import { getErrorMessage } from '../../errors/utils'
import { errorEventDetails } from '../../utils/predictionErrors'
import { onAbort, watchClientDisconnect } from '../../utils/clientAbort'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import logger from '../../utils/logger'
import { bindRequestSession } from '../../utils/sessionOwnership'
import { ExternalAgentError } from '../../utils/externalAgentAuth'
import { parseThreadId } from '../../utils/externalThread'
import { SSEEncoder } from '../../utils/SSEStreamer'
import predictionsServices from '../../services/predictions'
import { answerText } from '../../services/orchestrate/completion'
import { chatCompletionBody, ibmDeltaFrame, IbmEncoderMeta, makeIbmEncoder } from '../../services/orchestrate/ibmEncoder'
import { mapOrchestrateRequest } from '../../services/orchestrate/mapRequest'
import { fileLinkContext, makeArtifactLinker, resultArtifacts, withArtifactLinks } from '../../services/orchestrate/fileLinks'

type OrchestrateRequest = Request & { orchestrate?: unknown }

const stripClientSession = (req: OrchestrateRequest): void => {
    delete req.headers['x-cuttlely-session-token']
    delete req.headers['cookie']
    ;(req as Request & { cookies?: Record<string, unknown> }).cookies = {}
}

const writeIfOpen = (res: Response, chunk: string): void => {
    if (res.writableEnded || res.destroyed) return
    try {
        res.write(chunk)
    } catch {
        // Client already disconnected.
    }
}

const createCompletion = async (req: OrchestrateRequest, res: Response, next: NextFunction) => {
    try {
        const chatflow = res.locals.chatflow as {
            id: string
            apikeyid?: string | null
            flowData?: string | null
            workspaceId?: string | null
        }
        if (!chatflow?.id) {
            throw new ExternalAgentError(StatusCodes.NOT_FOUND, 'flow_not_found', 'invalid_request_error', 'Flow not found')
        }

        stripClientSession(req)
        const threadId = parseThreadId(req.headers['x-ibm-thread-id'])
        const mapped = mapOrchestrateRequest(req.orchestrate, chatflow, threadId)
        const derivedToken = mapped.body.sessionToken
        req.body = mapped.body
        if (derivedToken) req.headers['x-cuttlely-session-token'] = derivedToken

        const owned = bindRequestSession(req, { chatflow, isInternal: false })
        if (derivedToken) (req.body as { sessionToken?: string }).sessionToken = derivedToken
        res.removeHeader('Set-Cookie')

        const responseId = `chatcmpl-${randomUUID()}`
        const created = Math.floor(Date.now() / 1000)
        const frameThreadId = threadId ?? owned.chatId
        const meta: IbmEncoderMeta = { responseId, threadId: frameThreadId, model: mapped.model, created }
        const echoThread = () => {
            if (threadId) res.setHeader('X-IBM-THREAD-ID', threadId)
        }

        const chatId = owned.chatId
        watchClientDisconnect(res)
        // Signed links for the files this run stores, scoped to this flow and this chat.
        const linker = makeArtifactLinker(await fileLinkContext(req, chatflow, chatId))

        if (!mapped.stream) {
            echoThread()
            const apiResponse = await predictionsServices.buildChatflow(req)
            const content = withArtifactLinks(answerText(apiResponse), linker.links(resultArtifacts(apiResponse)))
            return res.status(StatusCodes.OK).json(chatCompletionBody(meta, content))
        }

        const sseStreamer = getRunningExpressApp().sseStreamer
        let sentToken = false
        const inner = makeIbmEncoder(meta, linker.collect)
        const encoder: SSEEncoder = (frame) => {
            const encoded = inner(frame)
            if (frame.kind === 'event' && frame.payload.event === 'token') sentToken = true
            return encoded
        }

        if (!sseStreamer.tryAddExternalClient(chatId, res, encoder)) {
            throw new ExternalAgentError(
                StatusCodes.CONFLICT,
                'thread_busy',
                'conflict_error',
                'A run on this thread is already in progress'
            )
        }

        echoThread()
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no')
        res.flushHeaders()

        const isQueueMode = process.env.MODE === MODE.QUEUE
        const stopWatchingClient = onAbort(watchClientDisconnect(res), () => sseStreamer.removeClient(chatId))
        try {
            if (isQueueMode) {
                await getRunningExpressApp().redisSubscriber.subscribe(chatId)
            }
            const apiResponse = await predictionsServices.buildChatflow(req)
            if (!sentToken) {
                const content = withArtifactLinks(answerText(apiResponse), linker.links(resultArtifacts(apiResponse)))
                writeIfOpen(res, ibmDeltaFrame(meta, content))
            } else {
                // Held-back token text, then the links for every file the run stored, as one final delta.
                const rest = linker.take(resultArtifacts(apiResponse))
                const tail = inner.flush() + (rest ? `\n\n${rest}` : '')
                if (tail) writeIfOpen(res, ibmDeltaFrame(meta, tail))
            }
        } catch (error) {
            logger.error(`[orchestrate] run failed: ${getErrorMessage(error)}`)
            const code = errorEventDetails(error).code
            writeIfOpen(res, ibmDeltaFrame(meta, `The flow could not finish (code ${code}).`))
        } finally {
            stopWatchingClient()
            if (isQueueMode && chatId) {
                await getRunningExpressApp().redisSubscriber.unsubscribe(chatId)
            }
            sseStreamer.removeClient(chatId)
        }
    } catch (error) {
        next(error)
    }
}

export default {
    createCompletion
}
