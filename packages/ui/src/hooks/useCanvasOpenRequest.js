import { useCallback, useEffect, useRef } from 'react'

// One controller follows a saved canvas from its flow read into its draft-status read. Starting another open
// cancels the previous one, and leaving the mounted canvas cancels whichever read or retry is still active.
export default () => {
    const activeRequestRef = useRef(null)

    const abort = useCallback((flowId) => {
        const active = activeRequestRef.current
        if (!active || (flowId !== undefined && active.flowId !== flowId)) return
        activeRequestRef.current = null
        active.controller.abort()
    }, [])

    const start = useCallback(
        (flowId) => {
            abort()
            const controller = new AbortController()
            activeRequestRef.current = { flowId, controller }
            return controller.signal
        },
        [abort]
    )

    const signalFor = useCallback(
        (flowId) => {
            const active = activeRequestRef.current
            return active?.flowId === flowId && !active.controller.signal.aborted ? active.controller.signal : start(flowId)
        },
        [start]
    )

    useEffect(() => () => abort(), [abort])

    return { abort, start, signalFor }
}
