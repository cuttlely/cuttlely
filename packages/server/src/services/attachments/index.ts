import { Request } from 'express'
import { StatusCodes } from 'http-status-codes'
import { createFileAttachment } from '../../utils/createAttachment'
import { AppError } from '../../errors/appError'
import { getErrorMessage } from '../../errors/utils'

const createAttachment = async (req: Request) => {
    try {
        return await createFileAttachment(req)
    } catch (error) {
        if (error instanceof AppError && error.statusCode < StatusCodes.INTERNAL_SERVER_ERROR) throw error
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: attachmentService.createAttachment - ${getErrorMessage(error)}`)
    }
}

export default {
    createAttachment
}
