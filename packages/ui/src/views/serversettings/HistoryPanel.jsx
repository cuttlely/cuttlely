import PropTypes from 'prop-types'
import { useEffect, useState } from 'react'

import { alpha, useTheme } from '@mui/material/styles'
import { Box, CircularProgress, Stack, Typography } from '@mui/material'
import { IconArrowBackUp, IconDeviceFloppy, IconKey, IconRefresh, IconShieldCheck, IconTerminal2, IconTrash } from '@tabler/icons-react'

import serverSettingsApi from '@/api/serverSettings'
import { SECRET_ACTIONS, historyLine } from './model'

const KIND_ICONS = {
    save: IconDeviceFloppy,
    discard: IconTrash,
    restore: IconArrowBackUp,
    rollback: IconShieldCheck,
    unset: IconTerminal2,
    restart: IconRefresh,
    start: IconRefresh,
    test: IconKey
}

const when = (iso) => {
    const date = new Date(iso)
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

// Every save, discard, restore and restart, newest first. Secrets show as set, replaced or removed.
const HistoryPanel = ({ labels, refreshKey }) => {
    const theme = useTheme()
    const [entries, setEntries] = useState(null)
    const [failed, setFailed] = useState(false)

    useEffect(() => {
        let live = true
        serverSettingsApi
            .getHistory(100)
            .then((res) => live && setEntries(res.data.entries ?? []))
            .catch(() => live && setFailed(true))
        return () => {
            live = false
        }
    }, [refreshKey])

    if (failed) return <Typography color='error'>The history could not be loaded.</Typography>
    if (!entries) return <CircularProgress size={24} />
    if (!entries.length)
        return (
            <Typography color='text.secondary' sx={{ py: 6, textAlign: 'center' }}>
                Nothing has changed yet. Saves, restarts and restores show up here.
            </Typography>
        )

    return (
        <Stack sx={{ position: 'relative', pl: 1 }} data-testid='settings-history'>
            {entries.map((entry, index) => {
                const Icon = KIND_ICONS[entry.kind] ?? IconDeviceFloppy
                return (
                    <Stack key={`${entry.at}-${index}`} direction='row' gap={2} sx={{ pb: 3, position: 'relative' }}>
                        {index < entries.length - 1 && (
                            <Box
                                sx={{
                                    position: 'absolute',
                                    left: 17,
                                    top: 38,
                                    bottom: 0,
                                    width: '1px',
                                    backgroundColor: theme.palette.divider
                                }}
                            />
                        )}
                        <Box
                            sx={{
                                width: 36,
                                height: 36,
                                flexShrink: 0,
                                borderRadius: '50%',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: entry.kind === 'rollback' ? theme.palette.warning.dark : theme.palette.primary.main,
                                backgroundColor: alpha(
                                    entry.kind === 'rollback' ? theme.palette.warning.main : theme.palette.primary.main,
                                    0.1
                                )
                            }}
                        >
                            <Icon size={18} />
                        </Box>
                        <Box sx={{ minWidth: 0, pt: 0.5 }}>
                            <Typography sx={{ fontWeight: 600 }}>{historyLine(entry)}</Typography>
                            <Typography variant='caption' color='text.secondary'>
                                {when(entry.at)}
                            </Typography>
                            {entry.note && (
                                <Typography variant='body2' color='text.secondary' sx={{ mt: 0.5 }}>
                                    {entry.note}
                                </Typography>
                            )}
                            {(entry.changes ?? []).length > 0 && (
                                <Stack gap={0.5} sx={{ mt: 1 }}>
                                    {entry.changes.map((change) => (
                                        <Typography key={change.key} variant='body2' sx={{ wordBreak: 'break-word' }}>
                                            <Box component='span' sx={{ fontWeight: 500 }}>
                                                {labels[change.key] ?? change.key}
                                            </Box>
                                            {change.secret ? (
                                                <Box component='span' sx={{ color: 'text.secondary' }}>
                                                    {' '}
                                                    <IconKey size={12} style={{ verticalAlign: '-1px' }} /> {SECRET_ACTIONS[change.secret]}
                                                </Box>
                                            ) : change.from !== undefined || change.to !== undefined ? (
                                                <Box component='span' sx={{ color: 'text.secondary' }}>
                                                    {': '}
                                                    {change.from || 'default'} to {change.to || 'default'}
                                                </Box>
                                            ) : null}
                                        </Typography>
                                    ))}
                                </Stack>
                            )}
                        </Box>
                    </Stack>
                )
            })}
        </Stack>
    )
}

HistoryPanel.propTypes = {
    labels: PropTypes.object.isRequired,
    refreshKey: PropTypes.number
}

export default HistoryPanel
