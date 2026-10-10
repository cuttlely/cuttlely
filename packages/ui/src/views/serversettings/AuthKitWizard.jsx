// Set up AuthKit: four steps, then a real test sign-in with the values on screen before anything is saved.
// Password sign-in can be turned off only after the test passes.
import { useEffect, useMemo, useState } from 'react'
import PropTypes from 'prop-types'

import { alpha, useTheme } from '@mui/material/styles'
import {
    Alert,
    Box,
    Button,
    ButtonBase,
    Chip,
    CircularProgress,
    Dialog,
    DialogContent,
    FormControlLabel,
    IconButton,
    InputAdornment,
    Stack,
    Switch,
    TextField,
    Tooltip,
    Typography
} from '@mui/material'
import {
    IconCheck,
    IconCircleCheckFilled,
    IconCircleXFilled,
    IconCopy,
    IconEye,
    IconEyeOff,
    IconKey,
    IconLink,
    IconLock,
    IconShieldCheck,
    IconSparkles,
    IconX
} from '@tabler/icons-react'

import serverSettingsApi from '@/api/serverSettings'
import {
    ENVIRONMENT_LABELS,
    authKitAddresses,
    detectEnvironment,
    fieldProblems,
    generateSeal,
    initialForm,
    stepReady,
    wizardValues
} from './authkit'
import { SENTENCE_CASE_BUTTONS } from './layout'

const STEPS = [
    { title: 'Connect WorkOS', hint: 'API key and Client ID', icon: IconKey },
    { title: 'Addresses', hint: 'Where AuthKit sends people back', icon: IconLink },
    { title: 'Session seal', hint: 'Keeps sign-ins sealed', icon: IconLock },
    { title: 'Test and turn on', hint: 'A real sign-in, nothing saved yet', icon: IconShieldCheck }
]

const EnvironmentChip = ({ environment }) => {
    const theme = useTheme()
    if (!environment) return null
    const color =
        environment === 'production'
            ? theme.palette.success.main
            : environment === 'staging'
            ? theme.palette.info.main
            : theme.palette.error.main
    return (
        <Chip
            size='small'
            label={ENVIRONMENT_LABELS[environment]}
            data-testid='authkit-environment'
            sx={{ fontWeight: 600, color, backgroundColor: alpha(color, 0.12), border: `1px solid ${alpha(color, 0.3)}` }}
        />
    )
}

EnvironmentChip.propTypes = { environment: PropTypes.string }

const CopyRow = ({ label, value }) => {
    const theme = useTheme()
    const [copied, setCopied] = useState(false)
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(value)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        } catch {
            setCopied(false)
        }
    }
    return (
        <Stack direction='row' alignItems='center' gap={1.5} sx={{ px: 1.75, py: 1.1 }}>
            <Typography variant='body2' sx={{ width: 150, flexShrink: 0, color: 'text.secondary', fontWeight: 500 }}>
                {label}
            </Typography>
            <Typography
                variant='body2'
                sx={{
                    flexGrow: 1,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: '0.8rem',
                    wordBreak: 'break-all'
                }}
            >
                {value}
            </Typography>
            <Tooltip title={copied ? 'Copied' : 'Copy'}>
                <IconButton size='small' onClick={copy} aria-label={`Copy ${label}`}>
                    {copied ? <IconCheck size={16} color={theme.palette.success.main} /> : <IconCopy size={16} />}
                </IconButton>
            </Tooltip>
        </Stack>
    )
}

CopyRow.propTypes = { label: PropTypes.string.isRequired, value: PropTypes.string.isRequired }

const SecretField = ({ label, value, onChange, placeholder, helperText, error, adornment, testId, disabled }) => {
    const [shown, setShown] = useState(false)
    return (
        <TextField
            fullWidth
            label={label}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            type={shown ? 'text' : 'password'}
            autoComplete='new-password'
            placeholder={placeholder}
            helperText={error || helperText}
            error={Boolean(error)}
            disabled={disabled}
            inputProps={{ 'data-testid': testId, spellCheck: false }}
            InputLabelProps={{ shrink: true }}
            InputProps={{
                endAdornment: (
                    <InputAdornment position='end'>
                        {adornment}
                        <IconButton
                            size='small'
                            onClick={() => setShown((now) => !now)}
                            aria-label={shown ? `Hide ${label}` : `Show ${label}`}
                        >
                            {shown ? <IconEyeOff size={17} /> : <IconEye size={17} />}
                        </IconButton>
                    </InputAdornment>
                )
            }}
        />
    )
}

