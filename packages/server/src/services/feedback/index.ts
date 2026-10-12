import { StatusCodes } from 'http-status-codes'
import { utilGetChatMessageFeedback } from '../../utils/getChatMessageFeedback'
import { utilAddChatMessageFeedback } from '../../utils/addChatMessageFeedback'
import { utilUpdateChatMessageFeedback } from '../../utils/updateChatMessageFeedback'
import { IChatMessageFeedback } from '../../Interface'
import { AppError } from '../../errors/appError'
import { getErrorMessage } from '../../errors/utils'

// Get all chatmessage feedback from chatflowid
const getAllChatMessageFeedback = async (
    chatflowid: string,
    chatId: string | undefined,
    sortOrder: string | undefined,
    startDate: string | undefined,
    endDate: string | undefined
) => {
    try {
        const dbResponse = await utilGetChatMessageFeedback(chatflowid, chatId, sortOrder, startDate, endDate)
        return dbResponse
    } catch (error) {
        throw new AppError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: feedbackService.getAllChatMessageFeedback - ${getErrorMessage(error)}`
        )
    }
}

// Add chatmessage feedback
const createChatMessageFeedbackForChatflow = async (requestBody: Partial<IChatMessageFeedback>): Promise<any> => {
    try {
        const dbResponse = await utilAddChatMessageFeedback(requestBody)
        return dbResponse
    } catch (error) {
        throw new AppError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: feedbackService.createChatMessageFeedbackForChatflow - ${getErrorMessage(error)}`
        )
    }
}

// Add chatmessage feedback
const updateChatMessageFeedbackForChatflow = async (feedbackId: string, requestBody: Partial<IChatMessageFeedback>): Promise<any> => {
    try {
        const dbResponse = await utilUpdateChatMessageFeedback(feedbackId, requestBody)
        return dbResponse
    } catch (error) {
        throw new AppError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: feedbackService.updateChatMessageFeedbackForChatflow - ${getErrorMessage(error)}`
        )
    }
}

export default {
    getAllChatMessageFeedback,
    createChatMessageFeedbackForChatflow,
    updateChatMessageFeedbackForChatflow
}
