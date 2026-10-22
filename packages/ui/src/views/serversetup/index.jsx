// The one-time setup page: /setup from the server log. One page for the first account and, when nobody can sign
// in yet, the choice of password or AuthKit. The code arrives in the fragment and is removed from the address
// before any request. The account form appears only after the code is accepted.
import { useEffect, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { alpha, useTheme } from '@mui/material/styles'
import { Alert, Box, Button, ButtonBase, CircularProgress, Stack, TextField, Typography } from '@mui/material'
import { IconArrowLeft, IconCircleCheckFilled, IconKey, IconLock, IconShieldLock, IconUserShield } from '@tabler/icons-react'

import Logo from '@/ui-component/extended/Logo'
import Mascot from '@/ui-component/extended/Mascot'
import accountApi from '@/api/account.api'
import serverSetupApi from '@/api/serverSetup'
import AuthKitWizard from '@/views/serversettings/AuthKitWizard'
import { t } from '@/i18n'
import { store } from '@/store'
import { loginSuccess } from '@/store/reducers/authSlice'
import SetupCodeHelp from './SetupCodeHelp'
import { openSetupPage, rememberSetupCode } from './openSetup'
import { fieldErrors, ownerProblems, readSetupCode, setupProblem } from './model'

const ChoiceCard = ({ icon: Icon, title, body, onClick, disabled, note, testId }) => {
    const theme = useTheme()
    return (
        <ButtonBase
            onClick={onClick}
            disabled={disabled}
            data-testid={testId}
            sx={{
                flex: 1,
                p: 2.5,
                borderRadius: 3.5,
                textAlign: 'left',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 1.5,
                border: `1.5px solid ${theme.palette.divider}`,
                opacity: disabled ? 0.55 : 1,
                transition: 'border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease',
                '&:hover': {
                    borderColor: theme.palette.primary.main,
                    boxShadow: `0 6px 24px ${alpha(theme.palette.primary.main, 0.12)}`,
                    transform: 'translateY(-1px)'
                }
            }}
        >
            <Box
                sx={{
                    width: 44,
                    height: 44,
                    borderRadius: 3,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: theme.palette.primary.main,
                    backgroundColor: alpha(theme.palette.primary.main, 0.12)
                }}
            >
                <Icon size={23} stroke={1.7} />
            </Box>
            <Typography sx={{ fontWeight: 650, fontSize: '1.02rem' }}>{title}</Typography>
            <Typography variant='body2' color='text.secondary'>
                {body}
            </Typography>
            {note && (
                <Typography variant='caption' color='text.secondary' sx={{ display: 'flex', gap: 0.75, alignItems: 'center' }}>
                    <IconLock size={14} /> {note}
                </Typography>
            )}
        </ButtonBase>
    )
}

ChoiceCard.propTypes = {
    icon: PropTypes.elementType.isRequired,
    title: PropTypes.string.isRequired,
    body: PropTypes.string.isRequired,
    onClick: PropTypes.func.isRequired,
    disabled: PropTypes.bool,
    note: PropTypes.string,
    testId: PropTypes.string
}

const Shell = ({ children, wide, pose = 'neutral' }) => {
    const theme = useTheme()
    return (
        <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: { xs: 2, md: 4 } }}>
            <Box
                sx={{
                    width: '100%',
                    maxWidth: wide ? 760 : 520,
                    p: { xs: 3, md: 4.5 },
                    borderRadius: 5,
                    border: `1px solid ${theme.palette.divider}`,
                    backgroundColor: theme.palette.background.paper,
                    boxShadow: `0 24px 60px ${alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.4 : 0.08)}`
                }}
            >
                <Stack direction='row' alignItems='center' gap={2} sx={{ mb: 3 }}>
                    <Mascot pose={pose} size={104} />
                    <Logo height={34} />
                </Stack>
                {children}
            </Box>
        </Box>
    )
}

Shell.propTypes = { children: PropTypes.node, wide: PropTypes.bool, pose: PropTypes.string }

