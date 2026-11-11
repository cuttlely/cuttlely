import PropTypes from 'prop-types'

import { Box, Button, CircularProgress, Typography } from '@mui/material'

const CanvasLoadGuard = ({ flowId, loadState, onRetry, onBack, children }) => {
    const active = Boolean(flowId && loadState?.flowId === flowId && (loadState.loading || loadState.error))

    if (!active) return children

    return (
        <Box
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
            <Typography variant='h4'>{loadState.loading ? 'Opening the saved canvas' : 'The saved canvas could not be opened'}</Typography>
            <Typography color='text.secondary'>
                {loadState.loading
                    ? 'Checking the saved draft before the canvas opens.'
                    : 'Draft status could not be loaded. The canvas stays closed so none of its actions can run.'}
            </Typography>
            {loadState.loading ? (
                <CircularProgress aria-label='Opening saved canvas' sx={{ justifySelf: 'center' }} />
            ) : (
                <Button variant='contained' onClick={onRetry}>
                    Retry
                </Button>
            )}
            <Button variant='outlined' onClick={onBack}>
                Back
            </Button>
        </Box>
    )
}

CanvasLoadGuard.propTypes = {
    flowId: PropTypes.string,
    loadState: PropTypes.shape({
        flowId: PropTypes.string,
        loading: PropTypes.bool,
        error: PropTypes.any
    }),
    onRetry: PropTypes.func.isRequired,
    onBack: PropTypes.func.isRequired,
    children: PropTypes.node
}

export default CanvasLoadGuard
