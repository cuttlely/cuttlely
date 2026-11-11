import { useEffect, useRef, useState } from 'react'
import PropTypes from 'prop-types'

import { Box, Button, CircularProgress, Typography } from '@mui/material'

// Shown when a saved canvas could not load its draft status, and while that load is retried.
// The canvas stays mounted underneath, so opening and fitting it work as usual, but it is inert:
// no click, key or focus reaches its header or cards until the status is known.
export const canvasLoadBlocked = (flowId, loadState) => Boolean(flowId) && !(loadState?.flowId === flowId && loadState?.known)

export const canvasLoadRetryRequest = (flowId, loadState, loadedFlowId) =>
    loadState?.flowId === flowId && loadState?.request === 'status' && loadedFlowId === flowId ? 'status' : 'flow'

// Why the open failed, in the person's terms. A request with no answer is a connection problem; an answered
// request keeps the server's own reason (for example a deleted flow), so it does not look like a dropped connection.
export const canvasLoadFailureReason = (error) => {
    const response = error?.response
    if (!response) return 'The server could not be reached. Select Retry when the connection is back.'
    const data = response.data
    const message = typeof data === 'string' ? data : data?.message
    if (typeof message === 'string' && message.trim()) return `The server answered: ${message.trim()}`
    return response.status ? `The server answered with status ${response.status}.` : 'The server answered with an error.'
}

const CanvasLoadGuard = ({ flowId, loadState, onRetry, onBack, children }) => {
    const active = canvasLoadBlocked(flowId, loadState)
    const current = loadState?.flowId === flowId
    const failed = current ? loadState?.error : null
    const retrying = current && loadState?.retrying
    const [showDelayedOpening, setShowDelayedOpening] = useState(false)
    const contentRef = useRef(null)

    useEffect(() => {
        if (contentRef.current) contentRef.current.inert = active
    }, [active])

    useEffect(() => {
        setShowDelayedOpening(false)
        if (!active || failed || retrying) return undefined
        const timer = setTimeout(() => setShowDelayedOpening(true), 400)
        return () => clearTimeout(timer)
    }, [active, failed, retrying, flowId, loadState?.flowId])

    const showOverlay = active && Boolean(failed || retrying || showDelayedOpening)

    return (
        <>
            <Box ref={contentRef} aria-hidden={active || undefined} sx={{ display: 'contents' }}>
                {children}
            </Box>
            {showOverlay && (
                <Box
                    role='alertdialog'
                    aria-label='Saved canvas'
                    sx={{
                        position: 'fixed',
                        inset: 0,
                        zIndex: (theme) => theme.zIndex.modal + 1,
                        display: 'grid',
                        placeContent: 'center',
                        gap: 2,
                        px: 3,
                        textAlign: 'center',
                        bgcolor: 'background.default'
                    }}
                >
                    <Typography variant='h4'>{failed ? 'The saved canvas could not be opened' : 'Opening the saved canvas'}</Typography>
                    <Typography color='text.secondary'>
                        {failed
                            ? loadState?.request === 'flow'
                                ? 'The saved canvas could not be loaded. It stays closed so none of its actions can run.'
                                : 'Draft status could not be loaded. The canvas stays closed so none of its actions can run.'
                            : 'Checking the saved draft before the canvas opens.'}
                    </Typography>
                    {failed && <Typography color='text.secondary'>{canvasLoadFailureReason(failed)}</Typography>}
                    {failed ? (
                        <Button variant='contained' onClick={onRetry}>
                            Retry
                        </Button>
                    ) : (
                        <CircularProgress aria-label='Opening saved canvas' sx={{ justifySelf: 'center' }} />
                    )}
                    <Button variant='outlined' onClick={onBack}>
                        Back
                    </Button>
                </Box>
            )}
        </>
    )
}

CanvasLoadGuard.propTypes = {
    flowId: PropTypes.string,
    loadState: PropTypes.shape({
        flowId: PropTypes.string,
        loading: PropTypes.bool,
        retrying: PropTypes.bool,
        known: PropTypes.bool,
        request: PropTypes.oneOf(['flow', 'status']),
        error: PropTypes.any
    }),
    onRetry: PropTypes.func.isRequired,
    onBack: PropTypes.func.isRequired,
    children: PropTypes.node
}

export default CanvasLoadGuard
