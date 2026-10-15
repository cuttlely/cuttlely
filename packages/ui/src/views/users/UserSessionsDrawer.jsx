import { useCallback, useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import { Box, Button, Drawer, Stack, Typography } from '@mui/material'
import userApi from '@/api/user'
import useConfirm from '@/hooks/useConfirm'
import { formatListDateTime } from '@/utils/formatDate'

export default function UserSessionsDrawer({ userId, userName, open, onClose }) {
    const [sessions, setSessions] = useState([])
    const [message, setMessage] = useState('')
    const { confirm } = useConfirm()

    const load = useCallback(() => {
        if (!userId) return
        userApi
            .listSessions(userId)
            .then((response) => {
                setSessions(response.data?.sessions || [])
                setMessage(response.data?.sessions?.length ? '' : 'No open sessions.')
            })
            .catch((error) => {
                setSessions([])
                const status = error.response?.status
                setMessage(
                    status === 404
                        ? 'Sessions are available when local password sign-in is on.'
                        : error.response?.data?.message || 'Could not load sessions.'
                )
            })
    }, [userId])

    useEffect(() => {
        if (open) load()
    }, [open, load])

    const endOne = async (sessionId) => {
        const confirmed = await confirm({
            title: 'End session',
            description: 'End this sign-in? That browser will have to sign in again.',
            confirmButtonName: 'End session',
            cancelButtonName: 'Cancel'
        })
        if (!confirmed) return
        await userApi.endSession(userId, sessionId)
        load()
    }

    const endAll = async () => {
        const confirmed = await confirm({
            title: 'End all sessions',
            description: `End every open sign-in for ${userName || 'this person'}?`,
            confirmButtonName: 'End all',
            cancelButtonName: 'Cancel'
        })
        if (!confirmed) return
        await userApi.endSessions(userId)
        load()
    }

    return (
        <Drawer anchor='right' open={open} onClose={onClose}>
            <Box sx={{ p: 3, width: 'min(420px, 100vw)' }}>
                <Typography variant='h2' sx={{ mb: 1 }}>
                    Sessions
                </Typography>
                <Typography variant='body2' sx={{ mb: 2 }}>
                    Open sign-ins for {userName || 'this person'}. The list does not include cookies or tokens.
                </Typography>
                {message && (
                    <Typography variant='body2' sx={{ mb: 2 }}>
                        {message}
                    </Typography>
                )}
                <Stack sx={{ gap: 1.5 }}>
                    {sessions.map((session) => (
                        <Box key={session.id} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
                            <Typography variant='body2'>
                                Started {session.createdAt ? formatListDateTime(session.createdAt) : 'unknown'}
                            </Typography>
                            <Typography variant='caption' display='block'>
                                Idle until {session.idleExpiresAt ? formatListDateTime(session.idleExpiresAt) : 'unknown'}
                            </Typography>
                            <Button size='small' color='error' onClick={() => endOne(session.id)} sx={{ mt: 1 }}>
                                End session
                            </Button>
                        </Box>
                    ))}
                </Stack>
                {sessions.length > 0 && (
                    <Button color='error' variant='outlined' onClick={endAll} sx={{ mt: 2 }}>
                        End all sessions
                    </Button>
                )}
            </Box>
        </Drawer>
    )
}

UserSessionsDrawer.propTypes = {
    userId: PropTypes.string,
    userName: PropTypes.string,
    open: PropTypes.bool,
    onClose: PropTypes.func
}
