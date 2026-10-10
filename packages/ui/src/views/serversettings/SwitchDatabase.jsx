// Switch database: choose, fill in, test (always), then type RESTART. Data is not copied between databases.
import { useEffect, useState } from 'react'
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
    Paper,
    Stack,
    Switch,
    TextField,
    Typography
} from '@mui/material'
import {
    IconArrowBackUp,
    IconArrowRight,
    IconCircleCheckFilled,
    IconCircleXFilled,
    IconDatabase,
    IconFile,
    IconInfoCircle,
    IconServer2,
    IconX
} from '@tabler/icons-react'

import serverSettingsApi from '@/api/serverSettings'
import { switchValues } from './database'
import { SENTENCE_CASE_BUTTONS } from './layout'

export const CONFIRM_WORD = 'RESTART'

const STEP_TITLES = ['Choose a database', 'Connection', 'Test', 'Confirm']

const emptyPostgres = (settings) => {
    const byKey = Object.fromEntries((settings ?? []).map((setting) => [setting.key, setting]))
    const saved = (key, fallback = '') => byKey[key]?.value || fallback
    return {
        DATABASE_HOST: saved('DATABASE_HOST'),
        DATABASE_PORT: saved('DATABASE_PORT', '5432'),
        DATABASE_NAME: saved('DATABASE_NAME', 'cuttlely'),
        DATABASE_USER: saved('DATABASE_USER'),
        DATABASE_PASSWORD: '',
        DATABASE_SSL: saved('DATABASE_SSL', 'false'),
        passwordSaved: Boolean(byKey.DATABASE_PASSWORD?.secret?.set)
    }
}

const Choice = ({ selected, onClick, icon: Icon, title, body, testId }) => {
    const theme = useTheme()
    return (
        <ButtonBase
            onClick={onClick}
            data-testid={testId}
            sx={{
                flex: 1,
                p: 2.25,
                borderRadius: 3,
                textAlign: 'left',
                alignItems: 'flex-start',
                justifyContent: 'flex-start',
                gap: 1.75,
                border: `1.5px solid ${selected ? theme.palette.primary.main : theme.palette.divider}`,
                backgroundColor: selected ? alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.14 : 0.05) : 'transparent',
                transition: 'border-color 120ms ease, background-color 120ms ease'
            }}
        >
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
                    backgroundColor: alpha(theme.palette.primary.main, 0.12)
                }}
            >
                <Icon size={21} stroke={1.7} />
            </Box>
            <Box>
                <Typography sx={{ fontWeight: 650 }}>{title}</Typography>
                <Typography variant='body2' color='text.secondary'>
                    {body}
                </Typography>
            </Box>
        </ButtonBase>
    )
}

Choice.propTypes = {
    selected: PropTypes.bool,
    onClick: PropTypes.func.isRequired,
    icon: PropTypes.elementType.isRequired,
    title: PropTypes.string.isRequired,
    body: PropTypes.string.isRequired,
    testId: PropTypes.string
}

const Line = ({ ok, label, detail }) => {
    const theme = useTheme()
    const color = ok ? theme.palette.success.main : theme.palette.error.main
    return (
        <Stack direction='row' gap={1.25} alignItems='flex-start'>
            {ok ? (
                <IconCircleCheckFilled size={18} style={{ color, flexShrink: 0, marginTop: 1 }} />
            ) : (
                <IconCircleXFilled size={18} style={{ color, flexShrink: 0, marginTop: 1 }} />
            )}
            <Typography variant='body2'>
                <Box component='span' sx={{ fontWeight: 600 }}>
                    {label}
                </Box>
                {detail ? (
                    <Box component='span' sx={{ color: 'text.secondary' }}>
                        {'  '}
                        {detail}
                    </Box>
                ) : null}
            </Typography>
        </Stack>
    )
}

Line.propTypes = { ok: PropTypes.bool, label: PropTypes.string.isRequired, detail: PropTypes.string }

