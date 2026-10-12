import { Request } from 'express'
import { StatusCodes } from 'http-status-codes'
import { utilBuildChatflow } from '../../utils/buildChatflow'
import { ChatType } from '../../Interface'
import { AppError } from '../../errors/appError'
import { getErrorMessage } from '../../errors/utils'

const buildChatflow = async (req: Request, chatType?: ChatType) => {
    try {
        const dbResponse = await utilBuildChatflow(req, false, chatType)
        return dbResponse
    } catch (error) {
        if (error instanceof AppError) throw error
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: predictionsServices.buildChatflow - ${getErrorMessage(error)}`)
    }
}

export default {
    buildChatflow
}
