import { useEffect } from 'react'
import { useBlocker } from 'react-router-dom'

// Asks before leaving the page while `when` is true, for example a canvas with unsaved changes.
export function usePrompt(message, when = true) {
    const blocker = useBlocker(when)

    useEffect(() => {
        if (blocker.state !== 'blocked') return
        if (window.confirm(message)) blocker.proceed()
        else blocker.reset()
    }, [blocker, message])
}