const PasswordForm = ({ onBack, onDone }) => {
    const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' })
    const [shown, setShown] = useState(false)
    const [serverErrors, setServerErrors] = useState({})
    const [error, setError] = useState(null)
    const [saving, setSaving] = useState(false)
    const problems = ownerProblems(form)
    const set = (key) => (event) => {
        setForm((now) => ({ ...now, [key]: event.target.value }))
        setServerErrors((now) => ({ ...now, [key]: undefined }))
    }
    const problem = (key) => (shown ? problems[key] : undefined) ?? serverErrors[key]

    const submit = async (event) => {
        event.preventDefault()
        setShown(true)
        if (Object.keys(problems).length) return
        setSaving(true)
        setError(null)
        try {
            const res = await serverSetupApi.createOwner({ name: form.name.trim(), email: form.email.trim(), password: form.password })
            onDone({ ...res.data, way: 'password' })
        } catch (failure) {
            setServerErrors(fieldErrors(failure?.response?.data?.errors))
            setError(setupProblem(failure))
            setSaving(false)
        }
    }

    const field = (key, label, extra = {}) => (
        <TextField
            fullWidth
            label={label}
            value={form[key]}
            onChange={set(key)}
            error={Boolean(problem(key))}
            helperText={problem(key) ?? extra.help}
            type={extra.type ?? 'text'}
            autoComplete={extra.autoComplete}
            InputLabelProps={{ shrink: true }}
            inputProps={{ 'data-testid': `setup-${key}`, spellCheck: false }}
        />
    )

    return (
        <form onSubmit={submit} noValidate>
            <Stack gap={2.25}>
                <Button
                    onClick={onBack}
                    startIcon={<IconArrowLeft size={16} />}
                    sx={{ alignSelf: 'flex-start', borderRadius: 2.5, ml: -1 }}
                >
                    Back
                </Button>
                <Box>
                    <Typography variant='h2' sx={{ fontSize: '1.45rem', fontWeight: 700 }}>
                        Create the owner account
                    </Typography>
                    <Typography color='text.secondary' sx={{ mt: 0.75 }}>
                        You sign in with this email and password. Set up AuthKit for your team any time later in Server settings.
                    </Typography>
                </Box>
                {field('name', 'Your name', { autoComplete: 'name' })}
                {field('email', 'Email', { type: 'email', autoComplete: 'email' })}
                {field('password', 'Password', {
                    type: 'password',
                    autoComplete: 'new-password',
                    help: 'At least 8 characters, with a lowercase letter, an uppercase letter, a digit and a symbol.'
                })}
                {field('confirm', 'Password again', { type: 'password', autoComplete: 'new-password' })}
                {error && (
                    <Alert severity='error' sx={{ borderRadius: 2.5 }}>
                        {error.message}
                    </Alert>
                )}
                <Button
                    type='submit'
                    variant='contained'
                    disableElevation
                    disabled={saving}
                    startIcon={saving ? <CircularProgress size={15} color='inherit' /> : null}
                    sx={{ borderRadius: 2.5, py: 1.1 }}
                    data-testid='setup-create-owner'
                >
                    {saving ? 'Creating the account' : 'Create account and restart'}
                </Button>
            </Stack>
        </form>
    )
}

PasswordForm.propTypes = { onBack: PropTypes.func.isRequired, onDone: PropTypes.func.isRequired }

