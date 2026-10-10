import PropTypes from 'prop-types'
import { useEffect, useRef } from 'react'
import { alpha, useTheme } from '@mui/material/styles'
import { Box, Button, Paper, Stack, Typography } from '@mui/material'
import { IconRefresh } from '@tabler/icons-react'

import { SAVE_BAR_BOTTOM, holdRoomForSaveBar } from './layout'

// One line with an ellipsis from sm up; on a phone the text wraps, so nothing is cut off.
const ONE_LINE_FROM_SM = { whiteSpace: { sm: 'nowrap' }, overflow: { sm: 'hidden' }, textOverflow: { sm: 'ellipsis' } }

// inPlace: the start script can restart the server. Otherwise the button explains how to restart it by hand.
const SaveBar = ({ editedCount, pendingCount, onReset, onReview, onDiscard, onRestart, inPlace }) => {
    const theme = useTheme()
    const editing = editedCount > 0
    const barRef = useRef(null)

    // Room for the bar on the page while it shows; see holdRoomForSaveBar.
    useEffect(() => holdRoomForSaveBar(barRef.current), [])

    return (
        <Box
            ref={barRef}
            sx={{
                position: 'fixed',
                bottom: SAVE_BAR_BOTTOM,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 1200,
                width: 'min(720px, calc(100vw - 32px))'
            }}
            data-testid='settings-save-bar'
        >
            <Paper
                elevation={0}
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: { xs: 'wrap', sm: 'nowrap' },
                    columnGap: 2,
                    rowGap: 1.25,
                    px: 2.5,
                    py: 1.5,
                    borderRadius: 3.5,
                    border: `1px solid ${theme.palette.divider}`,
                    backgroundColor: alpha(theme.palette.background.paper, 0.92),
                    backdropFilter: 'blur(10px)',
                    boxShadow: theme.palette.mode === 'dark' ? '0 12px 40px rgba(0,0,0,0.55)' : '0 12px 40px rgba(15, 23, 42, 0.16)'
                }}
            >
                <Box
                    sx={{
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        flexShrink: 0,
                        backgroundColor: editing ? theme.palette.primary.main : theme.palette.warning.main,
                        boxShadow: `0 0 0 4px ${alpha(editing ? theme.palette.primary.main : theme.palette.warning.main, 0.18)}`
                    }}
                />
                <Box sx={{ flex: { xs: '1 1 calc(100% - 26px)', sm: '1 1 auto' }, minWidth: 0 }} data-testid='settings-save-bar-text'>
                    <Typography sx={{ fontWeight: 600, ...ONE_LINE_FROM_SM }}>
                        {editing
                            ? `${editedCount} unsaved ${editedCount === 1 ? 'change' : 'changes'}`
                            : `${pendingCount} saved ${pendingCount === 1 ? 'change waits' : 'changes wait'} for a restart`}
                    </Typography>
                    <Typography variant='caption' color='text.secondary' component='div' sx={ONE_LINE_FROM_SM}>
                        {editing ? 'Review them before saving.' : 'The server is still running with its current settings.'}
                    </Typography>
                </Box>
                <Stack
                    direction='row'
                    alignItems='center'
                    gap={1}
                    sx={{ ml: 'auto', flexShrink: 0, '& .MuiButton-root': { whiteSpace: 'nowrap' } }}
                >
                    {editing ? (
                        <>
                            <Button onClick={onReset} color='inherit' sx={{ color: 'text.secondary' }}>
                                Reset
                            </Button>
                            <Button variant='contained' onClick={onReview} sx={{ borderRadius: 2, px: 2.5 }} data-testid='settings-review'>
                                Review and save
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button onClick={onDiscard} color='inherit' sx={{ color: 'text.secondary' }}>
                                Discard
                            </Button>
                            <Button
                                variant='contained'
                                onClick={onRestart}
                                startIcon={<IconRefresh size={16} />}
                                sx={{ borderRadius: 2, px: 2.5 }}
                                data-testid='settings-restart'
                            >
                                {inPlace ? 'Restart now' : 'How to restart'}
                            </Button>
                        </>
                    )}
                </Stack>
            </Paper>
        </Box>
    )
}

SaveBar.propTypes = {
    editedCount: PropTypes.number.isRequired,
    pendingCount: PropTypes.number.isRequired,
    onReset: PropTypes.func.isRequired,
    onReview: PropTypes.func.isRequired,
    onDiscard: PropTypes.func.isRequired,
    onRestart: PropTypes.func.isRequired,
    inPlace: PropTypes.bool
}

export default SaveBar
