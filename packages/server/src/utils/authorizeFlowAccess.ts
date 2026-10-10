import { NextFunction, Request, RequestHandler, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { isPathTraversal, isValidUUID } from 'flowise-components'
import { ChatFlow } from '../database/entities/ChatFlow'
import { InternalFlowiseError } from '../errors/internalFlowiseError'
import { validateFeedbackExists, validateMessageExists } from '../services/feedback/validation'
import { checkChatflowOrigin } from './domainValidation'
import { verifyFileLink } from './fileLinkSignature'
import { getRunningExpressApp } from './getRunningExpressApp'
import { bindSuppliedChatId, callerIsSignedIn } from './sessionOwnership'
import { isStreamingRequest } from './streaming'
import { validateFlowAPIKey } from './validateKey'

export interface FlowAccessOptions {
    /** Returns the chatflow id the request targets (for example a route param). */
    getChatflowId: (req: Request) => string | undefined | Promise<string | undefined>
    /** Returns other request values that end up in storage paths; each is checked for path traversal. */
    getPathValues?: (req: Request) => Array<string | undefined>
    /**
     * When true, only the flow's API key decides (`validateFlowAPIKey`; keyless flows still pass).
     * A logged-in session is not accepted. Used on `/prediction`, which never accepts a session.
     */
    keyOnly?: boolean
    /** The error for a request with no chatflow id. Defaults to 400 (invalid chatflow id). */
    missingIdError?: () => InternalFlowiseError
    /**
     * When true, after access is granted, the flow's allowed origins (`chatbotConfig.allowedOrigins`) are applied
     * to the Origin header: 403 with the flow's `allowedOriginsError`, as `/prediction` answers. A refused key is
     * still 401 whatever the origin.
     */
    checkOrigin?: boolean
    /**
     * A request that proves access by itself, such as a signed file link (it names one file and expires). When it
     * returns true the key and session are not needed; when false the usual key or session check applies.
     */
    signedAccess?: (req: Request, chatflow: ChatFlow) => boolean
}

export interface FlowAccessCheck {
    /** Skip the session branch; only the flow's API key decides. */
    keyOnly?: boolean
}

/**
 * True when the caller may act on the flow as its owner or as a holder of the flow's key:
 * a logged-in session whose active workspace owns the flow, or the flow's API key
 * (`validateFlowAPIKey`, which also lets keyless flows through). With `keyOnly`, only the key decides.
 * The `x-request-from: internal` header is client-controlled and is never consulted here.
 */
export const hasFlowAccess = async (req: Request, chatflow: ChatFlow, check: FlowAccessCheck = {}): Promise<boolean> => {
    if (!check.keyOnly && chatflow.workspaceId && req.user?.activeWorkspaceId === chatflow.workspaceId) return true
    return validateFlowAPIKey(req, chatflow)
}

/** The chatflow loaded by `authorizeFlowAccess` for this request, if it ran. */
export const getAuthorizedChatflow = (req: Request, chatflowId: string): ChatFlow | undefined => {
    const chatflow = req.res?.locals?.chatflow as ChatFlow | undefined
    return chatflow?.id === chatflowId ? chatflow : undefined
}

/**
 * Route middleware for whitelisted chatflow routes. Place it before any body parser or multer,
 * so a refused request is never written to storage or parsed.
 * 400 on a bad chatflow id or path characters (or `missingIdError` when there is no id), 404 when the flow
 * doesn't exist, 401 `Unauthorized` (as `/prediction` answers) without a session in the flow's workspace
 * or the flow's key (only the key with `keyOnly`), then 403 from a disallowed Origin with `checkOrigin`.
 * A refusal is answered before any stream starts.
 * On success the flow is stored on `res.locals.chatflow`.
 */
export const authorizeFlowAccess =
    (options: FlowAccessOptions): RequestHandler =>
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const chatflowId = await options.getChatflowId(req)
            if (!chatflowId && options.missingIdError) throw options.missingIdError()
            if (!chatflowId || !isValidUUID(chatflowId)) {
                throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid chatflowId format - must be a valid UUID')
            }
            const pathValues = (options.getPathValues?.(req) ?? []).filter((value): value is string => !!value)
            if (isPathTraversal(chatflowId) || pathValues.some((value) => isPathTraversal(value))) {
                throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid path characters detected')
            }

            const chatflow = await getRunningExpressApp().AppDataSource.getRepository(ChatFlow).findOneBy({ id: chatflowId })
            if (!chatflow) {
                throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${chatflowId} not found`)
            }

            const signed = options.signedAccess?.(req, chatflow) === true
            res.locals.signedAccess = signed
            if (!signed && !(await hasFlowAccess(req, chatflow, { keyOnly: options.keyOnly }))) {
                throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, 'Unauthorized')
            }

            if (options.checkOrigin) {
                const origin = checkChatflowOrigin(chatflow.chatbotConfig, req.headers.origin)
                if (!origin.allowed) {
                    // Same answer as the controller: plain text for a (parsed) streaming request, else the JSON error.
                    if (isStreamingRequest(req)) return res.status(StatusCodes.FORBIDDEN).send(origin.error)
                    throw new InternalFlowiseError(StatusCodes.FORBIDDEN, origin.error)
                }
            }

            res.locals.chatflow = chatflow
            next()
        } catch (error) {
            // No stream has started here, so the error handler answers with the JSON error (it only stays silent once headers are sent).
            next(error)
        }
    }

/** `POST /api/v1/attachments/:chatflowId/:chatId`: runs before multer. */
export const authorizeAttachmentUpload: RequestHandler = authorizeFlowAccess({
    getChatflowId: (req) => req.params.chatflowId,
    getPathValues: (req) => [req.params.chatId]
})

/** After flow access, before multer. A chat id this caller does not own is replaced, so the file is not stored under it. */
export const bindAttachmentChatId: RequestHandler = (req, res, next) => {
    try {
        const chatflow = res.locals.chatflow as ChatFlow | undefined
        if (!chatflow) throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, 'Unauthorized')
        const owned = bindSuppliedChatId(req, {
            chatflow,
            isInternal: callerIsSignedIn(req),
            suppliedChatId: req.params.chatId,
            failClosed: false
        })
        req.params.chatId = owned.chatId
        res.setHeader('x-cuttlely-chat-id', owned.chatId)
        next()
    } catch (error) {
        next(error)
    }
}

/**
 * After flow access. A chat id this caller does not own is 403 and the file is not read. A signed file link already
 * names its chat id inside the signature (a changed chat id fails it), so it needs no session token for that chat.
 */
export const bindUploadFileChatId: RequestHandler = (req, res, next) => {
    try {
        const chatflow = res.locals.chatflow as ChatFlow | undefined
        if (!chatflow) throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, 'Unauthorized')
        if (res.locals.signedAccess === true) return next()
        const owned = bindSuppliedChatId(req, {
            chatflow,
            isInternal: callerIsSignedIn(req),
            suppliedChatId: req.query.chatId,
            failClosed: true
        })
        req.query.chatId = owned.chatId
        next()
    } catch (error) {
        next(error)
    }
}

/**
 * `POST /api/v1/prediction/:id`: runs after the rate limiter and before multer. Key only, because
 * `/prediction` never accepts a session (`utilBuildChatflow` runs with `isInternal = false`); the in-app
 * chat uses `/internal-prediction`. A missing id keeps the controller's 412 and message. The flow's allowed
 * origins are applied here too (403), so a valid key from a disallowed origin is refused before any upload.
 */
export const authorizePrediction: RequestHandler = authorizeFlowAccess({
    getChatflowId: (req) => req.params.id,
    keyOnly: true,
    checkOrigin: true,
    missingIdError: () =>
        new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, `Error: predictionsController.createPrediction - id not provided!`)
})

/** A single string value from the query or body; anything else (missing, an array, an object) is undefined. */
const singleString = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

/**
 * `GET /api/v1/feedback/:id`: the id is the chatflow id. The flow's key or a session in its workspace.
 * A missing id keeps the controller's 412 and message.
 */
export const authorizeFeedbackRead: RequestHandler = authorizeFlowAccess({
    getChatflowId: (req) => req.params.id,
    missingIdError: () =>
        new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, `Error: feedbackController.getAllChatMessageFeedback - id not provided!`)
})

/**
 * `POST /api/v1/feedback(/:id)`: access is checked on the flow that owns the rated message, never on an id the client
 * names, so a key for one flow can't rate another flow's messages. A body chatflow id that doesn't match the message
 * is still refused afterwards by `validateFeedbackForCreation` (400). No message id: 400; unknown message: 404.
 */
export const authorizeFeedbackCreate: RequestHandler = authorizeFlowAccess({
    getChatflowId: async (req) => {
        const messageId = singleString(req.body?.messageId)
        if (!messageId) throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Message ID is required')
        return (await validateMessageExists(messageId)).chatflowid
    }
})

/**
 * `PUT /api/v1/feedback/:id`: the id is the feedback id; access is checked on the flow that owns that feedback row.
 * `validateFeedbackForUpdate` refuses moving the row to another flow's message (400). Unknown feedback: 404;
 * a missing id keeps the controller's 412 and message.
 */
export const authorizeFeedbackUpdate: RequestHandler = authorizeFlowAccess({
    getChatflowId: async (req) => (req.params.id ? (await validateFeedbackExists(req.params.id)).chatflowid : undefined),
    missingIdError: () =>
        new InternalFlowiseError(
            StatusCodes.PRECONDITION_FAILED,
            `Error: feedbackController.updateChatMessageFeedbackForChatflow - id not provided!`
        )
})

/**
 * `GET /api/v1/get-upload-file?chatflowId&chatId&fileName`: the file is read from that flow's storage, under the chat id,
 * so access is checked on that flow. The chat id is also checked for path characters. A link an Agent answer carries
 * may be signed (`expires` and `signature`, see fileLinkSignature.ts): a valid signature for exactly this flow, chat and
 * file opens it without the key or a session; an expired, changed or missing one falls back to the key or session.
 */
export const authorizeUploadFileRead: RequestHandler = authorizeFlowAccess({
    getChatflowId: (req) => singleString(req.query.chatflowId),
    getPathValues: (req) => [singleString(req.query.chatId)],
    signedAccess: (req, chatflow) =>
        verifyFileLink(
            { chatflowId: chatflow.id, chatId: singleString(req.query.chatId), fileName: singleString(req.query.fileName) },
            req.query.expires,
            req.query.signature
        ) === 'valid'
})

/** `POST /api/v1/openai-assistants-file/download` with `{ chatflowId, chatId, fileName }`: same check as get-upload-file. */
export const authorizeAssistantFileDownload: RequestHandler = authorizeFlowAccess({
    getChatflowId: (req) => singleString(req.body?.chatflowId),
    getPathValues: (req) => [singleString(req.body?.chatId)]
})
