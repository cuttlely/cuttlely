import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Alert, Box, Stack, Typography } from '@mui/material'
import { LoadingButton } from '@mui/lab'
import { IconExclamationCircle } from '@tabler/icons-react'
import MainCard from '@/ui-component/cards/MainCard'
import Logo from '@/ui-component/extended/Logo'
import { Input } from '@/ui-component/input/Input'
import authApi from '@/api/auth'
import useApi from '@/hooks/useApi'
import { loginSuccess } from '@/store/reducers/authSlice'
import { store } from '@/store'

const emailInput = { label: 'Email', name: 'email', type: 'email', placeholder: 'owner@company.com' }
const passwordInput = { label: 'Password', name: 'password', type: 'password', placeholder: '********', enablePasswordToggle: true }

export default function OwnerRecovery() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [message, setMessage] = useState('')
    const [loading, setLoading] = useState(false)
    const request = useApi(authApi.recoveryLogin)
    const navigate = useNavigate()

    useEffect(() => {
        if (!request.error) return
        setLoading(false)
        setMessage(request.error.response?.data?.message || 'Invalid email or password.')
    }, [request.error])

    useEffect(() => {
        if (!request.data) return
        setLoading(false)
        store.dispatch(loginSuccess(request.data))
        navigate('/')
    }, [request.data, navigate])

    const submit = (event) => {
        event.preventDefault()
        setMessage('')
        setLoading(true)
        request.request({ email, password })
    }

    return (
        <MainCard maxWidth='sm'>
            <Stack sx={{ width: '480px', gap: 3 }}>
                {message && (
                    <Alert icon={<IconExclamationCircle />} variant='filled' severity='error'>
                        {message}
                    </Alert>
                )}
                <Stack sx={{ gap: 1, alignItems: 'center' }}>
                    <Logo height={40} />
                    <Typography variant='h1'>Owner recovery</Typography>
                    <Typography color='text.secondary' align='center'>
                        Use an active owner account and its local emergency password.
                    </Typography>
                </Stack>
                <form onSubmit={submit}>
                    <Stack gap={2}>
                        <Box>
                            <Typography>Email *</Typography>
                            <Input inputParam={emailInput} onChange={setEmail} value={email} showDialog={false} />
                        </Box>
                        <Box>
                            <Typography>Password *</Typography>
                            <Input inputParam={passwordInput} onChange={setPassword} value={password} />
                        </Box>
                        <LoadingButton loading={loading} variant='contained' type='submit'>
                            Sign in for recovery
                        </LoadingButton>
                    </Stack>
                </form>
                <Typography variant='body2' align='center'>
                    <Link to='/signin'>Return to sign in</Link>
                </Typography>
            </Stack>
        </MainCard>
    )
}
