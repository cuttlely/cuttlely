import { Request, Response, NextFunction } from 'express'
import { AppError } from '../../errors/appError'
import datasetService from '../../services/dataset'
import { questionPickErrorBody } from '../../services/flow-check/history'
import { StatusCodes } from 'http-status-codes'
import { getPageAndLimitParams } from '../../utils/pagination'
import { stripProtectedFields } from '../../utils/stripProtectedFields'

const getAllDatasets = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { page, limit } = getPageAndLimitParams(req)
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(StatusCodes.NOT_FOUND, `Error: datasetController.getAllDatasets - workspace ${workspaceId} not found!`)
        }
        const apiResponse = await datasetService.getAllDatasets(workspaceId, page, limit)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getDataset = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: datasetService.getDataset - id not provided!`)
        }
        const { page, limit } = getPageAndLimitParams(req)
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(StatusCodes.NOT_FOUND, `Error: datasetController.getDataset - workspace ${workspaceId} not found!`)
        }
        const apiResponse = await datasetService.getDataset(req.params.id, workspaceId, page, limit)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const createDataset = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.body) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: datasetService.createDataset - body not provided!`)
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(StatusCodes.NOT_FOUND, `Error: datasetController.createDataset - workspace ${workspaceId} not found!`)
        }
        const body = { ...stripProtectedFields(req.body), workspaceId }
        const apiResponse = await datasetService.createDataset(body, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const createDatasetFromQuestions = async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
        if (!req.body) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: datasetService.createDatasetFromQuestions - body not provided!`)
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(StatusCodes.UNAUTHORIZED, 'Unauthorized')
        }
        const body = stripProtectedFields(req.body)
        const apiResponse = await datasetService.createDatasetFromQuestions(
            { flowId: body.flowId, questionIds: body.questionIds, name: body.name },
            workspaceId,
            req
        )
        return res.json(apiResponse)
    } catch (error) {
        const picked = questionPickErrorBody(error)
        if (picked) return res.status(picked.statusCode).json(picked.body)
        next(error)
    }
}

const updateDataset = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.body) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: datasetService.updateDataset - body not provided!`)
        }
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: datasetService.updateDataset - id not provided!`)
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(StatusCodes.NOT_FOUND, `Error: datasetController.updateDataset - workspace ${workspaceId} not found!`)
        }
        const apiResponse = await datasetService.updateDataset(req.params.id, stripProtectedFields(req.body), workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const deleteDataset = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: datasetService.deleteDataset - id not provided!`)
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(StatusCodes.NOT_FOUND, `Error: datasetController.deleteDataset - workspace ${workspaceId} not found!`)
        }
        const apiResponse = await datasetService.deleteDataset(req.params.id, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const addDatasetRow = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.body) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: datasetService.addDatasetRow - body not provided!`)
        }
        if (!req.body.datasetId) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: datasetService.addDatasetRow - datasetId not provided!`)
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(StatusCodes.NOT_FOUND, `Error: datasetController.addDatasetRow - workspace ${workspaceId} not found!`)
        }
        const body = { ...stripProtectedFields(req.body), workspaceId }
        const apiResponse = await datasetService.addDatasetRow(body)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const addDatasetRowFromChatMessage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.body) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: datasetService.addDatasetRowFromChatMessage - body not provided!`)
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(
                StatusCodes.NOT_FOUND,
                `Error: datasetController.addDatasetRowFromChatMessage - workspace ${workspaceId} not found!`
            )
        }
        const body = stripProtectedFields(req.body)
        const apiResponse = await datasetService.addDatasetRowFromChatMessage(
            { datasetId: body.datasetId, messageId: body.messageId, output: body.output },
            workspaceId,
            req
        )
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const addDatasetRowsFromRatings = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.body) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: datasetService.addDatasetRowsFromRatings - body not provided!`)
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(
                StatusCodes.NOT_FOUND,
                `Error: datasetController.addDatasetRowsFromRatings - workspace ${workspaceId} not found!`
            )
        }
        const body = stripProtectedFields(req.body)
        const apiResponse = await datasetService.addDatasetRowsFromRatings(
            {
                datasetId: body.datasetId,
                flowId: body.flowId,
                rating: body.rating,
                days: body.days,
                limit: body.limit,
                dryRun: body.dryRun,
                cursor: body.cursor,
                feedbackIds: body.feedbackIds
            },
            workspaceId,
            req
        )
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const updateDatasetRow = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.body) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: datasetService.updateDatasetRow - body not provided!`)
        }
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: datasetService.updateDatasetRow - id not provided!`)
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(StatusCodes.NOT_FOUND, `Error: datasetController.updateDatasetRow - workspace ${workspaceId} not found!`)
        }
        const body = { ...stripProtectedFields(req.body), workspaceId }
        const apiResponse = await datasetService.updateDatasetRow(req.params.id, body)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const deleteDatasetRow = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: datasetService.deleteDatasetRow - id not provided!`)
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(StatusCodes.NOT_FOUND, `Error: datasetController.deleteDatasetRow - workspace ${workspaceId} not found!`)
        }
        const apiResponse = await datasetService.deleteDatasetRow(req.params.id, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const patchDeleteRows = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const ids = req.body.ids ?? []
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(StatusCodes.NOT_FOUND, `Error: datasetController.patchDeleteRows - workspace ${workspaceId} not found!`)
        }
        const apiResponse = await datasetService.patchDeleteRows(ids, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const reorderDatasetRow = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.body) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: datasetService.reorderDatasetRow - body not provided!`)
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new AppError(StatusCodes.NOT_FOUND, `Error: datasetController.reorderDatasetRow - workspace ${workspaceId} not found!`)
        }
        const apiResponse = await datasetService.reorderDatasetRow(req.body.datasetId, req.body.rows, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}
export default {
    getAllDatasets,
    getDataset,
    createDataset,
    createDatasetFromQuestions,
    updateDataset,
    deleteDataset,
    addDatasetRow,
    addDatasetRowFromChatMessage,
    addDatasetRowsFromRatings,
    updateDatasetRow,
    deleteDatasetRow,
    patchDeleteRows,
    reorderDatasetRow
}
