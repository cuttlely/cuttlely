import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { LoggedInUser } from '../../identity/types'
import { AppError } from '../../errors/appError'
import apikeyService from '../../services/apikey'
import harnessesService from '../../services/harnesses'
import { assertCallerMayGrant, noteHarnessAudit, parseHarnessAllowlist } from '../../services/harnesses/apiAccess'
import { getPageAndLimitParams } from '../../utils/pagination'

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

// Names in the request body, checked against the caller's team. A harness in another team is refused like a missing one.
// A name the key already stored whose harness is gone is dropped, so an edit that sends the stored list back still saves.
// An API key caller may only grant harnesses on its own list.
async function requestedHarnesses(req: Request, workspaceId: string, stored: string[] = []): Promise<string[] | undefined> {
    const body = req.body as Record<string, unknown>
    if (!('harnesses' in body)) return undefined
    const names = parseHarnessAllowlist(body.harnesses)
    if (!names.length) return names
    const known = new Set((await harnessesService.listHarnesses(workspaceId)).map((row: { name: string }) => row.name))
    const kept = names.filter((name) => known.has(name) || !stored.includes(name))
    const missing = kept.find((name) => !known.has(name))
    if (missing) throw new AppError(StatusCodes.BAD_REQUEST, `Harness ${missing} was not found in this team.`)
    await assertCallerMayGrant(req, kept)
    return kept
}

function sameList(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((name) => b.includes(name))
}

async function noteAccessChange(req: Request, keyId: string, keyName: string, before: string[], after: string[]) {
    if (sameList(before, after)) return
    await noteHarnessAudit(req, 'harness_access', 'API key harness access changed', {
        keyId,
        keyName: String(keyName).slice(0, 100),
        harnesses: after,
        previous: before
    })
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
        const harnesses = (await requestedHarnesses(req, user.activeWorkspaceId)) || []
        const apiResponse = await apikeyService.createApiKey(user, req.body.keyName, req.body.permissions, harnesses)
        if (harnesses.length) {
            const rows = (Array.isArray(apiResponse) ? apiResponse : []) as Array<{ id?: string; apiKey?: string }>
            const created = rows.find((row) => typeof row.apiKey === 'string' && row.apiKey)
            await noteAccessChange(req, created?.id || '', req.body.keyName, [], harnesses)
        }
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
        const stored = 'harnesses' in req.body ? await apikeyService.getApiKeyById(req.params.id) : undefined
        const before = stored && stored.workspaceId === user.activeWorkspaceId ? stored : undefined
        const harnesses = await requestedHarnesses(req, user.activeWorkspaceId, Array.isArray(before?.harnesses) ? before.harnesses : [])
        const apiResponse = await apikeyService.updateApiKey(user, req.params.id, req.body.keyName, req.body.permissions, harnesses)
        if (harnesses !== undefined && before) {
            await noteAccessChange(req, req.params.id, req.body.keyName, Array.isArray(before.harnesses) ? before.harnesses : [], harnesses)
        }
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
        if (typeof req.params === 'undefined' || !req.params.apikey) {
            throw new AppError(StatusCodes.PRECONDITION_FAILED, `Error: apikeyController.verifyApiKey - apikey not provided!`)
        }
        const apiResponse = await apikeyService.verifyApiKey(req.params.apikey)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

export default {
    createApiKey,
    deleteApiKey,
    getAllApiKeys,
    updateApiKey,
    verifyApiKey
}