/** After saving: wait for the restart, or say what to do when the server can't restart itself. */
const Finished = ({ result }) => {
    const theme = useTheme()
    const navigate = useNavigate()
    const [ready, setReady] = useState(!result.restarting)

    useEffect(() => {
        if (!result.restarting) return undefined
        let stopped = false
        let wentDown = false
        const started = Date.now()
        const tick = async () => {
            if (stopped) return
            try {
                const res = await fetch('/api/v1/ping', { cache: 'no-store' })
                if (res.ok && (wentDown || Date.now() - started > 15000)) return setReady(true)
                if (!res.ok) wentDown = true
            } catch {
                wentDown = true
            }
            setTimeout(tick, 1500)
        }
        const first = setTimeout(tick, 1500)
        return () => {
            stopped = true
            clearTimeout(first)
        }
    }, [result.restarting])

    const who = result.way === 'password' ? `Sign in as ${result.email} with your password.` : 'Sign in with AuthKit as the owner email.'
    return (
        <Stack gap={2.5} alignItems='flex-start' data-testid='setup-finished'>
            <Box
                sx={{
                    width: 52,
                    height: 52,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: alpha(theme.palette.success.main, 0.12)
                }}
            >
                {ready || !result.restarting ? (
                    <IconCircleCheckFilled size={28} color={theme.palette.success.main} />
                ) : (
                    <CircularProgress size={24} />
                )}
            </Box>
            <Box>
                <Typography variant='h2' sx={{ fontSize: '1.45rem', fontWeight: 700 }}>
                    {result.restarting ? (ready ? 'Cuttlely is ready' : 'Cuttlely is restarting') : 'Saved. One step left'}
                </Typography>
                <Typography color='text.secondary' sx={{ mt: 0.75 }}>
                    {result.restarting
                        ? ready
                            ? who
                            : 'This takes a few seconds. This page goes on by itself.'
                        : `Restart Cuttlely so the new sign-in takes effect, then come back. ${who}`}
                </Typography>
            </Box>
            {!result.restarting && result.steps?.length > 0 && (
                <Box component='ol' sx={{ m: 0, pl: 2.5, color: 'text.secondary', '& li': { mb: 0.5 } }}>
                    {result.steps.map((step) => (
                        <li key={step}>
                            <Typography variant='body2'>{step}</Typography>
                        </li>
                    ))}
                </Box>
            )}
            <Typography variant='caption' color='text.secondary'>
                The setup link has done its job and no longer works.
            </Typography>
            <Button
                variant='contained'
                disableElevation
                disabled={result.restarting && !ready}
                onClick={() => navigate('/signin', { replace: true })}
                sx={{ borderRadius: 2.5, px: 3 }}
                data-testid='setup-go-signin'
            >
                Go to sign in
            </Button>
        </Stack>
    )
}

Finished.propTypes = { result: PropTypes.object.isRequired }

const CodeStep = ({ serviceName, error, saving, onSubmit }) => {
    const [code, setCode] = useState('')
    const [shown, setShown] = useState(false)
    const missing = shown && !code.trim() ? t('setup.code.required') : ''
    return (
        <form
            onSubmit={(event) => {
                event.preventDefault()
                setShown(true)
                if (!code.trim()) return
                onSubmit(code.trim())
            }}
            noValidate
        >
            <Stack gap={2.25}>
                <Box>
                    <Typography variant='h2' sx={{ fontSize: '1.45rem', fontWeight: 700 }}>
                        {t('setup.code.label')}
                    </Typography>
                    <SetupCodeHelp serviceName={serviceName} />
                </Box>
                <TextField
                    fullWidth
                    label={t('setup.code.label')}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    error={Boolean(missing || error)}
                    helperText={missing || error || ' '}
                    autoComplete='off'
                    InputLabelProps={{ shrink: true }}
                    inputProps={{ 'data-testid': 'setup-code', spellCheck: false }}
                />
                <Button
                    type='submit'
                    variant='contained'
                    disableElevation
                    disabled={saving}
                    startIcon={saving ? <CircularProgress size={15} color='inherit' /> : null}
                    sx={{ borderRadius: 2.5, py: 1.1 }}
                    data-testid='setup-code-continue'
                >
                    {t('setup.code.continue')}
                </Button>
            </Stack>
        </form>
    )
}

CodeStep.propTypes = {
    serviceName: PropTypes.string,
    error: PropTypes.string,
    saving: PropTypes.bool,
    onSubmit: PropTypes.func.isRequired
}

