import { Request } from 'express'
import { upsertVector } from '../../utils/upsertVector'
import { toUpsertAppError } from '../../utils/upsertErrors'

const upsertVectorMiddleware = async (req: Request, isInternal: boolean = false) => {
    try {
        return await upsertVector(req, isInternal)
    } catch (error) {
        throw toUpsertAppError(error, 'Error: vectorsService.upsertVector - ')
    }
}

export default {
    upsertVectorMiddleware
}
