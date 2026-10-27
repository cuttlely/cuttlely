import { StatusCodes } from 'http-status-codes'
import { AppError } from '../../errors/appError'

export interface DraftSaver {
    id: string | null
    name: string
}

// A save would replace a shared draft the caller has not seen. Nothing was written.
export class DraftChangedError extends AppError {
    code: 'DRAFT_CHANGED'
    savedBy: DraftSaver
    savedAt: string | null

    constructor(savedBy: DraftSaver, savedAt: string | null) {
        super(
            StatusCodes.CONFLICT,
            `${savedBy.name} saved this draft after you opened it. Reload to see their changes, or send overwriteDraftChanges: true to replace them.`
        )
        this.code = 'DRAFT_CHANGED'
        this.savedBy = savedBy
        this.savedAt = savedAt
    }
}
