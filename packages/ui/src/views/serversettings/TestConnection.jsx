// Test connection card: tries the values on screen (saved or not) and shows each step in plain words.
// Nothing is saved. Secrets go to the server for the test and never come back.
import { useEffect, useState } from 'react'
import PropTypes from 'prop-types'

import { alpha, useTheme } from '@mui/material/styles'
import { Box, Button, CircularProgress, Collapse, Paper, Stack, Typography } from '@mui/material'
import { IconCircleCheckFilled, IconCircleXFilled, IconInfoCircle, IconPlugConnected } from '@tabler/icons-react'

import serverSettingsApi from '@/api/serverSettings'

export const TEST_COPY = {
    database: {
        title: 'Test the database',
        body: 'Connects with the values on this page, saved or not, and looks at what is there. Nothing is saved.'
    },
    analyst: {
        title: 'Test the analyst database',
        body: 'Connects with the values on this page, saved or not. Nothing is saved.'
    },
    storage: {
        title: 'Test file storage',
        body: 'Connects with the values on this page, writes a small test file and removes it again. Nothing is saved.'
    },
    models: {
        title: 'Test the model list',
        body: 'Downloads or reads the list with the value on this page and checks it. Nothing is saved.'
    }
}

const seconds = (ms) => `${(Math.max(ms, 100) / 1000).toFixed(1)} s`

const TestConnection = ({ kind, values, signature, edited, onResult }) => {
    const theme = useTheme()
    const [running, setRunning] = useState(false)
    const [result, setResult] = useState(null)
    const [testedWith, setTestedWith] = useState(null)
    const [failure, setFailure] = useState(null)
    const copy = TEST_COPY[kind]
    const stale = result && testedWith !== signature

    useEffect(() => {
        if (onResult) onResult(result && !stale ? result : null)
    }, [result, stale, onResult])

    const run = async () => {
        setRunning(true)
        setFailure(null)
        try {
            const res = await serverSettingsApi.testConnection(kind, values)
            setResult(res.data)
            setTestedWith(signature)
        } catch (error) {
            setResult(null)
            const errors = error?.response?.data?.errors ?? []
            setFailure(
                errors.length ? errors.map((item) => item.message).join(' ') : error?.response?.data?.message ?? 'The test could not run.'
            )
        } finally {
            setRunning(false)
        }
    }

    const tone = result ? (result.ok ? theme.palette.success.main : theme.palette.error.main) : theme.palette.primary.main
    const tint = (color, light, dark) => alpha(color, theme.palette.mode === 'dark' ? dark : light)

    return (
        <Paper
            variant='outlined'
            data-testid={`test-${kind}`}
            sx={{
                borderRadius: 3,
                overflow: 'hidden',
                borderColor: result && !stale ? alpha(tone, 0.45) : theme.palette.divider,
                transition: 'border-color 160ms ease'
            }}
        >
            <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ sm: 'center' }} gap={2} sx={{ p: 2.25 }}>
                <Box
                    sx={{
                        width: 40,
                        height: 40,
                        borderRadius: 2.5,
                        flexShrink: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: theme.palette.primary.main,
                        backgroundColor: tint(theme.palette.primary.main, 0.08, 0.18)
                    }}
                >
                    <IconPlugConnected size={21} stroke={1.7} />
                </Box>
                <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 600 }}>{copy.title}</Typography>
                    <Typography variant='body2' color='text.secondary'>
                        {copy.body}
                        {edited ? ' Your unsaved changes are included.' : ''}
                    </Typography>
                </Box>
                <Button
                    variant={result && !stale ? 'outlined' : 'contained'}
                    disableElevation
                    onClick={run}
                    disabled={running}
                    startIcon={running ? <CircularProgress size={15} color='inherit' /> : null}
                    sx={{ borderRadius: 2.5, px: 2.25, flexShrink: 0, whiteSpace: 'nowrap' }}
                    data-testid={`test-${kind}-run`}
                >
                    {running ? 'Testing' : result ? 'Test again' : 'Test connection'}
                </Button>
            </Stack>
            <Collapse in={Boolean(result || failure)} unmountOnExit>
                <Box
                    sx={{
                        px: 2.25,
                        py: 1.75,
                        borderTop: `1px solid ${theme.palette.divider}`,
                        backgroundColor: failure ? tint(theme.palette.error.main, 0.04, 0.1) : result ? tint(tone, 0.04, 0.1) : undefined
                    }}
                    aria-live='polite'
                    data-testid={`test-${kind}-result`}
                >
                    {failure && (
                        <Stack direction='row' gap={1} alignItems='flex-start'>
                            <IconCircleXFilled size={19} style={{ color: theme.palette.error.main, flexShrink: 0, marginTop: 1 }} />
                            <Typography variant='body2'>{failure}</Typography>
                        </Stack>
                    )}
                    {result && (
                        <>
                            <Stack direction='row' gap={1} alignItems='center' sx={{ mb: result.checks.length ? 1.25 : 0 }}>
                                {result.ok ? (
                                    <IconCircleCheckFilled size={20} style={{ color: tone, flexShrink: 0 }} />
                                ) : (
                                    <IconCircleXFilled size={20} style={{ color: tone, flexShrink: 0 }} />
                                )}
                                <Typography sx={{ fontWeight: 600, flexGrow: 1 }}>{result.summary}</Typography>
                                <Typography variant='caption' color='text.secondary' sx={{ whiteSpace: 'nowrap' }}>
                                    {seconds(result.tookMs)}
                                </Typography>
                            </Stack>
                            <Stack component='ul' gap={0.75} sx={{ listStyle: 'none', m: 0, p: 0, pl: 3.5 }}>
                                {result.checks.map((check) => (
                                    <Stack component='li' key={check.label} direction='row' gap={1} alignItems='flex-start'>
                                        <Box
                                            sx={{
                                                width: 8,
                                                height: 8,
                                                mt: 0.8,
                                                borderRadius: '50%',
                                                flexShrink: 0,
                                                backgroundColor: check.ok ? theme.palette.success.main : theme.palette.error.main
                                            }}
                                        />
                                        <Typography variant='body2'>
                                            <Box component='span' sx={{ fontWeight: 600 }}>
                                                {check.label}
                                            </Box>
                                            {check.detail ? (
                                                <Box component='span' sx={{ color: 'text.secondary' }}>
                                                    {'  '}
                                                    {check.detail}
                                                </Box>
                                            ) : null}
                                        </Typography>
                                    </Stack>
                                ))}
                            </Stack>
                            {stale && (
                                <Stack direction='row' gap={0.75} alignItems='center' sx={{ mt: 1.25, color: 'warning.main' }}>
                                    <IconInfoCircle size={16} />
                                    <Typography variant='caption' sx={{ fontWeight: 600 }}>
                                        The values changed after this test. Test again to be sure.
                                    </Typography>
                                </Stack>
                            )}
                        </>
                    )}
                </Box>
            </Collapse>
        </Paper>
    )
}

TestConnection.propTypes = {
    kind: PropTypes.oneOf(['database', 'analyst', 'storage', 'models']).isRequired,
    values: PropTypes.object.isRequired,
    signature: PropTypes.string.isRequired,
    edited: PropTypes.bool,
    onResult: PropTypes.func
}

export default TestConnection
