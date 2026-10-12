import { Request, Response, NextFunction } from 'express'
import { AppError } from '../../errors/appError'
import { StatusCodes } from 'http-status-codes'
import evaluationsService from '../../services/evaluations'
import { getPageAndLimitParams } from '../../utils/pagination'

/** Prediction calls from a run. APP_URL wins when it is set. Otherwise the server calls itself. */
export function evaluationBaseUrl(): string {
    const configured = typeof process.env.APP_URL === 'string' ? process.env.APP_URL.trim() : ''
    if (configured && configured !== 'undefined') return configured.replace(/\/$/, '')
    const port = Number(process.env.PORT)
    const listenPort = Number.isInteger(port) && port > 0 ? String(port) : '3000'
    return `http://127.0.0.1:${listenPort}`
}

const createEvaluation = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.body) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: evaluationsService.createEvaluation - body not provided!`)
        }
        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new AppError(StatusCodes.NOT_FOUND, `Error: evaluationsService.createEvaluation - organization ${orgId} not found!`)
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(StatusCodes.NOT_FOUND, `Error: evaluationsService.createEvaluation - workspace ${workspaceId} not found!`)
        }
        const body = req.body
        body.workspaceId = workspaceId

        const apiResponse = await evaluationsService.createEvaluation(body, evaluationBaseUrl(), orgId, workspaceId, req)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const runAgain = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: evaluationsService.runAgain - id not provided!`)
        }
        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new AppError(StatusCodes.NOT_FOUND, `Error: evaluationsService.runAgain - organization ${orgId} not found!`)
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(StatusCodes.NOT_FOUND, `Error: evaluationsService.runAgain - workspace ${workspaceId} not found!`)
        }
        const apiResponse = await evaluationsService.runAgain(req.params.id, evaluationBaseUrl(), orgId, workspaceId, req)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getEvaluation = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: evaluationsService.getEvaluation - id not provided!`)
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(StatusCodes.NOT_FOUND, `Error: evaluationsService.getEvaluation - workspace ${workspaceId} not found!`)
        }
        const apiResponse = await evaluationsService.getEvaluation(req.params.id, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const deleteEvaluation = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: evaluationsService.deleteEvaluation - id not provided!`)
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(StatusCodes.NOT_FOUND, `Error: evaluationsService.deleteEvaluation - workspace ${workspaceId} not found!`)
        }
        const apiResponse = await evaluationsService.deleteEvaluation(req.params.id, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getAllEvaluations = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { page, limit } = getPageAndLimitParams(req)
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(StatusCodes.NOT_FOUND, `Error: evaluationsService.getAllEvaluations - workspace ${workspaceId} not found!`)
        }
        const apiResponse = await evaluationsService.getAllEvaluations(workspaceId, page, limit)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const isOutdated = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: evaluationsService.isOutdated - id not provided!`)
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(StatusCodes.NOT_FOUND, `Error: evaluationsService.isOutdated - workspace ${workspaceId} not found!`)
        }
        const apiResponse = await evaluationsService.isOutdated(req.params.id, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getVersions = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: evaluationsService.getVersions - id not provided!`)
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(StatusCodes.NOT_FOUND, `Error: evaluationsService.getVersions - workspace ${workspaceId} not found!`)
        }
        const apiResponse = await evaluationsService.getVersions(req.params.id, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const patchDeleteEvaluations = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const ids = req.body.ids ?? []
        const isDeleteAllVersion = req.body.isDeleteAllVersion ?? false
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(
                StatusCodes.NOT_FOUND,
                `Error: evaluationsService.patchDeleteEvaluations - workspace ${workspaceId} not found!`
            )
        }
        const apiResponse = await evaluationsService.patchDeleteEvaluations(ids, workspaceId, isDeleteAllVersion)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

export default {
    createEvaluation,
    getEvaluation,
    deleteEvaluation,
    getAllEvaluations,
    isOutdated,
    runAgain,
    getVersions,
    patchDeleteEvaluations
}
