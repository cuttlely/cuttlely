import { useEffect } from 'react'
import { useBlocker } from 'react-router-dom'

// Asks the browser to confirm a reload, tab close or full-page navigation while there are unsaved changes.
// Browsers show their own wording; the message is only used where a browser still reads returnValue.
export function guardBeforeUnload(target, message) {
    const onBeforeUnload = (event) => {
        event.preventDefault()
        event.returnValue = message
        return message
    }
    target.addEventListener('beforeunload', onBeforeUnload)
    return () => target.removeEventListener('beforeunload', onBeforeUnload)
}

// Asks before leaving the page while `when` is true, for example a canvas with unsaved changes. useBlocker covers
// navigation inside the app (links, Back, browser back); the beforeunload guard covers reload, closing the tab and
// leaving the app.
export function usePrompt(message, when = true) {
    const blocker = useBlocker(when)

    useEffect(() => {
        if (blocker.state !== 'blocked') return
        if (window.confirm(message)) blocker.proceed()
        else blocker.reset()
    }, [blocker, message])

    useEffect(() => {
        if (!when) return undefined
        return guardBeforeUnload(window, message)
    }, [when, message])
}
