import { Request } from 'express'
import { ChatFlow } from '../database/entities/ChatFlow'
import { ApiKey } from '../database/entities/ApiKey'
import { authenticateRequest, authorizeFlowKey } from '../services/accessKeys/authorization'

/** Public routes share the same access principal and policy as the workspace API. */
export const validateFlowAPIKey = async (req: Request, chatflow: ChatFlow): Promise<boolean> => authorizeFlowKey(req, chatflow)

export const validateAPIKey = async (req: Request): Promise<{ isValid: boolean; apiKey?: ApiKey }> => {
    const apiKey = await authenticateRequest(req)
    return { isValid: !!apiKey, apiKey }
}
