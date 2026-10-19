/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
jest.mock('@/store/constant', () => ({ IT_WORKED_URL: 'https://github.com/cuttlely/cuttlely' }))
jest.mock('@/store/context/ConfigContext', () => ({
    useConfig: () => ({ config: { IT_WORKED_DISABLED: false }, loading: false })
}))
jest.mock('notistack', () => ({
    useSnackbar: () => ({ enqueueSnackbar: jest.fn(), closeSnackbar: jest.fn() })
}))

import {
    dismissItWorked,
    markItWorkedShown,
    setItWorkedStorageReader,
    shouldShowItWorked,
    shouldToastOnStreamEnd,
    itWorkedUrl
} from './itWorked'

describe('itWorked UI helpers', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    test('URL constant points to GitHub', () => {
        expect(itWorkedUrl.startsWith('https://github.com/cuttlely/cuttlely')).toBe(true)
    })

    test('does not show before a success or after the marker is already present', () => {
        const cfg = { IT_WORKED_DISABLED: false }
        expect(shouldShowItWorked(cfg)).toBe(true)
        markItWorkedShown()
        expect(shouldShowItWorked(cfg)).toBe(false)
    })

    test('shows once after first success and not after dismissal', () => {
        const cfg = { IT_WORKED_DISABLED: false }
        expect(shouldShowItWorked(cfg)).toBe(true)
        markItWorkedShown()
        expect(shouldShowItWorked(cfg)).toBe(false)
        dismissItWorked()
        expect(shouldShowItWorked(cfg)).toBe(false)
    })

    test('opt-out via config disables it', () => {
        const cfg = { IT_WORKED_DISABLED: true }
        expect(shouldShowItWorked(cfg)).toBe(false)
    })

    test('fails closed when settings are still loading or never arrived', () => {
        const cfg = { IT_WORKED_DISABLED: false }
        expect(shouldShowItWorked(cfg, { configLoading: true })).toBe(false)
        expect(shouldShowItWorked(cfg, { configFailed: true })).toBe(false)
        expect(shouldShowItWorked({})).toBe(false)
        expect(shouldShowItWorked(undefined)).toBe(false)
    })

    test('treats a throwing localStorage as do not show', () => {
        setItWorkedStorageReader(() => {
            throw new Error('quota')
        })
        try {
            expect(shouldShowItWorked({ IT_WORKED_DISABLED: false })).toBe(false)
        } finally {
            setItWorkedStorageReader(null)
        }
    })

    test('stream toast only after a real result with no error or abort', () => {
        expect(shouldToastOnStreamEnd({ sawResult: false, sawError: false, sawAbort: false })).toBe(false)
        expect(shouldToastOnStreamEnd({ sawResult: true, sawError: true, sawAbort: false })).toBe(false)
        expect(shouldToastOnStreamEnd({ sawResult: true, sawError: false, sawAbort: true })).toBe(false)
        expect(shouldToastOnStreamEnd({ sawResult: true, sawError: false, sawAbort: false })).toBe(true)
    })

    test('no network calls in helper path', () => {
        const cfg = { IT_WORKED_DISABLED: false }
        if (typeof global.fetch === 'function') {
            const fetchSpy = jest.spyOn(global, 'fetch')
            expect(shouldShowItWorked(cfg)).toBe(true)
            markItWorkedShown()
            dismissItWorked()
            expect(shouldToastOnStreamEnd({ sawResult: true })).toBe(true)
            expect(fetchSpy).not.toHaveBeenCalled()
            fetchSpy.mockRestore()
        } else {
            expect(shouldShowItWorked(cfg)).toBe(true)
            markItWorkedShown()
            expect(shouldShowItWorked(cfg)).toBe(false)
        }
    })
})
