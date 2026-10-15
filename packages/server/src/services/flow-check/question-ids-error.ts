// Stable 400 for a hand-picked question id that cannot be replayed.
// The response is { code, badCount }. The message stays the code so a log of the error
// cannot carry the question text, a file name, or the id the caller sent.
export class BadQuestionIdsError extends Error {
    readonly statusCode = 400
    readonly code = 'CHECK_BAD_QUESTION_IDS' as const
    constructor(readonly badCount: number) {
        super('CHECK_BAD_QUESTION_IDS')
    }
}