SecretField.propTypes = {
    label: PropTypes.string.isRequired,
    value: PropTypes.string.isRequired,
    onChange: PropTypes.func.isRequired,
    placeholder: PropTypes.string,
    helperText: PropTypes.node,
    error: PropTypes.string,
    adornment: PropTypes.node,
    testId: PropTypes.string,
    disabled: PropTypes.bool
}

const CheckList = ({ items }) => {
    const theme = useTheme()
    return (
        <Stack component='ul' gap={1} sx={{ listStyle: 'none', m: 0, p: 0 }}>
            {items.map((item) => {
                const color = !item.ok ? theme.palette.error.main : item.warn ? theme.palette.warning.main : theme.palette.success.main
                return (
                    <Stack component='li' key={item.label} direction='row' gap={1.25} alignItems='flex-start'>
                        {item.ok ? (
                            <IconCircleCheckFilled size={18} style={{ color, flexShrink: 0, marginTop: 1 }} />
                        ) : (
                            <IconCircleXFilled size={18} style={{ color, flexShrink: 0, marginTop: 1 }} />
                        )}
                        <Typography variant='body2'>
                            <Box component='span' sx={{ fontWeight: 600 }}>
                                {item.label}
                            </Box>
                            {item.detail ? (
                                <Box component='span' sx={{ color: 'text.secondary' }}>
                                    {'  '}
                                    {item.detail}
                                </Box>
                            ) : null}
                        </Typography>
                    </Stack>
                )
            })}
        </Stack>
    )
}

CheckList.propTypes = { items: PropTypes.array.isRequired }

