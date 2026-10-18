import { Request, Response, NextFunction } from 'express'
import _ from 'lodash'
import nodesService from '../../services/nodes'
import { loadNodePackIndex } from '../../utils/nodePacks'
import { ClientType, VALID_CLIENT_TYPES } from '@cuttlely/components'
import { AppError } from '../../errors/appError'
import { StatusCodes } from 'http-status-codes'
import { getWorkspaceSearchOptionsFromReq } from '../../identity/workspaceScope'
import { callerKeyHarnesses } from '../../services/harnesses/apiAccess'

// if req.query.client does not contain a valid client type, then return undefined so it won't filter the nodes unnecessarily
const parseClientParam = (req: Request): ClientType | undefined => {
    const raw = req.query.client as ClientType | undefined
    return raw && VALID_CLIENT_TYPES.has(raw) ? (raw as ClientType) : undefined
}

const getNodePackIndex = async (_req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json({ nodes: loadNodePackIndex() })
    } catch (error) {
        next(error)
    }
}

const getAllNodes = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const apiResponse = await nodesService.getAllNodes(parseClientParam(req))
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getNodeByName = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.name) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: nodesController.getNodeByName - name not provided!`)
        }
        const apiResponse = await nodesService.getNodeByName(req.params.name, parseClientParam(req))
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getNodesByCategory = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params.name === 'undefined' || req.params.name === '') {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: nodesController.getNodesByCategory - name not provided!`)
        }
        const name = _.unescape(req.params.name)
        const apiResponse = await nodesService.getAllNodesForCategory(name, parseClientParam(req))
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

// Neutral mark for a node name that is not in the pool. Keeps the canvas image request from failing.
const UNKNOWN_NODE_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#e6e5e0"/><circle cx="32" cy="28" r="8" fill="#26251e" fill-opacity="0.35"/></svg>'

const getSingleNodeIcon = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.name) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: nodesController.getSingleNodeIcon - name not provided!`)
        }
        const apiResponse = await nodesService.getSingleNodeIcon(req.params.name)
        if (!apiResponse) {
            res.status(StatusCodes.OK).type('image/svg+xml').send(UNKNOWN_NODE_ICON)
            return
        }
        return res.sendFile(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getSingleNodeAsyncOptions = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.body) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: nodesController.getSingleNodeAsyncOptions - body not provided!`)
        }
        if (typeof req.params === 'undefined' || !req.params.name) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: nodesController.getSingleNodeAsyncOptions - name not provided!`)
        }
        const body = req.body
        body.searchOptions = getWorkspaceSearchOptionsFromReq(req)
        const workspaceId = req.user?.activeWorkspaceId
        const apiResponse = await nodesService.getSingleNodeAsyncOptions(req.params.name, body, workspaceId, await callerKeyHarnesses(req))
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const executeCustomFunction = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.body) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: nodesController.executeCustomFunction - body not provided!`)
        }
        const orgId = req.user?.activeOrganizationId
        const workspaceId = req.user?.activeWorkspaceId
        const canViewVariables = !!(req.user?.isOrganizationAdmin || req.user?.permissions?.includes('variables:view'))
        const apiResponse = await nodesService.executeCustomFunction(req.body, workspaceId, orgId, canViewVariables)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

export default {
    getNodePackIndex,
    getAllNodes,
    getNodeByName,
    getSingleNodeIcon,
    getSingleNodeAsyncOptions,
    executeCustomFunction,
    getNodesByCategory
}
