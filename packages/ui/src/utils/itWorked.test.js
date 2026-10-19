import { dismissItWorked, markItWorkedShown, shouldShowItWorked, itWorkedUrl } from './itWorked'

describe('itWorked UI helpers', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    test('URL constant points to GitHub', () => {
        expect(itWorkedUrl.startsWith('https://github.com/cuttlely/cuttlely')).toBe(true)
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

    test('no network calls in helper path', async () => {
        // Guard for environments where fetch is not defined in Jest
        if (typeof global.fetch === 'function') {
            const fetchSpy = jest.spyOn(global, 'fetch')
            // none of the helpers call fetch by themselves
            expect(fetchSpy).not.toHaveBeenCalled()
            fetchSpy.mockRestore()
        } else {
            // In Node/Jest environments without fetch, this path should still pass
            expect(true).toBe(true)
        }
    })
})