const SwitchDatabase = ({ open, mode, onClose, settings, database, onDone }) => {
    const theme = useTheme()
    const restore = mode === 'restore'
    const [step, setStep] = useState(0)
    const [type, setType] = useState('postgres')
    const [form, setForm] = useState(() => emptyPostgres(settings))
    const [check, setCheck] = useState(null)
    const [checking, setChecking] = useState(false)
    const [confirm, setConfirm] = useState('')
    const [working, setWorking] = useState(false)
    const [error, setError] = useState(null)

    useEffect(() => {
        if (!open) return
        setStep(restore ? 3 : 0)
        setType(database?.saved?.type === 'postgres' ? 'sqlite' : 'postgres')
        setForm(emptyPostgres(settings))
        setCheck(null)
        setConfirm('')
        setError(null)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, restore])

    const runCheck = async () => {
        setChecking(true)
        setCheck(null)
        try {
            const res = await serverSettingsApi.checkDatabase(switchValues(type, form))
            setCheck(res.data)
        } catch (failure) {
            setCheck({ error: failure?.response?.data?.message ?? 'The test could not run.' })
        } finally {
            setChecking(false)
        }
    }

    useEffect(() => {
        if (open && step === 2 && !check && !checking) runCheck()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, step])

    const go = async () => {
        setWorking(true)
        setError(null)
        try {
            const res = restore
                ? await serverSettingsApi.restoreDatabase(confirm)
                : await serverSettingsApi.switchDatabase(switchValues(type, form), confirm)
            onDone(res.data)
        } catch (failure) {
            setError(
                failure?.response?.data?.errors?.[0]?.message ?? failure?.response?.data?.message ?? 'The database could not be switched.'
            )
        } finally {
            setWorking(false)
        }
    }

    const set = (key) => (event) => {
        setForm((now) => ({ ...now, [key]: event.target.value }))
        setCheck(null)
    }
    const postgresReady =
        form.DATABASE_HOST.trim() && form.DATABASE_NAME.trim() && form.DATABASE_USER.trim() && /^\d+$/.test(String(form.DATABASE_PORT))
    const next = () => setStep(step === 0 && type === 'sqlite' ? 2 : step + 1)
    const back = () => setStep(step === 2 && type === 'sqlite' ? 0 : step - 1)
    const target = check?.test?.target?.kind

    const body = () => {
        if (step === 0)
            return (
                <Stack gap={2}>
                    <Typography color='text.secondary'>
                        Cuttlely keeps flows, credentials, accounts and history in its database. Switching points Cuttlely at another
                        database at the next restart. Nothing is copied: what is in the current database stays there.
                    </Typography>
                    <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                        <Choice
                            selected={type === 'sqlite'}
                            onClick={() => setType('sqlite')}
                            icon={IconFile}
                            title='SQLite'
                            body='A file on this server. Nothing to set up. Good for one server.'
                            testId='db-choice-sqlite'
                        />
                        <Choice
                            selected={type === 'postgres'}
                            onClick={() => setType('postgres')}
                            icon={IconServer2}
                            title='Postgres'
                            body='A database server. For backups, several workers and larger teams.'
                            testId='db-choice-postgres'
                        />
                    </Stack>
                </Stack>
            )
        if (step === 1)
            return (
                <Stack gap={2}>
                    <Typography color='text.secondary'>
                        Use an empty database, or one Cuttlely already set up. The user needs to be able to create tables.
                    </Typography>
                    <Stack direction='row' gap={1.5}>
                        <TextField
                            label='Host'
                            value={form.DATABASE_HOST}
                            onChange={set('DATABASE_HOST')}
                            fullWidth
                            InputLabelProps={{ shrink: true }}
                            inputProps={{ 'data-testid': 'db-host' }}
                        />
                        <TextField
                            label='Port'
                            value={form.DATABASE_PORT}
                            onChange={set('DATABASE_PORT')}
                            sx={{ width: 130 }}
                            InputLabelProps={{ shrink: true }}
                        />
                    </Stack>
                    <Stack direction='row' gap={1.5}>
                        <TextField
                            label='Database name'
                            value={form.DATABASE_NAME}
                            onChange={set('DATABASE_NAME')}
                            fullWidth
                            InputLabelProps={{ shrink: true }}
                        />
                        <TextField
                            label='User'
                            value={form.DATABASE_USER}
                            onChange={set('DATABASE_USER')}
                            fullWidth
                            InputLabelProps={{ shrink: true }}
                            inputProps={{ 'data-testid': 'db-user' }}
                        />
                    </Stack>
                    <TextField
                        label='Password'
                        type='password'
                        autoComplete='new-password'
                        value={form.DATABASE_PASSWORD}
                        onChange={set('DATABASE_PASSWORD')}
                        placeholder={form.passwordSaved ? 'Saved. Leave blank to keep it.' : ''}
                        helperText='Write-only. Cuttlely never shows it again.'
                        InputLabelProps={{ shrink: true }}
                        inputProps={{ 'data-testid': 'db-password' }}
                    />
                    <FormControlLabel
                        control={
                            <Switch
                                checked={form.DATABASE_SSL === 'true'}
                                onChange={(event) => {
                                    setForm((now) => ({ ...now, DATABASE_SSL: event.target.checked ? 'true' : 'false' }))
                                    setCheck(null)
                                }}
                            />
                        }
                        label='Use a secure connection (SSL)'
                    />
                </Stack>
            )
        if (step === 2)
            return (
                <Stack gap={2} data-testid='db-check'>
                    <Paper variant='outlined' sx={{ p: 2, borderRadius: 3, minHeight: 130 }}>
                        {checking || !check ? (
                            <Stack direction='row' gap={1.25} alignItems='center' sx={{ color: 'text.secondary' }}>
                                <CircularProgress size={16} />
                                <Typography variant='body2'>Testing the connection</Typography>
                            </Stack>
                        ) : check.error ? (
                            <Line ok={false} label='The test could not run.' detail={check.error} />
                        ) : (
                            <Stack gap={1}>
                                <Typography sx={{ fontWeight: 650, mb: 0.5 }}>{check.test.summary}</Typography>
                                {check.test.checks.map((item) => (
                                    <Line key={item.label} {...item} />
                                ))}
                                {check.same && (
                                    <Line ok={false} label='Same database' detail='That is the database Cuttlely already uses.' />
                                )}
                            </Stack>
                        )}
                    </Paper>
                    {check && !check.error && check.test.ok && !check.same && (
                        <Stack gap={1.25}>
                            <Alert
                                severity={check.signIn.ok ? 'info' : 'error'}
                                icon={<IconInfoCircle size={20} />}
                                sx={{ borderRadius: 2.5 }}
                                data-testid='db-sign-in'
                            >
                                <Box component='span' sx={{ fontWeight: 600 }}>
                                    {target === 'cuttlely' ? 'Signing in afterwards. ' : 'A fresh start. '}
                                </Box>
                                {check.signIn.text}
                            </Alert>
                            {target === 'cuttlely' && (
                                <Alert severity='warning' sx={{ borderRadius: 2.5 }} data-testid='db-key-warning'>
                                    This database already has Cuttlely data. Its saved credentials open only with the encryption key of the
                                    server that saved them. If that was another server, use the same key here, or enter those credentials
                                    again after the switch.
                                </Alert>
                            )}
                            <Typography variant='body2' color='text.secondary'>
                                Nothing is copied. Your flows, credentials and accounts stay in {check.current.label}, and Switch back
                                returns to it at any time. With Analyst storage on Auto, the analyst&apos;s private stores follow the new
                                database too.
                            </Typography>
                        </Stack>
                    )}
                </Stack>
            )
        return (
            <Stack gap={2.25}>
                <Paper variant='outlined' sx={{ p: 2, borderRadius: 3 }}>
                    <Stack direction='row' alignItems='center' gap={1.5} flexWrap='wrap'>
                        <Chip label={database?.saved?.label ?? 'Now'} sx={{ fontWeight: 600 }} />
                        <IconArrowRight size={18} color={theme.palette.text.secondary} />
                        <Chip
                            color='primary'
                            label={restore ? database?.previous?.label : check?.next?.label}
                            sx={{ fontWeight: 600 }}
                            data-testid='db-next'
                        />
                    </Stack>
                </Paper>
                <Typography color='text.secondary'>
                    {restore
                        ? 'Cuttlely tests the previous database again, then switches back and restarts. Nothing is copied.'
                        : 'Cuttlely saves the new database and restarts. Everyone is signed out. If it does not start twice in a row, Cuttlely goes back to the last settings that started.'}
                </Typography>
                <TextField
                    label={`Type ${CONFIRM_WORD} to confirm`}
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                    autoComplete='off'
                    InputLabelProps={{ shrink: true }}
                    inputProps={{ 'data-testid': 'db-confirm', spellCheck: false }}
                />
                {error && (
                    <Alert severity='error' sx={{ borderRadius: 2.5 }}>
                        {error}
                    </Alert>
                )}
            </Stack>
        )
    }

    const canNext = step === 0 ? true : step === 1 ? Boolean(postgresReady) : step === 2 ? Boolean(check?.canSwitch) : false
    return (
        <Dialog
            open={open}
            onClose={working ? undefined : onClose}
            fullWidth
            maxWidth='sm'
            PaperProps={{ sx: { borderRadius: 4, backgroundImage: 'none', ...SENTENCE_CASE_BUTTONS } }}
        >
            <DialogContent sx={{ p: 0 }}>
                <Stack direction='row' alignItems='center' gap={1.5} sx={{ px: 3, pt: 2.5, pb: 1 }}>
                    <Box
                        sx={{
                            width: 38,
                            height: 38,
                            borderRadius: 2.5,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: theme.palette.primary.main,
                            backgroundColor: alpha(theme.palette.primary.main, 0.1)
                        }}
                    >
                        {restore ? <IconArrowBackUp size={20} /> : <IconDatabase size={20} />}
                    </Box>
                    <Box sx={{ flexGrow: 1 }}>
                        <Typography variant='h3' sx={{ fontSize: '1.15rem', fontWeight: 650 }}>
                            {restore ? 'Switch back' : 'Switch database'}
                        </Typography>
                        {!restore && (
                            <Typography variant='caption' color='text.secondary'>
                                Step {type === 'sqlite' && step >= 2 ? step : step + 1} of {type === 'sqlite' ? 3 : 4}: {STEP_TITLES[step]}
                            </Typography>
                        )}
                    </Box>
                    <IconButton onClick={onClose} disabled={working} aria-label='Close' size='small'>
                        <IconX size={18} />
                    </IconButton>
                </Stack>
                <Box sx={{ px: 3, py: 2 }}>{body()}</Box>
                <Stack
                    direction='row'
                    justifyContent='space-between'
                    sx={{ px: 3, py: 2, borderTop: `1px solid ${theme.palette.divider}` }}
                >
                    <Button onClick={step === 0 || restore ? onClose : back} disabled={working} sx={{ borderRadius: 2.5 }}>
                        {step === 0 || restore ? 'Cancel' : 'Back'}
                    </Button>
                    {step < 3 ? (
                        <Stack direction='row' gap={1}>
                            {step === 2 && (
                                <Button onClick={runCheck} disabled={checking} sx={{ borderRadius: 2.5 }}>
                                    Test again
                                </Button>
                            )}
                            <Button
                                variant='contained'
                                disableElevation
                                onClick={next}
                                disabled={!canNext}
                                sx={{ borderRadius: 2.5, px: 3 }}
                                data-testid='db-next-step'
                            >
                                Next
                            </Button>
                        </Stack>
                    ) : (
                        <Button
                            variant='contained'
                            color='error'
                            disableElevation
                            onClick={go}
                            disabled={confirm !== CONFIRM_WORD || working}
                            startIcon={working ? <CircularProgress size={15} color='inherit' /> : null}
                            sx={{ borderRadius: 2.5, px: 3 }}
                            data-testid='db-switch'
                        >
                            {restore ? 'Switch back and restart' : 'Switch and restart'}
                        </Button>
                    )}
                </Stack>
            </DialogContent>
        </Dialog>
    )
}

SwitchDatabase.propTypes = {
    open: PropTypes.bool.isRequired,
    mode: PropTypes.oneOf(['switch', 'restore']),
    onClose: PropTypes.func.isRequired,
    settings: PropTypes.array.isRequired,
    database: PropTypes.object,
    onDone: PropTypes.func.isRequired
}

export default SwitchDatabase
