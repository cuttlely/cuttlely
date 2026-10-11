import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import demoService from '../../services/demo'
import { actorFromUser } from '../../services/flow-versions/author'

const workspaceOf = (req: Request) => {
    const workspaceId = req.user?.activeWorkspaceId
    if (!workspaceId) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'No active workspace. Sign in to a workspace and try again.')
    return workspaceId
}

const status = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await demoService.status(workspaceOf(req)))
    } catch (error) {
        next(error)
    }
}

const create = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const workspaceId = workspaceOf(req)
        const orgId = req.user?.activeOrganizationId
        if (!orgId) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'No active organization. Sign in and try again.')
        const result = await demoService.create(
            req.body?.credentialId,
            {
                orgId,
                workspaceId,
                subscriptionId: req.user?.activeOrganizationSubscriptionId || '',
                actor: actorFromUser(req.user)
            },
            req.body?.demo
        )
        return res.json(result)
    } catch (error) {
        next(error)
    }
}

export default { status, create }
