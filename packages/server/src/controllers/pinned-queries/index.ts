import { NextFunction, Request, Response } from 'express'
import { suggestPinnedTypes, testPinnedQuery } from '../../services/pinned-queries'

const suggest = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await suggestPinnedTypes(req))
    } catch (error) {
        next(error)
    }
}

const test = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await testPinnedQuery(req))
    } catch (error) {
        next(error)
    }
}

export default {
    suggest,
    test
}
