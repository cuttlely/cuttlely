import { useEffect, useRef, useState } from 'react'
import PropTypes from 'prop-types'

import { alpha, useTheme } from '@mui/material/styles'
import { Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Paper, Stack, Typography } from '@mui/material'
import { IconCheck, IconCopy, IconPlayerPlay, IconRefresh, IconX } from '@tabler/icons-react'

import { baseURL } from '@/store/constant'
import {
    POLL_MS,
    initialRestart,
    nextRestart,
    readProbe,
    restartFailed,
    restartSteps,
    restartSummary,
    restartTitle,
    withOutcome
} from './restart'
import { SENTENCE_CASE_BUTTONS } from './layout'

async function ping() {
    try {
        const res = await fetch(`${baseURL}/api/v1/ping`, { cache: 'no-store', credentials: 'same-origin' })
        const isJson = (res.headers.get('content-type') || '').includes('application/json')
        return { status: res.status, body: isJson ? await res.json().catch(() => null) : null }
    } catch {
        return { error: true }
    }
}

const StepIcon = ({ status }) => {
    const theme = useTheme()
    if (status === 'done') {
        return (
            <Box
                sx={{
                    width: 26,
                    height: 26,
                    borderRadius: '50%',
                    display: 'grid',
                    placeItems: 'center',
                    bgcolor: alpha(theme.palette.success.main, 0.14),
                    color: theme.palette.success.main
                }}
            >
                <IconCheck size={16} stroke={2.4} />
            </Box>
        )
    }
    if (status === 'failed') {
        return (
            <Box
                sx={{
                    width: 26,
                    height: 26,
                    borderRadius: '50%',
                    display: 'grid',
                    placeItems: 'center',
                    bgcolor: alpha(theme.palette.error.main, 0.12),
                    color: theme.palette.error.main
                }}
            >
                <IconX size={15} stroke={2.4} />
            </Box>
        )
    }
    if (status === 'active') {
        return (
            <Box sx={{ width: 26, height: 26, display: 'grid', placeItems: 'center' }}>
                <CircularProgress size={20} thickness={5} />
            </Box>
        )
    }
    return (
        <Box sx={{ width: 26, height: 26, display: 'grid', placeItems: 'center' }}>
            <Box sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: theme.palette.divider }} />
        </Box>
    )
}
StepIcon.propTypes = { status: PropTypes.string.isRequired }

// Full-screen while Cuttlely restarts: saved, runs finishing, stopping, starting (with the live start-up step), back.
// Once back, checkOutcome tells whether the new settings started or safe boot put back the last ones that worked.
export const RestartScreen = ({ open, saved, waitingFor, onBack, checkOutcome }) => {
    const theme = useTheme()
    const [state, setState] = useState(() => initialRestart({ saved, waitingFor, startedAt: Date.now() }))
    const told = useRef(false)

    useEffect(() => {
        if (!open) return undefined
        told.current = false
        let current = initialRestart({ saved, waitingFor, startedAt: Date.now() })
        setState(current)
        let stop = false
        let timer
        const tick = async () => {
            const probe = readProbe(await ping())
            if (stop) return
            current = nextRestart(current, probe, Date.now())
            setState(current)
            if (!current.back) {
                timer = setTimeout(tick, POLL_MS)
                return
            }
            let rolledBack = null
            try {
                rolledBack = checkOutcome ? await checkOutcome() : false
            } catch {
                rolledBack = null
            }
            if (stop) return
            current = withOutcome(current, rolledBack)
            setState(current)
        }
        timer = setTimeout(tick, POLL_MS)
        return () => {
            stop = true
            clearTimeout(timer)
        }
    }, [open, saved, waitingFor, checkOutcome])

    const steps = restartSteps(state)
    return (
        <Dialog
            open={open}
            fullScreen
            PaperProps={{
                sx: {
                    ...SENTENCE_CASE_BUTTONS,
                    background: `radial-gradient(1200px 600px at 50% -10%, ${alpha(theme.palette.primary.main, 0.12)}, transparent 60%), ${
                        theme.palette.background.default
                    }`
                }
            }}
            data-testid='restart-screen'
        >
            <Box sx={{ minHeight: '100%', display: 'grid', placeItems: 'center', p: 3 }}>
                <Paper
                    elevation={0}
                    sx={{
                        width: '100%',
                        maxWidth: 460,
                        p: { xs: 3, sm: 4 },
                        borderRadius: 4,
                        border: `1px solid ${theme.palette.divider}`,
                        boxShadow: `0 24px 60px ${alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.5 : 0.08)}`
                    }}
                >
                    <Typography variant='h2' sx={{ fontSize: '1.4rem', fontWeight: 650 }}>
                        {restartTitle(state)}
                    </Typography>
                    <Typography color='text.secondary' sx={{ mt: 0.75, mb: 3 }} data-testid='restart-summary'>
                        {restartSummary(state)}
                    </Typography>
                    <Stack gap={0}>
                        {steps.map((step, index) => (
                            <Stack
                                key={step.id}
                                direction='row'
                                gap={1.75}
                                data-testid={`restart-step-${step.id}`}
                                data-status={step.status}
                            >
                                <Stack alignItems='center'>
                                    <StepIcon status={step.status} />
                                    {index < steps.length - 1 && (
                                        <Box
                                            sx={{
                                                width: 2,
                                                flex: 1,
                                                minHeight: 14,
                                                my: 0.5,
                                                borderRadius: 1,
                                                bgcolor:
                                                    step.status === 'done' ? alpha(theme.palette.success.main, 0.4) : theme.palette.divider
                                            }}
                                        />
                                    )}
                                </Stack>
                                <Typography
                                    sx={{
                                        pt: 0.4,
                                        pb: 1.5,
                                        fontWeight: step.status === 'active' ? 600 : 500,
                                        color: step.status === 'waiting' ? 'text.disabled' : 'text.primary'
                                    }}
                                >
                                    {step.label}
                                </Typography>
                            </Stack>
                        ))}
                    </Stack>
                    {state.back && state.outcome !== 'checking' && (
                        <Button
                            fullWidth
                            variant={restartFailed(state) ? 'outlined' : 'contained'}
                            disableElevation
                            sx={{ mt: 2, borderRadius: 2, py: 1 }}
                            onClick={() => {
                                if (told.current) return
                                told.current = true
                                onBack(state.outcome)
                            }}
                            data-testid='restart-continue'
                            data-outcome={state.outcome}
                        >
                            {restartFailed(state) ? 'See what changed' : 'Continue'}
                        </Button>
                    )}
                    {state.slow && !state.back && (
                        <Button
                            fullWidth
                            variant='outlined'
                            startIcon={<IconRefresh size={16} />}
                            sx={{ mt: 2, borderRadius: 2 }}
                            onClick={() => window.location.reload()}
                        >
                            Reload the page
                        </Button>
                    )}
                </Paper>
            </Box>
        </Dialog>
    )
}
RestartScreen.propTypes = {
    open: PropTypes.bool.isRequired,
    saved: PropTypes.number,
    waitingFor: PropTypes.number,
    onBack: PropTypes.func.isRequired,
    checkOutcome: PropTypes.func
}

