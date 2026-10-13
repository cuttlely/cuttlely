import { getRawModelFile } from '@cuttlely/components'
import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { AppError } from '../../errors/appError'
import {
    catalogForOrganization,
    defaultsFromModelList,
    deleteOverride,
    loadOverrides,
    organizationIdForWorkspace,
    parseModelName,
    parseUsdPerMillion,
    priceRowFor,
    writeOverride
} from '../../services/usage'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'

async function organizationId(req: Request): Promise<string> {
    const workspaceId = req.user?.activeWorkspaceId
    if (!workspaceId) throw new AppError(StatusCodes.UNAUTHORIZED, 'Error: modelPrices - unauthorized!')
    const organizationId = await organizationIdForWorkspace(getRunningExpressApp().AppDataSource, workspaceId)
    if (!organizationId) throw new AppError(StatusCodes.BAD_REQUEST, 'This workspace has no organization.')
    return organizationId
}

function modelFrom(req: Request): string {
    const body = req.body && typeof req.body === 'object' ? (req.body as { model?: unknown }).model : undefined
    const query = typeof req.query?.model === 'string' ? req.query.model : undefined
    const parsed = parseModelName(body ?? query)
    if (!parsed.ok) throw new AppError(StatusCodes.BAD_REQUEST, parsed.message)
    return parsed.model
}

const list = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await organizationId(req)
        const catalog = await catalogForOrganization(getRunningExpressApp().AppDataSource, orgId, await getRawModelFile())
        return res.json(catalog)
    } catch (error) {
        next(error)
    }
}

const set = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await organizationId(req)
        const model = modelFrom(req)
        const body = (req.body || {}) as { input?: unknown; output?: unknown }
        const input = parseUsdPerMillion(body.input, 'input')
        if (!input.ok) throw new AppError(StatusCodes.BAD_REQUEST, input.message)
        const output = parseUsdPerMillion(body.output, 'output')
        if (!output.ok) throw new AppError(StatusCodes.BAD_REQUEST, output.message)
        const dataSource = getRunningExpressApp().AppDataSource
        await writeOverride(dataSource, orgId, model, input.value, output.value)
        const listFile = await getRawModelFile()
        const row = priceRowFor(model, defaultsFromModelList(listFile), await loadOverrides(dataSource, orgId))
        return res.json(row)
    } catch (error) {
        next(error)
    }
}

const clear = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await organizationId(req)
        const model = modelFrom(req)
        const dataSource = getRunningExpressApp().AppDataSource
        await deleteOverride(dataSource, orgId, model)
        const row = priceRowFor(model, defaultsFromModelList(await getRawModelFile()), await loadOverrides(dataSource, orgId))
        return res.json(row)
    } catch (error) {
        next(error)
    }
}

export default { list, set, clear }
