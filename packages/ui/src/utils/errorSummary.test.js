import {
    NO_ANSWER_MESSAGE,
    PUBLISH_NO_ANSWER_MESSAGE,
    SAVE_NO_ANSWER_MESSAGE,
    configurationLoadFailureMessage,
    errorSummary,
    publishFailureMessage,
    requestFailureMessage,
    saveFailureMessage,
    settingFailureMessage
} from './errorSummary'

const noAnswer = () => Object.assign(new Error('Network Error'), { isAxiosError: true, request: {} })

describe('request failure messages', () => {
    test('keeps reload guidance for a page-level request with no answer', () => {
        expect(requestFailureMessage(noAnswer())).toBe(NO_ANSWER_MESSAGE)
    })

    test('keeps gateway bodies out of ordinary read and page errors', () => {
        for (const status of [502, 503, 504]) {
            const error = { response: { status, data: '<html>gateway</html>' } }
            expect(requestFailureMessage(error)).toBe(NO_ANSWER_MESSAGE)
            expect(errorSummary(error)).toEqual({ status: `Status: ${status}`, message: NO_ANSWER_MESSAGE })
        }
    })

    test('keeps canvas edits and asks the person to save again after a failed save', () => {
        expect(saveFailureMessage(noAnswer())).toBe(SAVE_NO_ANSWER_MESSAGE)
        expect(saveFailureMessage(noAnswer())).not.toContain('reload')
        for (const status of [502, 503, 504]) {
            expect(saveFailureMessage({ response: { status, data: '<html>gateway</html>' } })).toBe(SAVE_NO_ANSWER_MESSAGE)
            expect(publishFailureMessage({ response: { status, data: '<html>gateway</html>' } })).toBe(PUBLISH_NO_ANSWER_MESSAGE)
        }
    })

    test('prefers a server save message and otherwise uses the supplied fallback', () => {
        expect(saveFailureMessage({ response: { data: { message: 'The draft changed.' } } })).toBe('The draft changed.')
        expect(saveFailureMessage({}, 'Could not save the settings.')).toBe('Could not save the settings.')
    })

    test('uses the publish action and says that nothing was published', () => {
        expect(publishFailureMessage(noAnswer())).toBe(PUBLISH_NO_ANSWER_MESSAGE)
        expect(publishFailureMessage(noAnswer())).toBe(
            'Publish not confirmed. The server could not be reached, so Cuttlely cannot tell whether this version went Live. Check the Live status before you publish again.'
        )
    })

    test('uses the setting fallback without telling the person to press Save', () => {
        expect(settingFailureMessage(noAnswer(), 'The draft setting could not be saved.')).toBe(
            'The draft setting could not be saved. The server could not be reached. Try again when the connection is back.'
        )
        expect(settingFailureMessage(noAnswer(), 'Could not update this setting')).toBe(
            'Could not update this setting. The server could not be reached. Try again when the connection is back.'
        )
    })

    test('keeps gateway bodies out of nested configuration load errors', () => {
        expect(configurationLoadFailureMessage(noAnswer())).toBe('The server did not answer.')
        for (const status of [502, 503, 504]) {
            expect(configurationLoadFailureMessage({ response: { status, data: '<html>gateway</html>' } })).toBe(
                'The server could not be reached.'
            )
        }
        expect(configurationLoadFailureMessage({ response: { status: 400, data: { message: 'Choose a component.' } } })).toBe(
            'Choose a component.'
        )
        expect(configurationLoadFailureMessage({ response: { status: 500, data: {} } })).toBe('The server answered with status 500.')
    })
})