// Runs in progress: let them finish (up to the turn time limit) or restart now.
export const RestartChoice = ({ open, runs, onClose, onChoose }) => (
    <Dialog open={open} onClose={onClose} maxWidth='xs' fullWidth PaperProps={{ sx: { borderRadius: 3, ...SENTENCE_CASE_BUTTONS } }}>
        <DialogTitle sx={{ fontSize: '1.15rem', fontWeight: 600, pb: 0.5 }}>
            {runs?.inProgress === 1 ? 'One run is in progress' : `${runs?.inProgress ?? 0} runs are in progress`}
        </DialogTitle>
        <DialogContent>
            <Typography variant='body2' color='text.secondary'>
                Restarting stops chats and agent team runs that are still answering. Cuttlely can let them finish first, for up to{' '}
                {runs?.waitSeconds ?? 45} s. New runs wait until it is back.
            </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
            <Button onClick={onClose}>Cancel</Button>
            <Button color='warning' onClick={() => onChoose(false)} data-testid='restart-now'>
                Restart now
            </Button>
            <Button
                variant='contained'
                disableElevation
                startIcon={<IconPlayerPlay size={15} />}
                onClick={() => onChoose(true)}
                data-testid='restart-let-finish'
            >
                Let them finish
            </Button>
        </DialogActions>
    </Dialog>
)
RestartChoice.propTypes = {
    open: PropTypes.bool.isRequired,
    runs: PropTypes.object,
    onClose: PropTypes.func.isRequired,
    onChoose: PropTypes.func.isRequired
}

// When Cuttlely cannot restart itself: the steps, with a copy button.
export const RestartSteps = ({ open, steps, onClose }) => {
    const [copied, setCopied] = useState(false)
    useEffect(() => {
        if (open) setCopied(false)
    }, [open])
    const copy = async () => {
        try {
            await navigator.clipboard.writeText((steps ?? []).join('\n'))
            setCopied(true)
        } catch {
            setCopied(false)
        }
    }
    return (
        <Dialog open={open} onClose={onClose} PaperProps={{ sx: { borderRadius: 3, ...SENTENCE_CASE_BUTTONS } }}>
            <DialogTitle sx={{ fontWeight: 600 }}>Restart Cuttlely to apply</DialogTitle>
            <DialogContent>
                <Stack gap={1}>
                    {(steps ?? []).map((step) => (
                        <Typography key={step}>{step}</Typography>
                    ))}
                </Stack>
            </DialogContent>
            <DialogActions sx={{ px: 3, pb: 2 }}>
                <Button
                    startIcon={copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
                    onClick={copy}
                    data-testid='restart-steps-copy'
                >
                    {copied ? 'Copied' : 'Copy steps'}
                </Button>
                <Button onClick={onClose}>Close</Button>
            </DialogActions>
        </Dialog>
    )
}
RestartSteps.propTypes = {
    open: PropTypes.bool.isRequired,
    steps: PropTypes.array,
    onClose: PropTypes.func.isRequired
}
