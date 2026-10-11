import { guardBeforeUnload } from './usePrompt'

const MESSAGE = 'You have unsaved changes! Do you want to navigate away?'

// A window stand-in that records beforeunload listeners and fires them with a browser-like event.
function fakeWindow() {
    const listeners = new Set()
    return {
        addEventListener: (type, fn) => type === 'beforeunload' && listeners.add(fn),
        removeEventListener: (type, fn) => type === 'beforeunload' && listeners.delete(fn),
        listeners,
        unload() {
            const event = { defaultPrevented: false, returnValue: '' }
            event.preventDefault = () => {
                event.defaultPrevented = true
            }
            for (const fn of listeners) fn(event)
            return event
        }
    }
}

describe('guardBeforeUnload', () => {
    it('asks the browser to confirm leaving while the guard is on', () => {
        const win = fakeWindow()
        guardBeforeUnload(win, MESSAGE)
        const event = win.unload()
        expect(event.defaultPrevented).toBe(true)
        expect(event.returnValue).toBe(MESSAGE)
    })

    it('lets the page go once the guard is removed', () => {
        const win = fakeWindow()
        const remove = guardBeforeUnload(win, MESSAGE)
        remove()
        const event = win.unload()
        expect(event.defaultPrevented).toBe(false)
        expect(event.returnValue).toBe('')
        expect(win.listeners.size).toBe(0)
    })

    it('removes only its own listener', () => {
        const win = fakeWindow()
        const other = jest.fn()
        win.addEventListener('beforeunload', other)
        guardBeforeUnload(win, MESSAGE)()
        win.unload()
        expect(other).toHaveBeenCalledTimes(1)
        expect(win.listeners.size).toBe(1)
    })
})
