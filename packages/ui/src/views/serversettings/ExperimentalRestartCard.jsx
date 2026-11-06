import { useState } from 'react'
import PropTypes from 'prop-types'

import { alpha, useTheme } from '@mui/material/styles'
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Paper, Stack, Typography } from '@mui/material'
import { IconRefresh } from '@tabler/icons-react'

import { SENTENCE_CASE_BUTTONS } from './layout'

// Experimental settings are startup settings. This card reuses the page restart path so run draining,
// supervised restart progress and manual restart steps stay in one place.
const ExperimentalRestartCard = ({ inPlace, onRestart }) => {
    const theme = useTheme()
    const [confirmOpen, setConfirmOpen] = useState(false)

    const confirm = () => {
        setConfirmOpen(false)
        onRestart()
    }

    return (
        <>
            <Paper
                variant='outlined'
                data-testid='experimental-restart-card'
                sx={{
                    borderRadius: 3,
                    p: 2.5,
                    mb: 3,
                    maxWidth: 880,
                    background: `linear-gradient(135deg, ${alpha(
                        theme.palette.warning.main,
                        theme.palette.mode === 'dark' ? 0.14 : 0.06
                    )} 0%, ${alpha(theme.palette.warning.main, 0)} 70%)`
                }}
            >
                <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} alignItems={{ sm: 'center' }}>
                    <Box
                        sx={{
                            width: 46,
                            height: 46,
                            borderRadius: 3,
                            flexShrink: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: theme.palette.warning.main,
                            backgroundColor: alpha(theme.palette.warning.main, 0.14)
                        }}
                    >
                        <IconRefresh size={24} stroke={1.7} />
                    </Box>
                    <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                        <Typography sx={{ fontWeight: 650, fontSize: '1.02rem' }}>Apply Experimental settings</Typography>
                        <Typography variant='body2' color='text.secondary' sx={{ mt: 0.5, maxWidth: 650 }}>
                            Dashflows BETA is a startup setting, not a runtime flag. Restarting applies it, interrupts the service, and
                            stops in-flight chats and agent runs unless you choose to let them finish.
                        </Typography>
                    </Box>
                    <Button
                        variant='contained'
                        color='warning'
                        disableElevation
                        startIcon={<IconRefresh size={17} />}
                        onClick={() => setConfirmOpen(true)}
                        sx={{ borderRadius: 2.5, px: 2.5, flexShrink: 0, whiteSpace: 'nowrap' }}
                        data-testid='experimental-restart-action'
                    >
                        {inPlace ? 'Restart server' : 'How to restart'}
                    </Button>
                </Stack>
            </Paper>

            <Dialog
                open={confirmOpen}
                onClose={() => setConfirmOpen(false)}
                maxWidth='xs'
                fullWidth
                PaperProps={{ sx: { borderRadius: 3, ...SENTENCE_CASE_BUTTONS } }}
                data-testid='experimental-restart-confirmation'
            >
                <DialogTitle sx={{ fontSize: '1.15rem', fontWeight: 600, pb: 0.5 }}>
                    {inPlace ? 'Restart the server?' : 'Show restart steps?'}
                </DialogTitle>
                <DialogContent>
                    <Typography variant='body2' color='text.secondary'>
                        {inPlace
                            ? 'Restarting interrupts Cuttlely. Chats and agent runs that are still answering may stop. If runs are active, you can choose to let them finish before the restart.'
                            : 'Cuttlely cannot restart itself in this setup. Continue to see the manual restart steps; this does not stop the server.'}
                    </Typography>
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
                    <Button onClick={() => setConfirmOpen(false)} data-testid='experimental-restart-cancel'>
                        Cancel
                    </Button>
                    <Button
                        variant='contained'
                        color={inPlace ? 'warning' : 'primary'}
                        disableElevation
                        onClick={confirm}
                        data-testid='experimental-restart-confirm'
                    >
                        {inPlace ? 'Continue' : 'Show steps'}
                    </Button>
                </DialogActions>
            </Dialog>
        </>
    )
}

ExperimentalRestartCard.propTypes = {
    inPlace: PropTypes.bool,
    onRestart: PropTypes.func.isRequired
}

export default ExperimentalRestartCard
