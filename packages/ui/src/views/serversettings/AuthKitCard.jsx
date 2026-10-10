// The AuthKit card at the top of Sign-in: is it set up, which WorkOS environment, and did a test sign-in pass.
import PropTypes from 'prop-types'

import { alpha, useTheme } from '@mui/material/styles'
import { Box, Button, Chip, Paper, Stack, Typography } from '@mui/material'
import { IconCircleCheckFilled, IconInfoCircle, IconShieldCheck } from '@tabler/icons-react'

import { ENVIRONMENT_LABELS } from './authkit'

const formatDate = (iso) => {
    try {
        return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    } catch {
        return iso
    }
}

const AuthKitCard = ({ authKit, onOpen }) => {
    const theme = useTheme()
    const complete = Boolean(authKit?.complete)
    const tested = Boolean(authKit?.tested)
    const title = !complete ? 'Sign in with WorkOS AuthKit' : tested ? 'AuthKit is set up' : 'AuthKit is set up, not tested yet'
    const body = !complete
        ? 'Let people sign in with their own WorkOS account: email, Google, Microsoft and more. A guided setup fills in the addresses, makes the session seal and runs a real test sign-in before anything is saved.'
        : tested
        ? `A test sign-in passed on ${formatDate(authKit.testedAt)}. Password sign-in can be turned off.`
        : 'Run a test sign-in before you turn password sign-in off. Password sign-in stays on until a test passes.'
    const tone = complete && tested ? theme.palette.success.main : theme.palette.primary.main
    return (
        <Paper
            variant='outlined'
            data-testid='authkit-card'
            sx={{
                borderRadius: 3,
                p: 2.5,
                mb: 3,
                maxWidth: 880,
                borderColor: alpha(tone, 0.35),
                background: `linear-gradient(135deg, ${alpha(tone, theme.palette.mode === 'dark' ? 0.16 : 0.07)} 0%, ${alpha(tone, 0)} 70%)`
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
                        color: tone,
                        backgroundColor: alpha(tone, 0.14)
                    }}
                >
                    {complete && tested ? <IconCircleCheckFilled size={24} /> : <IconShieldCheck size={24} stroke={1.7} />}
                </Box>
                <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                    <Stack direction='row' gap={1} alignItems='center' flexWrap='wrap' sx={{ mb: 0.5 }}>
                        <Typography sx={{ fontWeight: 650, fontSize: '1.02rem' }}>{title}</Typography>
                        {complete && authKit.environment !== 'unknown' && (
                            <Chip size='small' label={ENVIRONMENT_LABELS[authKit.environment]} sx={{ fontWeight: 600, height: 22 }} />
                        )}
                        {authKit?.locked && <Chip size='small' label='Set by the host' variant='outlined' sx={{ height: 22 }} />}
                    </Stack>
                    <Typography variant='body2' color='text.secondary'>
                        {body}
                    </Typography>
                </Box>
                <Button
                    variant={complete ? 'outlined' : 'contained'}
                    disableElevation
                    onClick={onOpen}
                    sx={{ borderRadius: 2.5, px: 2.5, flexShrink: 0, whiteSpace: 'nowrap' }}
                    data-testid='authkit-open'
                >
                    {!complete ? 'Set up AuthKit' : tested ? 'Change AuthKit' : 'Test sign-in'}
                </Button>
            </Stack>
            {complete && !tested && (
                <Stack direction='row' gap={0.75} alignItems='center' sx={{ mt: 1.5, color: 'text.secondary' }}>
                    <IconInfoCircle size={15} />
                    <Typography variant='caption'>
                        The test opens AuthKit with these settings and comes straight back. Nothing changes.
                    </Typography>
                </Stack>
            )}
        </Paper>
    )
}

AuthKitCard.propTypes = {
    authKit: PropTypes.shape({
        complete: PropTypes.bool,
        environment: PropTypes.string,
        tested: PropTypes.bool,
        testedAt: PropTypes.string,
        locked: PropTypes.bool
    }),
    onOpen: PropTypes.func.isRequired
}

export default AuthKitCard
