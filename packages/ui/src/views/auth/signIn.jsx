import { useEffect, useState } from 'react'
import { useSelector } from 'react-redux'
import { Link, Navigate, useNavigate, useLocation } from 'react-router-dom'

import { Stack, useTheme, Typography, Box, Alert, Button } from '@mui/material'
import { IconExclamationCircle } from '@tabler/icons-react'
import { LoadingButton } from '@mui/lab'

import MainCard from '@/ui-component/cards/MainCard'
import Logo from '@/ui-component/extended/Logo'
import { Input } from '@/ui-component/input/Input'

import useApi from '@/hooks/useApi'
import { useError } from '@/store/context/ErrorContext'

import authApi from '@/api/auth'
import client from '@/api/client'

import useNotifier from '@/utils/useNotifier'

import { loginSuccess } from '@/store/reducers/authSlice'
import { store } from '@/store'

const SignInPage = () => {
    const theme = useTheme()
    useSelector((state) => state.customization)
    useNotifier()

    const usernameInput = {
        label: 'Username',
        name: 'username',
        type: 'email',
        placeholder: 'user@company.com'
    }
    const passwordInput = {
        label: 'Password',
        name: 'password',
        type: 'password',
        placeholder: '********',
        enablePasswordToggle: true
    }
    const [usernameVal, setUsernameVal] = useState('')
    const [passwordVal, setPasswordVal] = useState('')
    const [options, setOptions] = useState({ authKit: false, localAdmin: false, localUsers: false, mail: false })
    const isAuthenticated = useSelector((state) => state.auth.isAuthenticated)
    const currentUser = useSelector((state) => state.auth.user)
    const [authError, setAuthError] = useState(undefined)
    const [loading, setLoading] = useState(false)

    const { authRateLimitError, setAuthRateLimitError } = useError()

    const loginApi = useApi(authApi.login)
    const localLoginApi = useApi(authApi.localLogin)
    const activeLogin = options.localUsers ? localLoginApi : loginApi
    const navigate = useNavigate()
    const location = useLocation()

    const doLogin = (event) => {
        event.preventDefault()
        setAuthRateLimitError(null)
        setLoading(true)
        activeLogin.request({
            email: usernameVal,
            password: passwordVal
        })
    }

    useEffect(() => {
        let cancelled = false
        client
            .get('/auth/signin-options')
            .then((response) => {
                if (cancelled) return
                setOptions({
                    authKit: response.data?.authKit === true,
                    localAdmin: response.data?.localAdmin === true,
                    localUsers: response.data?.localUsers === true,
                    mail: response.data?.mail === true
                })
            })
            .catch(() => {
                if (!cancelled) setOptions({ authKit: false, localAdmin: false, localUsers: false, mail: false })
            })
        return () => {
            cancelled = true
        }
    }, [])

    useEffect(() => {
        const failed = options.localUsers ? localLoginApi.error : loginApi.error
        if (failed) {
            setLoading(false)
            setAuthError(failed.response?.data?.message || 'Sign-in failed.')
        }
    }, [loginApi.error, localLoginApi.error, options.localUsers])

    useEffect(() => {
        setAuthRateLimitError(null)
    }, [setAuthRateLimitError])

    useEffect(() => {
        const queryParams = new URLSearchParams(location.search)
        const errorData = queryParams.get('error')
        if (!errorData) return
        try {
            const parsedErrorData = JSON.parse(decodeURIComponent(errorData))
            setAuthError(parsedErrorData.message)
        } catch {
            setAuthError('Sign-in failed.')
        }
    }, [location.search])

    useEffect(() => {
        const signedIn = options.localUsers ? localLoginApi.data : loginApi.data
        if (signedIn) {
            setLoading(false)
            store.dispatch(loginSuccess(signedIn))
            navigate(location.state?.path || '/')
        }
    }, [loginApi.data, localLoginApi.data, options.localUsers, location.state, navigate])

    if (isAuthenticated && currentUser) {
        return <Navigate to={location.state?.path || '/'} replace />
    }

    return (
        <>
            <MainCard maxWidth='sm'>
                <Stack flexDirection='column' sx={{ width: '480px', gap: 3 }}>
                    {authRateLimitError && (
                        <Alert icon={<IconExclamationCircle />} variant='filled' severity='error'>
                            {authRateLimitError}
                        </Alert>
                    )}
                    {authError && (
                        <Alert icon={<IconExclamationCircle />} variant='filled' severity='error'>
                            {authError}
                        </Alert>
                    )}
                    <Stack sx={{ gap: 1, alignItems: 'center' }}>
                        <Logo height={40} />
                        <Typography variant='h1'>Sign In</Typography>
                    </Stack>
                    <Stack sx={{ width: '100%', flexDirection: 'column', alignItems: 'left', justifyContent: 'center', gap: 2 }}>
                        {options.authKit && (
                            <Button id='workos-sign-in' variant='contained' component='a' href='/api/v1/auth/login'>
                                Sign in with WorkOS
                            </Button>
                        )}
                        {options.localUsers && (
                            <form id='local-users-form' onSubmit={doLogin}>
                                <Stack sx={{ width: '100%', flexDirection: 'column', gap: 2 }}>
                                    <Box sx={{ p: 0 }}>
                                        <Typography>
                                            Email<span style={{ color: 'red' }}>&nbsp;*</span>
                                        </Typography>
                                        <Input
                                            inputParam={usernameInput}
                                            onChange={(newValue) => setUsernameVal(newValue)}
                                            value={usernameVal}
                                            showDialog={false}
                                        />
                                    </Box>
                                    <Box sx={{ p: 0 }}>
                                        <Typography>
                                            Password<span style={{ color: 'red' }}>&nbsp;*</span>
                                        </Typography>
                                        <Input
                                            inputParam={passwordInput}
                                            onChange={(newValue) => setPasswordVal(newValue)}
                                            value={passwordVal}
                                        />
                                    </Box>
                                    <LoadingButton
                                        loading={loading}
                                        variant='contained'
                                        style={{ borderRadius: 12, height: 40 }}
                                        type='submit'
                                    >
                                        Sign in
                                    </LoadingButton>
                                </Stack>
                            </form>
                        )}
                        {options.localAdmin && !options.localUsers && (
                            <form id='break-glass-form' onSubmit={doLogin}>
                                <Stack sx={{ width: '100%', flexDirection: 'column', gap: 2 }}>
                                    <Box sx={{ p: 0 }}>
                                        <Typography>
                                            Email<span style={{ color: 'red' }}>&nbsp;*</span>
                                        </Typography>
                                        <Input
                                            inputParam={usernameInput}
                                            onChange={(newValue) => setUsernameVal(newValue)}
                                            value={usernameVal}
                                            showDialog={false}
                                        />
                                    </Box>
                                    <Box sx={{ p: 0 }}>
                                        <Typography>
                                            Password<span style={{ color: 'red' }}>&nbsp;*</span>
                                        </Typography>
                                        <Input
                                            inputParam={passwordInput}
                                            onChange={(newValue) => setPasswordVal(newValue)}
                                            value={passwordVal}
                                        />
                                    </Box>
                                    <LoadingButton
                                        loading={loading}
                                        variant={options.authKit ? 'outlined' : 'contained'}
                                        style={{ borderRadius: 12, height: 40 }}
                                        type='submit'
                                    >
                                        {options.authKit ? 'Sign in with password' : 'Sign in'}
                                    </LoadingButton>
                                    {options.mail && (
                                        <Typography variant='body2'>
                                            <Link to='/forgot-password'>Forgot password</Link>
                                        </Typography>
                                    )}
                                </Stack>
                            </form>
                        )}
                        {!options.authKit && !options.localAdmin && !options.localUsers && (
                            <Typography variant='body2' sx={{ color: theme.palette.grey[600] }}>
                                Sign-in is not configured.
                            </Typography>
                        )}
                    </Stack>
                </Stack>
            </MainCard>
        </>
    )
}

export default SignInPage
