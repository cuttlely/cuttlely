import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { StatusCodes } from 'http-status-codes'
import { AppError } from '../../errors/appError'
import { getErrorMessage } from '../../errors/utils'

// tsc rewrites import() into require(), which cannot load the ESM harness package.
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>

async function loadSync() {
    let dir = __dirname
    for (let i = 0; i < 8; i += 1) {
        const candidates = [path.join(dir, 'packages', 'harness', 'sync-from-flow.mjs'), path.join(dir, 'harness', 'sync-from-flow.mjs')]
        const candidate = candidates.find((file) => fs.existsSync(file))
        if (candidate) return importEsm(pathToFileURL(candidate).href)
        dir = path.dirname(dir)
    }
    throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, 'Harness draft save could not find the harness engine.')
}

// The harness record limits (assertRosterLimits) on a draft canvas, so a draft cannot hold what Publish would refuse.
export async function assertHarnessDraftLimits(name: string, flowData: string): Promise<void> {
    const sync = await loadSync()
    try {
        sync.assertFlowLimits({ name, flowData })
    } catch (error) {
        throw new AppError(StatusCodes.BAD_REQUEST, getErrorMessage(error))
    }
}
