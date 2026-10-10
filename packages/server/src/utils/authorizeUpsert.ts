import { NextFunction, Request, RequestHandler, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { ChatFlow } from '../database/entities/ChatFlow'
import { DocumentStore } from '../database/entities/DocumentStore'
import { Organization } from '../database/entities/identity'
import { Workspace } from '../database/entities/identity'
import { InternalFlowiseError } from '../errors/internalFlowiseError'
import { getRunningExpressApp } from './getRunningExpressApp'
import { validateFlowAPIKey } from './validateKey'

/**
 * Per-flow check for vector upsert, before multer. External calls need the flow's API key.
 * Both external and internal calls need a session whose active workspace owns the flow.
 * A miss is 401 or 404 and writes nothing.
 */
export const authorizeVectorUpsert =
    (isInternal: boolean): RequestHandler =>
    async (req: Request, _res: Response, next: NextFunction) => {
        try {
            const chatflowid = req.params.id
            const chatflow = chatflowid
                ? await getRunningExpressApp().AppDataSource.getRepository(ChatFlow).findOneBy({ id: chatflowid })
                : null
            if (!chatflow) {
                throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${chatflowid} not found`)
            }
            if (!isInternal) {
                const isKeyValidated = await validateFlowAPIKey(req, chatflow)
                if (!isKeyValidated) {
                    throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, 'Unauthorized')
                }
            }
            const workspace = await getRunningExpressApp().AppDataSource.getRepository(Workspace).findOneBy({
                id: chatflow.workspaceId
            })
            if (!workspace) {
                throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Workspace ${chatflow.workspaceId} not found`)
            }
            if (workspace.id !== req.user?.activeWorkspaceId) {
                throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, 'Unauthorized')
            }
            const org = await getRunningExpressApp().AppDataSource.getRepository(Organization).findOneBy({
                id: workspace.organizationId
            })
            if (!org) {
                throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Organization ${workspace.organizationId} not found`)
            }
            next()
        } catch (error) {
            next(error)
        }
    }

/**
 * Document-store upsert permission already ran. This checks the caller's org and workspace,
 * and refuses a store that belongs to another workspace, before multer.
 */
export const authorizeDocumentStoreUpsert: RequestHandler = async (req, _res, next) => {
    try {
        if (typeof req.params.id === 'undefined' || req.params.id === '') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.upsertDocStoreMiddleware - storeId not provided!`
            )
        }
        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.createDocumentStore - organizationId not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.createDocumentStore - workspaceId not provided!`
            )
        }
        const store = await getRunningExpressApp().AppDataSource.getRepository(DocumentStore).findOneBy({ id: req.params.id })
        if (store && store.workspaceId !== workspaceId) {
            throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, 'Unauthorized')
        }
        next()
    } catch (error) {
        next(error)
    }
}
