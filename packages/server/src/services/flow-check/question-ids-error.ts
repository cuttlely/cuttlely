// Reasons name the failure. They do not repeat the id or the question text.
export type QuestionIdReason = 'invalid' | 'not-found' | 'files' | 'length'

const REASON_PHRASE: Record<QuestionIdReason, string> = {
    invalid: 'is not a question id',
    'not-found': 'was not found on this flow',
    files: 'was sent with a file',
    length: 'is longer than 2,000 characters'
}

// Shown by the dialog. Positions are 1-based. The text does not include the id or the question.
export function questionIdFailureMessage(errors: QuestionIdFailure[], badCount: number): string {
    if (!errors.length) {
        return badCount === 1 ? '1 question cannot be checked.' : `${badCount} questions cannot be checked.`
    }
    return errors.map((item) => `Position ${item.index + 1} ${REASON_PHRASE[item.reason]}.`).join(' ')
}

export interface QuestionIdFailure {
    index: number
    reason: QuestionIdReason
}

// Stable 400 for a hand-picked question id that cannot be replayed.
// The response is { code, badCount, errors }. The message stays the code so a log of the error
// cannot carry the question text, a file name, or the id the caller sent.
export class BadQuestionIdsError extends Error {
    readonly statusCode = 400
    readonly code = 'CHECK_BAD_QUESTION_IDS' as const
    readonly errors: QuestionIdFailure[]
    constructor(readonly badCount: number, errors: QuestionIdFailure[] = []) {
        super('CHECK_BAD_QUESTION_IDS')
        this.errors = errors
    }
}

// A 400 whose code is distinct from CHECK_BAD_QUESTION_IDS. The message is safe to return.
export class CheckRuleError extends Error {
    readonly statusCode = 400
    constructor(readonly code: string, message: string) {
        super(message)
    }
}