/** Local-admin first account. The session cookie comes back on the same response. */
const OwnerAccountForm = ({ code, nextPath }) => {
    const navigate = useNavigate()
    const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' })
    const [shown, setShown] = useState(false)
    const [serverErrors, setServerErrors] = useState({})
    const [error, setError] = useState('')
    const [saving, setSaving] = useState(false)
    const problems = ownerProblems(form)
    const set = (key) => (event) => {
        setForm((now) => ({ ...now, [key]: event.target.value }))
        setServerErrors((now) => ({ ...now, [key]: undefined }))
    }
    const problem = (key) => (shown ? problems[key] : undefined) ?? serverErrors[key]

    const submit = async (event) => {
        event.preventDefault()
        setShown(true)
        if (Object.keys(problems).length) return
        setSaving(true)
        setError('')
        try {
            const res = await accountApi.registerAccount({
                user: { name: form.name.trim(), email: form.email.trim(), credential: form.password },
                setupCode: code
            })
            const session = res?.data
            if (!session?.id || !session?.email) {
                setError(t('setup.owner.notSignedIn'))
                setSaving(false)
                return
            }
            store.dispatch(loginSuccess(session))
            navigate(nextPath || '/', { replace: true })
        } catch (failure) {
            setServerErrors(fieldErrors(failure?.response?.data?.errors))
            setError(failure?.response?.data?.message || 'Something went wrong. Try again.')
            setSaving(false)
        }
    }

    const field = (key, label, extra = {}) => (
        <TextField
            fullWidth
            label={label}
            value={form[key]}
            onChange={set(key)}
            error={Boolean(problem(key))}
            helperText={problem(key) ?? extra.help}
            type={extra.type ?? 'text'}
            autoComplete={extra.autoComplete}
            InputLabelProps={{ shrink: true }}
            inputProps={{ 'data-testid': `setup-${key}`, spellCheck: false }}
        />
    )

    return (
        <form onSubmit={submit} noValidate>
            <Stack gap={2.25}>
                <Box>
                    <Typography variant='h2' sx={{ fontSize: '1.45rem', fontWeight: 700 }}>
                        Create the owner account
                    </Typography>
                    <Typography color='text.secondary' sx={{ mt: 0.75 }}>
                        You sign in with this email and password. Account setup does not make any external connections, and data stays on
                        this server.
                    </Typography>
                </Box>
                {field('name', 'Your name', { autoComplete: 'name' })}
                {field('email', 'Email', { type: 'email', autoComplete: 'email' })}
                {field('password', 'Password', {
                    type: 'password',
                    autoComplete: 'new-password',
                    help: 'At least 8 characters, with a lowercase letter, an uppercase letter, a digit and a symbol.'
                })}
                {field('confirm', 'Password again', { type: 'password', autoComplete: 'new-password' })}
                {error && (
                    <Alert severity='error' sx={{ borderRadius: 2.5 }}>
                        {error}
                    </Alert>
                )}
                <Button
                    type='submit'
                    variant='contained'
                    disableElevation
                    disabled={saving}
                    startIcon={saving ? <CircularProgress size={15} color='inherit' /> : null}
                    sx={{ borderRadius: 2.5, py: 1.1 }}
                    data-testid='setup-create-account'
                >
                    {saving ? t('setup.owner.saving') : t('setup.owner.submit')}
                </Button>
            </Stack>
        </form>
    )
}

OwnerAccountForm.propTypes = { code: PropTypes.string.isRequired, nextPath: PropTypes.string }