// setupMode: opened from the one-time setup link on a server where nobody can sign in yet. The owner email is
// required, there is no password sign-in to keep, and saving restarts the server.
const AuthKitWizard = ({
    open,
    onClose,
    settings,
    ownerEmail,
    resume,
    onSaved,
    passwordLocked,
    api = serverSettingsApi,
    setupMode = false
}) => {
    const theme = useTheme()
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    const [step, setStep] = useState(0)
    const [form, setForm] = useState(() => initialForm(settings, origin, ownerEmail))
    const [checking, setChecking] = useState(false)
    const [check, setCheck] = useState(null)
    const [starting, setStarting] = useState(false)
    const [startError, setStartError] = useState(null)
    const [result, setResult] = useState(null)
    const [keepPassword, setKeepPassword] = useState(true)
    const [saving, setSaving] = useState(false)
    const [saveError, setSaveError] = useState(null)

    const environment = detectEnvironment(form.apiKey) ?? (check?.environment && check.environment !== 'unknown' ? check.environment : null)
    const problems = useMemo(() => fieldProblems(form, environment), [form, environment])
    const addresses = authKitAddresses(form.redirectUri)
    const set = (key) => (value) => {
        setForm((now) => ({ ...now, [key]: value }))
        setCheck(null)
    }

    // Opening fresh starts from the saved values. Coming back from a test sign-in shows its result.
    useEffect(() => {
        if (!open) return
        if (resume) {
            setStep(3)
            api.authKitTestStatus()
                .then((res) => {
                    setResult(res.data)
                    const values = res.data?.values ?? {}
                    setForm((now) => ({
                        ...now,
                        clientId: typeof values.WORKOS_CLIENT_ID === 'string' ? values.WORKOS_CLIENT_ID : now.clientId,
                        redirectUri: typeof values.WORKOS_REDIRECT_URI === 'string' ? values.WORKOS_REDIRECT_URI : now.redirectUri,
                        email: typeof values.CUTTLELY_BOOTSTRAP_EMAIL === 'string' ? values.CUTTLELY_BOOTSTRAP_EMAIL : now.email
                    }))
                })
                .catch(() => setResult({ status: 'none' }))
        } else {
            setStep(0)
            setForm(initialForm(settings, origin, ownerEmail))
            setResult(null)
            setCheck(null)
        }
        setStartError(null)
        setSaveError(null)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, resume])

    // The last step checks the values with the server (and WorkOS) as soon as it opens.
    useEffect(() => {
        if (!open || step !== 3 || result || check || checking) return
        setChecking(true)
        api.checkAuthKit(wizardValues(form))
            .then((res) => setCheck(res.data))
            .catch((error) =>
                setCheck({
                    ok: false,
                    checks: [{ label: 'Check', ok: false, detail: error?.response?.data?.message ?? 'The check could not run.' }]
                })
            )
            .finally(() => setChecking(false))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, step, result, check])

    const startTest = async () => {
        setStarting(true)
        setStartError(null)
        try {
            const res = await api.startAuthKitTest(wizardValues(form))
            window.location.assign(res.data.url)
        } catch (error) {
            const errors = error?.response?.data?.errors ?? []
            setStartError(
                errors.length ? errors.map((item) => item.message).join(' ') : error?.response?.data?.message ?? 'The test could not start.'
            )
            setStarting(false)
        }
    }

    const save = async () => {
        setSaving(true)
        setSaveError(null)
        try {
            const res = await api.applyAuthKitTest(setupMode ? true : keepPassword)
            onSaved(res.data, setupMode ? true : keepPassword)
        } catch (error) {
            setSaveError(error?.response?.data?.message ?? 'The AuthKit settings could not be saved.')
        } finally {
            setSaving(false)
        }
    }

    const again = () => {
        setResult(null)
        setCheck(null)
        setStep(0)
    }

    const canTest = check && check.checks.every((item) => item.ok)
    const lockedNote = (key) => (form.locked?.[key] ? 'Set by the host. It stays as it is.' : undefined)

    const stepBody = () => {
        if (step === 0)
            return (
                <Stack gap={2.5}>
                    <Typography color='text.secondary'>
                        In the WorkOS dashboard, pick the environment first: Staging to try things out, Production for real users. Each has
                        its own key and Client ID. The API key is under Developer, API Keys. The Client ID is under Applications, on the
                        Details tab.
                    </Typography>
                    <SecretField
                        label='API key'
                        value={form.apiKey}
                        onChange={set('apiKey')}
                        placeholder={form.savedKey ? 'Saved. Leave blank to keep it.' : 'sk_test_... or sk_live_...'}
                        error={problems.apiKey}
                        helperText={lockedNote('WORKOS_API_KEY') ?? 'Write-only. Cuttlely never shows it again.'}
                        adornment={<EnvironmentChip environment={detectEnvironment(form.apiKey)} />}
                        testId='authkit-api-key'
                        disabled={form.locked?.WORKOS_API_KEY}
                    />
                    <TextField
                        fullWidth
                        label='Client ID'
                        value={form.clientId}
                        onChange={(event) => set('clientId')(event.target.value)}
                        placeholder='client_...'
                        error={Boolean(problems.clientId)}
                        helperText={problems.clientId ?? lockedNote('WORKOS_CLIENT_ID')}
                        disabled={form.locked?.WORKOS_CLIENT_ID}
                        InputLabelProps={{ shrink: true }}
                        inputProps={{ 'data-testid': 'authkit-client-id', spellCheck: false }}
                    />
                </Stack>
            )
        if (step === 1)
            return (
                <Stack gap={2.5}>
                    <Typography color='text.secondary'>
                        AuthKit sends people back to this address after they sign in. It is filled in from the address you opened Cuttlely
                        at. Change it if people reach Cuttlely at another address.
                    </Typography>
                    <TextField
                        fullWidth
                        label='Redirect URI'
                        value={form.redirectUri}
                        onChange={(event) => set('redirectUri')(event.target.value)}
                        error={Boolean(problems.redirectUri)}
                        helperText={problems.redirectUri ?? lockedNote('WORKOS_REDIRECT_URI')}
                        disabled={form.locked?.WORKOS_REDIRECT_URI}
                        InputLabelProps={{ shrink: true }}
                        inputProps={{ 'data-testid': 'authkit-redirect', spellCheck: false }}
                    />
                    {addresses && (
                        <Box>
                            <Typography sx={{ fontWeight: 600, mb: 1 }}>Add these in WorkOS, Applications, Redirects</Typography>
                            <Box
                                sx={{
                                    borderRadius: 2.5,
                                    border: `1px solid ${theme.palette.divider}`,
                                    '& > *:not(:first-of-type)': { borderTop: `1px solid ${theme.palette.divider}` }
                                }}
                            >
                                {addresses.map((row) => (
                                    <CopyRow key={row.label} label={row.label} value={row.value} />
                                ))}
                            </Box>
                            <Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 1 }}>
                                They must match character for character. http://127.0.0.1 and http://localhost are different addresses.
                            </Typography>
                        </Box>
                    )}
                </Stack>
            )
        if (step === 2)
            return (
                <Stack gap={2.5}>
                    <Typography color='text.secondary'>
                        The session seal encrypts the AuthKit sign-in cookie. Keep it the same on every restart, or everyone has to sign in
                        again. It is not the key Cuttlely uses for saved credentials.
                    </Typography>
                    <SecretField
                        label='Session seal'
                        value={form.seal}
                        onChange={set('seal')}
                        placeholder={form.savedSeal ? 'Saved. Leave blank to keep it.' : 'At least 32 characters'}
                        error={problems.seal}
                        helperText={
                            lockedNote('WORKOS_COOKIE_PASSWORD') ??
                            (form.seal && form.savedSeal ? 'A new seal signs out everyone who signed in with AuthKit.' : 'Write-only.')
                        }
                        adornment={
                            <Button
                                size='small'
                                onClick={() => set('seal')(generateSeal())}
                                startIcon={<IconSparkles size={15} />}
                                sx={{ mr: 0.5, borderRadius: 2, whiteSpace: 'nowrap' }}
                                data-testid='authkit-generate-seal'
                                disabled={form.locked?.WORKOS_COOKIE_PASSWORD}
                            >
                                Generate seal
                            </Button>
                        }
                        testId='authkit-seal'
                        disabled={form.locked?.WORKOS_COOKIE_PASSWORD}
                    />
                    <TextField
                        fullWidth
                        label='First owner email'
                        value={form.email}
                        onChange={(event) => set('email')(event.target.value)}
                        error={Boolean(problems.email)}
                        helperText={
                            problems.email ??
                            lockedNote('CUTTLELY_BOOTSTRAP_EMAIL') ??
                            (setupMode
                                ? 'Required. This email becomes the owner at its first sign-in. Use it for the test sign-in too.'
                                : 'Only used when the database has no accounts: this email becomes the owner at its first sign-in.')
                        }
                        disabled={form.locked?.CUTTLELY_BOOTSTRAP_EMAIL}
                        InputLabelProps={{ shrink: true }}
                        inputProps={{ 'data-testid': 'authkit-email', spellCheck: false }}
                    />
                </Stack>
            )
        // Step 4: check, test sign-in, then save.
        if (result && result.status !== 'none' && result.status !== 'waiting') {
            const passed = result.status === 'passed'
            const tone = passed ? theme.palette.success.main : theme.palette.error.main
            return (
                <Stack gap={2.5} data-testid='authkit-result'>
                    <Box
                        sx={{
                            p: 2,
                            borderRadius: 3,
                            border: `1px solid ${alpha(tone, 0.35)}`,
                            backgroundColor: alpha(tone, theme.palette.mode === 'dark' ? 0.1 : 0.05)
                        }}
                    >
                        <Stack direction='row' gap={1.25} alignItems='center' sx={{ mb: result.steps?.length ? 1.5 : 0 }}>
                            {passed ? <IconCircleCheckFilled size={22} color={tone} /> : <IconCircleXFilled size={22} color={tone} />}
                            <Typography sx={{ fontWeight: 650, flexGrow: 1 }}>{result.message}</Typography>
                            <EnvironmentChip environment={result.environment} />
                        </Stack>
                        {result.steps?.length ? <CheckList items={result.steps} /> : null}
                    </Box>
                    {passed && !result.applied && setupMode && (
                        <>
                            <Typography color='text.secondary'>
                                Save and restart, then sign in with AuthKit as {form.email || 'the owner email'}. This setup link stops
                                working once you save.
                            </Typography>
                            {saveError && (
                                <Alert severity='error' sx={{ borderRadius: 2.5 }}>
                                    {saveError}
                                </Alert>
                            )}
                        </>
                    )}
                    {passed && !result.applied && !setupMode && (
                        <>
                            <Box sx={{ p: 2, borderRadius: 3, border: `1px solid ${theme.palette.divider}` }}>
                                <FormControlLabel
                                    sx={{ m: 0, alignItems: 'flex-start', gap: 1.5 }}
                                    control={
                                        <Switch
                                            checked={keepPassword}
                                            onChange={(event) => setKeepPassword(event.target.checked)}
                                            disabled={passwordLocked}
                                            inputProps={{ 'data-testid': 'authkit-keep-password' }}
                                        />
                                    }
                                    label={
                                        <Box>
                                            <Typography sx={{ fontWeight: 600 }}>Keep password sign-in as a backup</Typography>
                                            <Typography variant='body2' color='text.secondary'>
                                                {passwordLocked
                                                    ? 'Set by the host, so it stays as it is.'
                                                    : 'Recommended. The owner can still sign in with a password if WorkOS is ever unreachable.'}
                                            </Typography>
                                        </Box>
                                    }
                                />
                            </Box>
                            {saveError && (
                                <Alert severity='error' sx={{ borderRadius: 2.5 }}>
                                    {saveError}
                                </Alert>
                            )}
                        </>
                    )}
                </Stack>
            )
        }
        return (
            <Stack gap={2.5}>
                <Typography color='text.secondary'>
                    {setupMode
                        ? `First Cuttlely checks the values. Then Test sign-in opens AuthKit with them. Sign in as ${
                              form.email || 'the owner email'
                          }; you come straight back here. Nothing is saved until the test passes and you choose Save.`
                        : 'First Cuttlely checks the values. Then Test sign-in opens AuthKit with them. Sign in as yourself; you come straight back here. Nothing is saved until the test passes and you choose Save.'}
                </Typography>
                <Box
                    sx={{ p: 2, borderRadius: 3, border: `1px solid ${theme.palette.divider}`, minHeight: 120 }}
                    data-testid='authkit-check'
                >
                    {checking || !check ? (
                        <Stack direction='row' gap={1.25} alignItems='center' sx={{ color: 'text.secondary' }}>
                            <CircularProgress size={16} />
                            <Typography variant='body2'>Checking the values with WorkOS</Typography>
                        </Stack>
                    ) : (
                        <CheckList items={check.checks} />
                    )}
                </Box>
                {result?.status === 'waiting' && (
                    <Alert severity='info' sx={{ borderRadius: 2.5 }}>
                        A test sign-in was started and has not come back yet. Start it again below.
                    </Alert>
                )}
                {startError && (
                    <Alert severity='error' sx={{ borderRadius: 2.5 }}>
                        {startError}
                    </Alert>
                )}
            </Stack>
        )
    }

    const passed = result?.status === 'passed' && !result?.applied
    const finished = result && result.status !== 'none' && result.status !== 'waiting'

    return (
        <Dialog
            open={open}
            onClose={onClose}
            fullWidth
            maxWidth='md'
            PaperProps={{ sx: { borderRadius: 4, overflow: 'hidden', backgroundImage: 'none', ...SENTENCE_CASE_BUTTONS } }}
            aria-labelledby='authkit-title'
        >
            <DialogContent sx={{ p: 0 }}>
                <Stack direction={{ xs: 'column', md: 'row' }} sx={{ minHeight: 500 }}>
                    <Box
                        sx={{
                            width: { md: 250 },
                            flexShrink: 0,
                            p: 3,
                            backgroundColor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.1 : 0.04),
                            borderRight: { md: `1px solid ${theme.palette.divider}` }
                        }}
                    >
                        <Typography id='authkit-title' variant='h3' sx={{ fontSize: '1.2rem', fontWeight: 650 }}>
                            Set up AuthKit
                        </Typography>
                        <Typography variant='body2' color='text.secondary' sx={{ mt: 0.5, mb: 3 }}>
                            Let people sign in with WorkOS.
                        </Typography>
                        <Stack gap={0.5}>
                            {STEPS.map((item, index) => {
                                const Icon = item.icon
                                const current = index === step
                                const done = index < step
                                const reachable =
                                    index <= step || [0, 1, 2].slice(0, index).every((i) => stepReady(i, form, { needEmail: setupMode }))
                                return (
                                    <ButtonBase
                                        key={item.title}
                                        disabled={!reachable || starting}
                                        onClick={() => {
                                            if (finished && index < 3) again()
                                            setStep(index)
                                        }}
                                        sx={{
                                            justifyContent: 'flex-start',
                                            gap: 1.5,
                                            p: 1.25,
                                            borderRadius: 2.5,
                                            textAlign: 'left',
                                            backgroundColor: current ? theme.palette.background.paper : 'transparent',
                                            boxShadow: current ? `0 1px 3px ${alpha(theme.palette.common.black, 0.08)}` : 'none',
                                            opacity: reachable ? 1 : 0.5
                                        }}
                                    >
                                        <Box
                                            sx={{
                                                width: 30,
                                                height: 30,
                                                borderRadius: '50%',
                                                flexShrink: 0,
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                color: current || done ? theme.palette.primary.contrastText : theme.palette.text.secondary,
                                                backgroundColor:
                                                    current || done ? theme.palette.primary.main : alpha(theme.palette.text.primary, 0.08)
                                            }}
                                        >
                                            {done ? <IconCheck size={16} /> : <Icon size={16} />}
                                        </Box>
                                        <Box sx={{ minWidth: 0 }}>
                                            <Typography sx={{ fontWeight: current ? 650 : 500, fontSize: '0.9rem' }}>
                                                {item.title}
                                            </Typography>
                                            <Typography variant='caption' color='text.secondary'>
                                                {item.hint}
                                            </Typography>
                                        </Box>
                                    </ButtonBase>
                                )
                            })}
                        </Stack>
                    </Box>
                    <Stack sx={{ flexGrow: 1, minWidth: 0 }}>
                        <Stack direction='row' alignItems='center' gap={1.5} sx={{ px: 3, pt: 2.5 }}>
                            <Typography variant='h3' sx={{ fontSize: '1.15rem', fontWeight: 650, flexGrow: 1 }}>
                                {STEPS[step].title}
                            </Typography>
                            <EnvironmentChip environment={environment} />
                            <IconButton onClick={onClose} aria-label='Close' size='small'>
                                <IconX size={18} />
                            </IconButton>
                        </Stack>
                        <Box sx={{ px: 3, py: 2.5, flexGrow: 1 }}>{stepBody()}</Box>
                        <Stack
                            direction='row'
                            justifyContent='space-between'
                            alignItems='center'
                            sx={{ px: 3, py: 2, borderTop: `1px solid ${theme.palette.divider}` }}
                        >
                            <Button
                                onClick={() => (finished ? again() : step === 0 ? onClose() : setStep(step - 1))}
                                sx={{ borderRadius: 2.5 }}
                                disabled={starting || saving}
                            >
                                {finished ? 'Change the values' : step === 0 ? 'Cancel' : 'Back'}
                            </Button>
                            {step < 3 ? (
                                <Button
                                    variant='contained'
                                    disableElevation
                                    onClick={() => setStep(step + 1)}
                                    disabled={!stepReady(step, form, { needEmail: setupMode })}
                                    sx={{ borderRadius: 2.5, px: 3 }}
                                    data-testid='authkit-next'
                                >
                                    Next
                                </Button>
                            ) : passed ? (
                                <Button
                                    variant='contained'
                                    disableElevation
                                    onClick={save}
                                    disabled={saving}
                                    sx={{ borderRadius: 2.5, px: 3 }}
                                    data-testid='authkit-save'
                                >
                                    {saving ? 'Saving' : setupMode ? 'Save and restart' : 'Save AuthKit settings'}
                                </Button>
                            ) : finished ? (
                                <Button variant='contained' disableElevation onClick={onClose} sx={{ borderRadius: 2.5, px: 3 }}>
                                    Close
                                </Button>
                            ) : (
                                <Button
                                    variant='contained'
                                    disableElevation
                                    onClick={startTest}
                                    disabled={!canTest || starting}
                                    startIcon={starting ? <CircularProgress size={15} color='inherit' /> : <IconShieldCheck size={17} />}
                                    sx={{ borderRadius: 2.5, px: 3 }}
                                    data-testid='authkit-test'
                                >
                                    Test sign-in
                                </Button>
                            )}
                        </Stack>
                    </Stack>
                </Stack>
            </DialogContent>
        </Dialog>
    )
}

AuthKitWizard.propTypes = {
    open: PropTypes.bool.isRequired,
    onClose: PropTypes.func.isRequired,
    settings: PropTypes.array.isRequired,
    ownerEmail: PropTypes.string,
    resume: PropTypes.bool,
    onSaved: PropTypes.func.isRequired,
    passwordLocked: PropTypes.bool,
    api: PropTypes.object,
    setupMode: PropTypes.bool
}

export default AuthKitWizard
