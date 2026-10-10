// The database card at the top of Database: what Cuttlely runs on, what it uses after a restart, Switch and Switch back.
import PropTypes from 'prop-types'

import { alpha, useTheme } from '@mui/material/styles'
import { Box, Button, Chip, Paper, Stack, Typography } from '@mui/material'
import { IconArrowBackUp, IconDatabase } from '@tabler/icons-react'

const DatabaseCard = ({ database, onSwitch, onRestore }) => {
    const theme = useTheme()
    if (!database) return null
    const pending = database.saved?.label !== database.running?.label
    return (
        <Paper
            variant='outlined'
            data-testid='database-card'
            sx={{
                borderRadius: 3,
                p: 2.5,
                mb: 3,
                maxWidth: 880,
                background: `linear-gradient(135deg, ${alpha(
                    theme.palette.primary.main,
                    theme.palette.mode === 'dark' ? 0.14 : 0.06
                )} 0%, ${alpha(theme.palette.primary.main, 0)} 70%)`
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
                        color: theme.palette.primary.main,
                        backgroundColor: alpha(theme.palette.primary.main, 0.14)
                    }}
                >
                    <IconDatabase size={24} stroke={1.7} />
                </Box>
                <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                    <Typography variant='caption' color='text.secondary' sx={{ fontWeight: 600, letterSpacing: 0.4 }}>
                        RUNNING ON
                    </Typography>
                    <Stack direction='row' gap={1} alignItems='center' flexWrap='wrap'>
                        <Typography sx={{ fontWeight: 650, fontSize: '1.02rem' }}>{database.running?.label}</Typography>
                        {database.locked && <Chip size='small' label='Set by the host' variant='outlined' sx={{ height: 22 }} />}
                    </Stack>
                    {pending && (
                        <Typography variant='body2' sx={{ mt: 0.5, color: 'warning.main', fontWeight: 500 }}>
                            After the restart: {database.saved?.label}
                        </Typography>
                    )}
                </Box>
                {!database.locked && (
                    <Stack direction='row' gap={1} sx={{ flexShrink: 0 }}>
                        {database.previous && (
                            <Button
                                onClick={onRestore}
                                startIcon={<IconArrowBackUp size={17} />}
                                sx={{ borderRadius: 2.5, whiteSpace: 'nowrap' }}
                                data-testid='database-restore'
                            >
                                Switch back
                            </Button>
                        )}
                        <Button
                            variant='contained'
                            disableElevation
                            onClick={onSwitch}
                            sx={{ borderRadius: 2.5, px: 2.5, whiteSpace: 'nowrap' }}
                            data-testid='database-switch'
                        >
                            Switch database
                        </Button>
                    </Stack>
                )}
            </Stack>
            {database.previous && !database.locked && (
                <Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 1.5 }}>
                    Switch back returns to {database.previous.label}.
                </Typography>
            )}
            {database.locked && (
                <Typography variant='body2' color='text.secondary' sx={{ mt: 1.5 }}>
                    The database is set where Cuttlely is installed, so it can only be changed there.
                </Typography>
            )}
        </Paper>
    )
}

DatabaseCard.propTypes = {
    database: PropTypes.shape({
        running: PropTypes.object,
        saved: PropTypes.object,
        previous: PropTypes.object,
        locked: PropTypes.bool
    }),
    onSwitch: PropTypes.func.isRequired,
    onRestore: PropTypes.func.isRequired
}

export default DatabaseCard
