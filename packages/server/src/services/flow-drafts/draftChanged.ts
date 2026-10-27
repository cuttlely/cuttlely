import { StatusCodes } from 'http-status-codes'
import { AppError } from '../../errors/appError'

export interface DraftSaver {
    id: string | null
    name: string
}

export type DraftChangedAction = 'save' | 'publish'

const MESSAGES: Record<DraftChangedAction, (name: string) => string> = {
    save: (name) =>
        `${name} saved this draft after you opened it. Reload to see their changes, or send overwriteDraftChanges: true to replace them.`,
    publish: (name) =>
        `${name} saved this draft after you opened it, so nothing was published. Reload to see their changes, or send overwriteDraftChanges: true to publish their draft.`
}

// A save or a publish would act on a shared draft the caller has not seen. Nothing was written.
export class DraftChangedError extends AppError {
    code: 'DRAFT_CHANGED'
    savedBy: DraftSaver
    savedAt: string | null

    constructor(savedBy: DraftSaver, savedAt: string | null, action: DraftChangedAction = 'save') {
        super(StatusCodes.CONFLICT, MESSAGES[action](savedBy.name))
        this.code = 'DRAFT_CHANGED'
        this.savedBy = savedBy
        this.savedAt = savedAt
    }
}