const ServerSetupPage = () => {
    const navigate = useNavigate()
    const [params] = useSearchParams()
    const [stage, setStage] = useState('opening')
    const [state, setState] = useState(null)
    const [problem, setProblem] = useState(null)
    const [wizard, setWizard] = useState(false)
    const [result, setResult] = useState(null)
    const [serviceName, setServiceName] = useState('')
    const [acceptedCode, setAcceptedCode] = useState('')
    const [codeError, setCodeError] = useState('')
    const [codeSaving, setCodeSaving] = useState(false)
    const [nextPath, setNextPath] = useState('/')
    const acceptedGate = useRef(false)
    const resume = params.get('authkit') === 'done' || params.get('authkit') === 'expired'

    useEffect(() => {
        const read = readSetupCode(window.location.href)
        const code = rememberSetupCode(read.code)
        setNextPath(read.next || '/')
        window.history.replaceState(null, '', read.href)
        const controller = new AbortController()
        const hooks = {
            onServiceName: (name) => setServiceName(name || ''),
            onOwner: (accepted) => {
                setAcceptedCode(accepted)
                setStage('owner')
            },
            onChoose: (data, wizardOn) => {
                setState(data)
                setStage('choose')
                setWizard(Boolean(wizardOn))
            },
            onCode: (message) => {
                setCodeError(message || '')
                setStage('code')
            },
            onClosed: (next) => {
                setProblem(next)
                setStage('closed')
            }
        }
        openSetupPage({
            code,
            resume,
            api: serverSetupApi,
            signal: controller.signal,
            accepted: acceptedGate,
            hooks
        })
        return () => controller.abort()
        // The code is read once, on open. Later address changes are not a new setup.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const submitCode = async (code) => {
        setCodeSaving(true)
        setCodeError('')
        try {
            const begun = await serverSetupApi.begin(code)
            if (begun.data?.next === 'owner') {
                setAcceptedCode(code)
                setStage('owner')
                return
            }
            const res = await serverSetupApi.getState()
            setState(res.data)
            setStage('choose')
        } catch (failure) {
            const next = setupProblem(failure)
            if (next.retry || !next.closed) {
                setCodeError(next.message || '')
                setCodeSaving(false)
                return
            }
            setProblem(next)
            setStage('closed')
        }
    }

    if (stage === 'opening')
        return (
            <Shell pose='laptop'>
                <Stack direction='row' gap={1.5} alignItems='center' sx={{ color: 'text.secondary' }}>
                    <CircularProgress size={18} />
                    <Typography>Opening the setup link</Typography>
                </Stack>
            </Shell>
        )

    if (stage === 'closed')
        return (
            <Shell>
                <Stack gap={2} alignItems='flex-start' data-testid='setup-closed'>
                    <Typography variant='h2' sx={{ fontSize: '1.45rem', fontWeight: 700 }}>
                        This setup link can&apos;t be used
                    </Typography>
                    <Typography color='text.secondary'>{problem?.message}</Typography>
                    <Button variant='contained' disableElevation onClick={() => navigate('/signin')} sx={{ borderRadius: 2.5, px: 3 }}>
                        Go to sign in
                    </Button>
                </Stack>
            </Shell>
        )

    if (result)
        return (
            <Shell pose='wink'>
                <Finished result={result} />
            </Shell>
        )

    if (stage === 'password')
        return (
            <Shell>
                <PasswordForm onBack={() => setStage('choose')} onDone={setResult} />
            </Shell>
        )

    if (stage === 'code')
        return (
            <Shell pose='laptop'>
                <CodeStep serviceName={serviceName} error={codeError} saving={codeSaving} onSubmit={submitCode} />
            </Shell>
        )

    if (stage === 'owner')
        return (
            <Shell>
                <OwnerAccountForm code={acceptedCode} nextPath={nextPath} />
            </Shell>
        )

    return (
        <Shell wide>
            <Stack gap={3} data-testid='setup-choose'>
                <Box>
                    <Typography
                        variant='overline'
                        sx={{
                            color: 'primary.main',
                            fontWeight: 700,
                            letterSpacing: '0.08em',
                            display: 'flex',
                            gap: 0.75,
                            alignItems: 'center'
                        }}
                    >
                        <IconShieldLock size={15} /> Sign-in &amp; identity
                    </Typography>
                    <Typography variant='h1' sx={{ fontSize: '1.9rem', fontWeight: 700, mt: 0.5 }}>
                        Choose how people sign in
                    </Typography>
                    <Typography color='text.secondary' sx={{ mt: 1, maxWidth: 560 }}>
                        Nobody can sign in to this server yet. Pick a way in for the first person, the owner. Everything else waits in
                        Server settings once you are in. This page works once.
                    </Typography>
                </Box>
                <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
                    <ChoiceCard
                        icon={IconKey}
                        title='Use a password for now'
                        body='Create the owner account with an email and password. Quickest. Add AuthKit for your team later.'
                        onClick={() => setStage('password')}
                        disabled={state?.passwordLocked}
                        note={state?.passwordLocked ? 'The host turned password sign-in off.' : undefined}
                        testId='setup-choose-password'
                    />
                    <ChoiceCard
                        icon={IconUserShield}
                        title='Set up AuthKit'
                        body='Let your team sign in with WorkOS. A test sign-in comes first, so nothing is saved until it works.'
                        onClick={() => setWizard(true)}
                        disabled={state?.authKit?.locked}
                        note={state?.authKit?.locked ? 'AuthKit is set by the host.' : undefined}
                        testId='setup-choose-authkit'
                    />
                </Stack>
            </Stack>
            {state && (
                <AuthKitWizard
                    open={wizard}
                    onClose={() => setWizard(false)}
                    settings={state.settings}
                    resume={resume}
                    onSaved={(data) => {
                        setWizard(false)
                        setResult({ ...data, way: 'authkit' })
                    }}
                    passwordLocked
                    api={serverSetupApi}
                    setupMode
                />
            )}
        </Shell>
    )
}

export default ServerSetupPage
