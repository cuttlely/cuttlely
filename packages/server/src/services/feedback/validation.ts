import { StatusCodes } from 'http-status-codes'
import { ChatMessageRatingType, IChatMessageFeedback } from '../../Interface'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { ChatMessageFeedback } from '../../database/entities/ChatMessageFeedback'

/**
 * Validates that the message ID exists
 * @param {string} messageId
 */
export const validateMessageExists = async (messageId: string): Promise<ChatMessage> => {
    const appServer = getRunningExpressApp()
    const message = await appServer.AppDataSource.getRepository(ChatMessage).findOne({
        where: { id: messageId }
    })

    if (!message) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Message with ID ${messageId} not found`)
    }

    return message
}

/**
 * Validates that the feedback ID exists
 * @param {string} feedbackId
 */
export const validateFeedbackExists = async (feedbackId: string): Promise<ChatMessageFeedback> => {
    const appServer = getRunningExpressApp()
    const feedbackExists = await appServer.AppDataSource.getRepository(ChatMessageFeedback).findOne({
        where: { id: feedbackId }
    })

    if (!feedbackExists) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Feedback with ID ${feedbackId} not found`)
    }

    return feedbackExists
}

/** Longest feedback text accepted, on create and update (characters). */
export const MAX_FEEDBACK_CONTENT_LENGTH = 10000

const RATINGS = new Set<string>(Object.values(ChatMessageRatingType))

/** A rating must be one of ChatMessageRatingType's values (400 otherwise). */
export const validateRating = (rating: unknown): ChatMessageRatingType => {
    if (typeof rating !== 'string' || !RATINGS.has(rating)) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, `Invalid rating: must be one of ${[...RATINGS].join(', ')}`)
    }
    return rating as ChatMessageRatingType
}

/** Feedback text: a string (empty clears it) of at most MAX_FEEDBACK_CONTENT_LENGTH characters (400 otherwise). */
export const validateContent = (content: unknown): string => {
    if (typeof content !== 'string') throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid content: must be a string')
    if (content.length > MAX_FEEDBACK_CONTENT_LENGTH) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, `Invalid content: at most ${MAX_FEEDBACK_CONTENT_LENGTH} characters`)
    }
    return content
}

/**
 * Validates a feedback object for creation
 * @param {Partial<IChatMessageFeedback>} feedback
 */
export const validateFeedbackForCreation = async (feedback: Partial<IChatMessageFeedback>): Promise<Partial<IChatMessageFeedback>> => {
    // API-11: a client id would make save() update that row, whatever flow it belongs to; the server assigns the id.
    delete feedback.id
    if (feedback.rating !== undefined) validateRating(feedback.rating)
    if (feedback.content !== undefined && feedback.content !== null) validateContent(feedback.content)

    // If messageId is provided, validate it exists and get the message
    let message: ChatMessage | null = null
    if (feedback.messageId) {
        message = await validateMessageExists(feedback.messageId)
    } else {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Message ID is required')
    }

    // If chatId is provided, validate it matches the message's chatId
    if (feedback.chatId) {
        if (message.chatId !== feedback.chatId) {
            throw new InternalFlowiseError(
                StatusCodes.BAD_REQUEST,
                `Inconsistent chat ID: message with ID ${message.id} does not belong to chat with ID ${feedback.chatId}`
            )
        }
    } else {
        // If not provided, use the message's chatId
        feedback.chatId = message.chatId
    }

    // If chatflowid is provided, validate it matches the message's chatflowid
    if (feedback.chatflowid) {
        if (message.chatflowid !== feedback.chatflowid) {
            throw new InternalFlowiseError(
                StatusCodes.BAD_REQUEST,
                `Inconsistent chatflow ID: message with ID ${message.id} does not belong to chatflow with ID ${feedback.chatflowid}`
            )
        }
    } else {
        // If not provided, use the message's chatflowid
        feedback.chatflowid = message.chatflowid
    }

    return feedback
}

/**
 * Validates a feedback update and returns the only fields an update may change: `rating` and `content`.
 * API-11: every other field in the body (id, chatflowid, chatId, messageId, createdDate, ...) is ignored, so an update
 * can never move a row to another message, chat or flow.
 * @param {string} feedbackId
 * @param {Partial<IChatMessageFeedback>} feedback
 */
export const validateFeedbackForUpdate = async (
    feedbackId: string,
    feedback: Partial<IChatMessageFeedback>
): Promise<Pick<Partial<IChatMessageFeedback>, 'rating' | 'content'>> => {
    await validateFeedbackExists(feedbackId)
    const update: Pick<Partial<IChatMessageFeedback>, 'rating' | 'content'> = {}
    if (feedback?.rating !== undefined) update.rating = validateRating(feedback.rating)
    if (feedback?.content !== undefined && feedback?.content !== null) update.content = validateContent(feedback.content)
    return update
}
