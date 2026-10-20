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

import fs from 'fs'
import path from 'path'

import {
    claimItWorkedShown,
    dismissItWorked,
    markItWorkedShown,
    presentItWorked,
    setItWorkedStorageReader,
    setItWorkedStorageWriter,
    shouldShowItWorked,
    shouldToastOnStreamEnd,
    itWorkedUrl,
    IT_WORKED_HIDE_MS,
    IT_WORKED_SHARE_EVENT
} from './itWorked'

describe('itWorked UI helpers', () => {
    beforeEach(() => {
        localStorage.clear()
        setItWorkedStorageReader(null)
        setItWorkedStorageWriter(null)
    })

    afterEach(() => {
        setItWorkedStorageReader(null)
        setItWorkedStorageWriter(null)
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

    test('does not claim a toast when the shown marker cannot persist', () => {
        const cfg = { IT_WORKED_DISABLED: false }
        const writer = jest.fn(() => {
            throw new Error('quota')
        })
        setItWorkedStorageWriter(writer)
        expect(shouldShowItWorked(cfg)).toBe(true)
        expect(markItWorkedShown()).toBe(false)
        expect(claimItWorkedShown(cfg)).toBe(false)
        expect(claimItWorkedShown(cfg)).toBe(false)
        expect(shouldShowItWorked(cfg)).toBe(true)
        expect(writer).toHaveBeenCalled()
        expect(localStorage.getItem('cuttlely.itWorked.shown')).toBe(null)
    })

    test('does not claim a toast when localStorage is missing', () => {
        const cfg = { IT_WORKED_DISABLED: false }
        setItWorkedStorageReader(null)
        setItWorkedStorageWriter(null)
        const original = global.localStorage
        Object.defineProperty(global, 'localStorage', {
            configurable: true,
            get() {
                return undefined
            }
        })
        try {
            expect(markItWorkedShown()).toBe(false)
            expect(claimItWorkedShown(cfg)).toBe(false)
        } finally {
            Object.defineProperty(global, 'localStorage', {
                configurable: true,
                enumerable: true,
                value: original,
                writable: true
            })
        }
    })

    test('does not mark the toast shown when display throws', () => {
        const cfg = { IT_WORKED_DISABLED: false }
        expect(() =>
            presentItWorked({
                enqueueSnackbar: () => {
                    throw new Error('snackbar down')
                },
                closeSnackbar: () => undefined,
                config: cfg,
                options: {}
            })
        ).toThrow('snackbar down')
        expect(localStorage.getItem('cuttlely.itWorked.shown')).toBe(null)
        expect(shouldShowItWorked(cfg)).toBe(true)
    })

    test('names the next step, hides on its own, and marks shown only after display', () => {
        const calls = []
        const shown = presentItWorked({
            enqueueSnackbar: (message, options) => calls.push({ message, options }),
            closeSnackbar: () => undefined,
            config: { IT_WORKED_DISABLED: false },
            options: {}
        })
        expect(shown).toBe(true)
        expect(calls[0].message).toBe('It worked! Next: share this flow via API / embed it →')
        expect(calls[0].options.autoHideDuration).toBe(IT_WORKED_HIDE_MS)
        expect(calls[0].options.persist).toBeUndefined()
        expect(localStorage.getItem('cuttlely.itWorked.shown')).toBe('true')
        const source = fs.readFileSync(path.join(__dirname, 'itWorked.jsx'), 'utf8')
        expect(source).toContain(IT_WORKED_SHARE_EVENT)
        expect(source).toContain('markItWorkedShown()')
    })

    test('the canvas listens for the share event', () => {
        const header = fs.readFileSync(path.join(__dirname, '../views/canvas/CanvasHeader.jsx'), 'utf8')
        expect(header).toContain(`'${IT_WORKED_SHARE_EVENT}'`)
        expect(header).not.toContain("from '@/utils/itWorked'")
        expect(header).not.toContain('from "./itWorked"')
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
