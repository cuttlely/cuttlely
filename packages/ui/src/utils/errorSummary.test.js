import { NO_ANSWER_MESSAGE, SAVE_NO_ANSWER_MESSAGE, requestFailureMessage, saveFailureMessage } from './errorSummary'

const noAnswer = () => Object.assign(new Error('Network Error'), { isAxiosError: true, request: {} })

describe('request failure messages', () => {
    test('keeps reload guidance for a page-level request with no answer', () => {
        expect(requestFailureMessage(noAnswer())).toBe(NO_ANSWER_MESSAGE)
    })

    test('keeps canvas edits and asks the person to save again after a failed save', () => {
        expect(saveFailureMessage(noAnswer())).toBe(SAVE_NO_ANSWER_MESSAGE)
        expect(saveFailureMessage(noAnswer())).not.toContain('reload')
    })

    test('prefers a server save message and otherwise uses the supplied fallback', () => {
        expect(saveFailureMessage({ response: { data: { message: 'The draft changed.' } } })).toBe('The draft changed.')
        expect(saveFailureMessage({}, 'Could not save the settings.')).toBe('Could not save the settings.')
    })
})
