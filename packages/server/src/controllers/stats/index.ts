import { StatusCodes } from 'http-status-codes'
import { Request, Response, NextFunction } from 'express'
import statsService from '../../services/stats'
import { getRawModelFile } from '@cuttlely/components'
import { priceBookForWorkspace, queryTokenUsage, usageRange } from '../../services/usage'
import { ChatType } from '../../Interface'
import { AppError } from '../../errors/appError'
import { feedbackTypeFilters } from '../../utils/feedbackTypeFilters'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'

const getChatflowStats = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: statsController.getChatflowStats - id not provided!`)
        }
        const activeWorkspaceId = req.user?.activeWorkspaceId
        if (!activeWorkspaceId) {
            throw new AppError(StatusCodes.UNAUTHORIZED, `Error: statsController.getChatflowStats - unauthorized!`)
        }
        const chatflowid = req.params.id
        const _chatTypes = req.query?.chatType as string | undefined
        let chatTypes: ChatType[] | undefined
        if (_chatTypes) {
            try {
                if (Array.isArray(_chatTypes)) {
                    chatTypes = _chatTypes
                } else {
                    chatTypes = JSON.parse(_chatTypes)
                }
            } catch (e) {
                chatTypes = [_chatTypes as ChatType]
            }
        }
        const startDate = req.query?.startDate as string | undefined
        const endDate = req.query?.endDate as string | undefined
        const feedbackTypes = feedbackTypeFilters(req.query?.feedbackType)
        const apiResponse = await statsService.getChatflowStats(chatflowid, activeWorkspaceId, chatTypes, startDate, endDate, feedbackTypes)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getTokenUsage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const activeWorkspaceId = req.user?.activeWorkspaceId
        if (!activeWorkspaceId) {
            throw new AppError(StatusCodes.UNAUTHORIZED, `Error: statsController.getTokenUsage - unauthorized!`)
        }
        const parsed = usageRange({
            days: req.query?.days,
            startDate: req.query?.startDate,
            endDate: req.query?.endDate,
            range: req.query?.range
        })
        if (!parsed.ok) {
            throw new AppError(StatusCodes.BAD_REQUEST, parsed.message)
        }
        const flowId = typeof req.query?.flowId === 'string' ? req.query.flowId : undefined
        const model = typeof req.query?.model === 'string' ? req.query.model : undefined
        const dataSource = getRunningExpressApp().AppDataSource
        const book = await priceBookForWorkspace(dataSource, activeWorkspaceId, await getRawModelFile())
        const apiResponse = await queryTokenUsage(
            dataSource,
            {
                workspaceId: activeWorkspaceId,
                startDate: parsed.range.startDate,
                endDate: parsed.range.endDate,
                flowId,
                model
            },
            book
        )
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

export default {
    getChatflowStats,
    getTokenUsage
}
