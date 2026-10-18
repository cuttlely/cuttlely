import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Box, OutlinedInput, Stack, Typography } from '@mui/material'
import { StyledButton } from '@/ui-component/button/StyledButton'
import MainCard from '@/ui-component/cards/MainCard'
import client from '@/api/client'

function tokenFromFragment() {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash
    const token = new URLSearchParams(hash).get('token') || ''
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search)
    return token
}

const LocalAcceptPage = () => {
    const [token] = useState(tokenFromFragment)
    const [authKit, setAuthKit] = useState(null)
    const [password, setPassword] = useState('')
    const [confirm, setConfirm] = useState('')
    const [message, setMessage] = useState('')
    const [saved, setSaved] = useState(false)
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        if (!token) setMessage('Open the one-time link you were given. This page does not keep a copy of it.')
    }, [token])

    useEffect(() => {
        let cancelled = false
        client
            .get('/auth/signin-options')
            .then((response) => {
                if (!cancelled) setAuthKit(response.data?.authKit === true)
            })
            .catch(() => {
                if (!cancelled) setAuthKit(false)
            })
        return () => {
            cancelled = true
        }
    }, [])

    const join = async () => {
        if (!token) return
        setBusy(true)
        setMessage('')
        try {
            const response = await client.post('/auth/invite/start', { token })
            window.location.assign(response.data?.url || '/api/v1/auth/login')
        } catch (error) {
            setMessage(error.response?.data?.message || 'This invite link is not valid. Ask for a new invite.')
            setBusy(false)
        }
    }

    const submit = async (event) => {
        event.preventDefault()
        if (!token) return
        if (password !== confirm) {
            setMessage('The two passwords do not match.')
            return
        }
        setBusy(true)
        setMessage('')
        try {
            await client.post('/auth/local/accept', { token, password })
            setSaved(true)
        } catch (error) {
            setMessage(error.response?.data?.message || 'This link is not valid.')
        } finally {
            setBusy(false)
        }
    }

    if (authKit === null) return <MainCard />

    if (authKit) {
        return (
            <MainCard>
                <Stack spacing={2}>
                    <Typography variant='h3'>Accept your invite</Typography>
                    <Typography>
                        Sign in with WorkOS using the email address this invite was sent to. The link works once and then stops. Do not
                        share it. If it has expired, ask for a new invite.
                    </Typography>
                    {message ? <Alert severity='info'>{message}</Alert> : null}
                    <StyledButton variant='contained' onClick={join} disabled={busy || !token}>
                        Accept invite with WorkOS
                    </StyledButton>
                </Stack>
            </MainCard>
        )
    }

    return (
        <MainCard>
            <Stack spacing={2} component='form' onSubmit={submit}>
                <Typography variant='h3'>Set a password</Typography>
                <Typography>
                    This link works once and then stops. Treat it like a password: do not share it, and do not paste it into a chat. If you
                    lose it, ask for a new one. The previous one cannot be shown again.
                </Typography>
                {saved ? (
                    <Alert severity='success'>
                        Password saved. <Link to='/signin'>Sign in</Link>
                    </Alert>
                ) : (
                    <>
                        {message ? <Alert severity='info'>{message}</Alert> : null}
                        <Box>
                            <Typography variant='body2'>Password</Typography>
                            <OutlinedInput
                                type='password'
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                fullWidth
                                autoComplete='new-password'
                            />
                        </Box>
                        <Box>
                            <Typography variant='body2'>Password again</Typography>
                            <OutlinedInput
                                type='password'
                                value={confirm}
                                onChange={(event) => setConfirm(event.target.value)}
                                fullWidth
                                autoComplete='new-password'
                            />
                        </Box>
                        <StyledButton variant='contained' type='submit' disabled={busy || !token}>
                            Save password
                        </StyledButton>
                    </>
                )}
            </Stack>
        </MainCard>
    )
}

export default LocalAcceptPage
