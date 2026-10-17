import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { LoggedInUser } from '../../identity/types'
import { AppError } from '../../errors/appError'
import apikeyService from '../../services/apikey'
import { getPageAndLimitParams } from '../../utils/pagination'
import { API_KEY_IN_URL_MESSAGE, bearerApiKey } from '../../utils/apiKey'

function actor(user: LoggedInUser | undefined) {
    if (!user?.activeWorkspaceId || !user.permissions) {
        throw new AppError(StatusCodes.UNAUTHORIZED, 'Unauthorized')
    }
    return {
        id: user.id,
        email: user.email,
        permissions: user.permissions,
        features: user.features,
        isOrganizationAdmin: user.isOrganizationAdmin,
        activeOrganizationId: user.activeOrganizationId ?? undefined,
        activeOrganizationSubscriptionId: user.activeOrganizationSubscriptionId ?? undefined,
        activeOrganizationCustomerId: user.activeOrganizationCustomerId ?? undefined,
        activeWorkspaceId: user.activeWorkspaceId
    }
}

// Get api keys
const getAllApiKeys = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const user = actor(req.user)

        if (req.query?.type === 'organization' && user.isOrganizationAdmin && user.activeOrganizationId)
            return res.status(StatusCodes.OK).json(await apikeyService.getAllApiKeysByOrganization(user.activeOrganizationId))

        const { page, limit } = getPageAndLimitParams(req)
        const apiResponse = await apikeyService.getAllApiKeys(user, page, limit)
        return res.status(StatusCodes.OK).json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const createApiKey = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.body === 'undefined' || !req.body.keyName) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: apikeyController.createApiKey - keyName not provided!`)
        }
        if (
            !req.body.permissions ||
            !Array.isArray(req.body.permissions) ||
            req.body.permissions.length === 0 ||
            !req.body.permissions.every((p: any) => typeof p === 'string')
        ) {
            throw new AppError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: apikeyController.createApiKey - permissions must be an array of strings!`
            )
        }
        const user = actor(req.user)
        const apiResponse = await apikeyService.createApiKey(user, req.body.keyName, req.body.permissions)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

// Update api key
const updateApiKey = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: apikeyController.updateApiKey - id not provided!`)
        }
        if (typeof req.body === 'undefined' || !req.body.keyName) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: apikeyController.updateApiKey - keyName not provided!`)
        }
        if (
            !req.body.permissions ||
            !Array.isArray(req.body.permissions) ||
            req.body.permissions.length === 0 ||
            !req.body.permissions.every((p: any) => typeof p === 'string')
        ) {
            throw new AppError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: apikeyController.updateApiKey - permissions must be an array of strings!`
            )
        }
        const user = actor(req.user)
        const apiResponse = await apikeyService.updateApiKey(user, req.params.id, req.body.keyName, req.body.permissions)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

// Delete api key
const deleteApiKey = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: apikeyController.deleteApiKey - id not provided!`)
        }
        if (!req.user?.activeWorkspaceId) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Workspace ID is required`)
        }
        const apiResponse = await apikeyService.deleteApiKey(req.params.id, req.user?.activeWorkspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

// Verify api key
const verifyApiKey = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const suppliedKey = bearerApiKey(req.headers.authorization)
        if (!suppliedKey) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: apikeyController.verifyApiKey - apikey not provided!`)
        }
        const apiResponse = await apikeyService.verifyApiKey(suppliedKey)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

// The path value is never read, so a key sent this way is not checked.
const refuseApiKeyInUrl = (_req: Request, res: Response) => {
    res.status(StatusCodes.BAD_REQUEST).json({ message: API_KEY_IN_URL_MESSAGE })
}

export default {
    createApiKey,
    deleteApiKey,
    getAllApiKeys,
    updateApiKey,
    verifyApiKey,
    refuseApiKeyInUrl
}
