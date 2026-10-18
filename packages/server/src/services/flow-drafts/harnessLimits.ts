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

// restoreDraft is Restore while the canvas saves to a draft: the version would become the draft, not Live.
export type LimitAction = 'save' | 'restore' | 'restoreDraft' | 'rollback' | 'promote'

const RESTORE = {
    lead: 'This version cannot be restored.',
    matched: 'It cannot be restored.',
    instead: 'Restore another version, or shorten those rules on the canvas and save.'
}

// Restore, Roll back and Promote cannot shorten the version they put back, so their refusal says what to do instead.
// kept names what the refused action would have changed.
const PUT_BACK: Record<Exclude<LimitAction, 'save'>, { lead: string; matched: string; instead: string; kept: string }> = {
    restore: { ...RESTORE, kept: 'Live is' },
    restoreDraft: { ...RESTORE, kept: 'the draft is' },
    rollback: {
        lead: 'Live cannot be rolled back to this version.',
        matched: 'Live cannot be rolled back to it.',
        instead: 'Roll back to another version, or shorten those rules on the canvas and save.',
        kept: 'Live is'
    },
    promote: {
        lead: 'This version cannot be promoted.',
        matched: 'It cannot be promoted.',
        instead: 'Shorten those rules on the canvas where this version was made, publish it there, and promote again.',
        kept: 'Live is'
    }
}

// The harness record limits (assertRosterLimits) on a draft canvas, so a draft cannot hold what Publish would refuse.
// matchesLive: the version is already Live, so the refusal says first that nothing changes.
export async function assertHarnessDraftLimits(
    name: string,
    flowData: string,
    action: LimitAction = 'save',
    matchesLive = false
): Promise<void> {
    const sync = await loadSync()
    try {
        sync.assertFlowLimits({ name, flowData })
    } catch (error: any) {
        const words = action !== 'save' && error?.problem ? PUT_BACK[action] : null
        const message = !words
            ? getErrorMessage(error)
            : matchesLive
            ? `This version matches Live, so ${words.kept} unchanged. ${words.matched} ${error.problem} ${words.instead}`
            : `${words.lead} ${error.problem} ${words.instead}`
        throw new AppError(StatusCodes.BAD_REQUEST, message)
    }
}
