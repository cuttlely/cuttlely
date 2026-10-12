import { NextFunction, Request, Response } from 'express'
import logService from '../../services/log'

const queryText = (value: unknown): string => (typeof value === 'string' ? value : '')

const getLogs = async (req: Request, res: Response, next: NextFunction) => {
    try {
        // The capped body is finished before any response bytes are written.
        const apiResponse = await logService.getLogs({
            startDate: queryText(req.query?.startDate) || undefined,
            endDate: queryText(req.query?.endDate) || undefined,
            level: queryText(req.query?.level) || undefined,
            range: queryText(req.query?.range) || undefined
        })
        if (res.headersSent) return
        res.setHeader('Cache-Control', 'no-store')
        res.status(200).json(apiResponse)
    } catch (error) {
        if (res.headersSent) {
            res.end()
            return
        }
        next(error)
    }
}

export default {
    getLogs
}
