import { NextFunction, Request, Response } from 'express'
import logService from '../../services/log'

const queryText = (value: unknown): string => (typeof value === 'string' ? value : '')

const getLogs = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const apiResponse = await logService.getLogs(
            queryText(req.query?.startDate),
            queryText(req.query?.endDate),
            queryText(req.query?.level) || undefined
        )
        res.setHeader('Cache-Control', 'no-store')
        res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

export default {
    getLogs
}
