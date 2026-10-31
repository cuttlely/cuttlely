import { useEffect, useState } from 'react'
import {
    Alert,
    Box,
    Button,
    Chip,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    Paper,
    Radio,
    RadioGroup,
    MenuItem,
    Select,
    Stack,
    TextField,
    Typography
} from '@mui/material'
import MainCard from '@/ui-component/cards/MainCard'
import api from '@/api/authenticationSettings'
import { RECOVERY_FIX } from './RecoveryWarningBanner'

const label = (method) => (method === 'workos' ? 'WorkOS' : method === 'local' ? 'Local login' : 'No ordinary method')

const copyText = (value) => {
    const field = document.createElement('textarea')
    field.value = value
    field.setAttribute('readonly', '')
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.appendChild(field)
    field.select()
    document.execCommand('copy')
    field.remove()
}

export default function AuthenticationSettings() {
    const [data, setData] = useState(null)
    const [error, setError] = useState('')
    const [choice, setChoice] = useState('')
    const [stage, setStage] = useState(null)
    const [confirm, setConfirm] = useState('')
    const [warningConfirmationOpen, setWarningConfirmationOpen] = useState(false)
    const [scimClear, setScimClear] = useState('')
    const [overlapHours, setOverlapHours] = useState(1)
    const load = () =>
        api
            .get()
            .then(({ data: value }) => {
                setData(value)
                setChoice(value.activeMethod || '')
            })
            .catch(() => setError('Authentication settings could not be loaded.'))
    useEffect(() => {
        load()
    }, [])
    const prepare = async () => {
        setError('')
        try {
            setStage({ ...(await api.stage(choice, data.version)).data, stateVersion: data.version })
        } catch (cause) {
            setError(cause?.response?.data?.message || 'The change could not be staged.')
        }
    }
    const apply = async () => {
        try {
            const result = (await api.apply(stage, confirm)).data
            window.location.assign(result.redirectTo)
        } catch (cause) {
            setError(cause?.response?.data?.message || 'The sign-in method was not changed.')
            setStage(null)
        }
    }
    const reauthenticate = () => {
        window.location.assign(data?.activeMethod === 'workos' ? '/api/v1/auth/reauthenticate' : '/signin?reauth=1')
    }
    const acknowledgeWarning = async () => {
        setError('')
        try {
            const result = (await api.acknowledgeWarning(data.version)).data
            setWarningConfirmationOpen(false)
            window.location.assign(result.redirectTo)
        } catch (cause) {
            setError(cause?.response?.data?.message || 'The warning could not be acknowledged.')
        }
    }
    const acknowledgeRecoveryAlert = async () => {
        setError('')
        try {
            await api.acknowledgeRecoveryAlert(data.recovery.alert.id)
            await load()
            window.dispatchEvent(new Event('cuttlely:recovery-alert-acknowledged'))
        } catch (cause) {
            setError(cause?.response?.data?.message || 'The recovery alert could not be acknowledged.')
        }
    }
    const changeScim = async (request) => {
        setError('')
        try {
            const result = (await request()).data
            setData((current) => ({ ...current, scim: { ...current.scim, ...result.state } }))
            setScimClear(result.clear || '')
        } catch (cause) {
            setError(cause?.response?.data?.message || 'The SCIM credential could not be changed.')
        }
    }
    const scimBaseUrl = data?.scim?.basePath ? `${window.location.origin}${data.scim.basePath}` : ''
    const workosBlockedByRecovery = Boolean(data?.methods.workos.configured && !data?.recovery.available)
    return (
        <MainCard title='Auth / SSO'>
            <Stack spacing={3} sx={{ maxWidth: 820 }}>
                {error && <Alert severity='error'>{error}</Alert>}
                {data && !data.recovery.available && (
                    <Alert severity='error' data-testid='owner-recovery-blocking-warning'>
                        Owner recovery is not ready. {RECOVERY_FIX} Until this is fixed, panel activation of a remote method is refused.
                    </Alert>
                )}
                {data?.recovery?.alert && (
                    <Alert
                        severity='warning'
                        data-testid='owner-recovery-alert'
                        action={
                            <Button color='inherit' size='small' onClick={acknowledgeRecoveryAlert}>
                                Acknowledge
                            </Button>
                        }
                    >
                        An owner recovery sign-in occurred at {new Date(data.recovery.alert.occurredAt).toLocaleString()}. Review the audit
                        log.
                    </Alert>
                )}
                {data?.warning && data.warningKind === 'workos-client-mismatch' && (
                    <Alert
                        severity='warning'
                        action={
                            <Button color='inherit' size='small' onClick={() => setWarningConfirmationOpen(true)}>
                                Acknowledge
                            </Button>
                        }
                    >
                        {data.warning} Automatic email linking is blocked until this warning is acknowledged after a fresh sign-in.
                    </Alert>
                )}
                {data?.warning && data.warningKind !== 'workos-client-mismatch' && <Alert severity='warning'>{data.warning}</Alert>}
                <Paper variant='outlined' sx={{ p: 2.5 }}>
                    <Stack spacing={1}>
                        <Typography variant='h4'>Active method</Typography>
                        <Typography>{label(data?.activeMethod)}</Typography>
                        <Typography color='text.secondary'>
                            Changing the method ends every interactive session. API keys remain enabled.
                        </Typography>
                        <Typography color='text.secondary' data-testid='authentication-last-change'>
                            Last change: {data?.changedAt ? new Date(data.changedAt).toLocaleString() : 'No method change recorded'}
                        </Typography>
                        <Typography color='text.secondary' data-testid='authentication-sessions-ended'>
                            Sessions ended by the last change: {data?.sessionsEnded ?? 0}
                        </Typography>
                    </Stack>
                </Paper>
                <Paper variant='outlined' sx={{ p: 2.5 }}>
                    <Typography variant='h4' gutterBottom>
                        Choose a sign-in method
                    </Typography>
                    <RadioGroup value={choice} onChange={(event) => setChoice(event.target.value)}>
                        <FormControlLabel
                            value='local'
                            control={<Radio />}
                            disabled={!data?.methods.local.configured}
                            label={`Local login${data?.methods.local.configured ? '' : ' — not configured'}`}
                        />
                        <FormControlLabel
                            value='workos'
                            control={<Radio />}
                            disabled={!data?.methods.workos.configured}
                            label={`WorkOS${
                                !data?.methods.workos.configured
                                    ? ' — not configured'
                                    : workosBlockedByRecovery
                                    ? ' — activation will be refused until owner recovery is ready'
                                    : ''
                            }`}
                        />
                        <FormControlLabel value='oidc' control={<Radio />} disabled label='Generic OIDC — not yet available' />
                    </RadioGroup>
                    <Button variant='contained' disabled={!choice || choice === data?.activeMethod} onClick={prepare}>
                        Review change
                    </Button>
                    <Button sx={{ ml: 1 }} onClick={reauthenticate}>
                        Sign in again
                    </Button>
                    {data?.activeMethod === 'workos' && (
                        <Typography color='text.secondary' sx={{ mt: 1 }}>
                            WorkOS satisfies this check only when it proves the sign-in time. If it cannot, use{' '}
                            <strong>Owner recovery</strong> on the sign-in page.
                        </Typography>
                    )}
                </Paper>
                <Paper variant='outlined' sx={{ p: 2.5 }}>
                    <Stack direction='row' justifyContent='space-between'>
                        <Box>
                            <Typography variant='h4'>Owner recovery</Typography>
                            <Typography color='text.secondary'>
                                The recovery route is always available. A remote method can be activated only while an active owner has a
                                usable local password.
                            </Typography>
                        </Box>
                        <Chip
                            label={data?.recovery.available ? 'Ready' : 'Needs owner credential'}
                            color={data?.recovery.available ? 'success' : 'warning'}
                        />
                    </Stack>
                </Paper>
                <Paper variant='outlined' sx={{ p: 2.5 }}>
                    <Stack spacing={1.5} data-testid='scim-settings-card'>
                        <Stack direction='row' justifyContent='space-between' alignItems='center'>
                            <Typography variant='h4'>SCIM provisioning</Typography>
                            <Chip
                                label={
                                    data?.scim?.status === 'overlap'
                                        ? `Rotation overlap until ${new Date(data.scim.overlapEndsAt).toLocaleString()}`
                                        : data?.scim?.status === 'active'
                                        ? 'Active'
                                        : data?.scim?.status === 'revoked'
                                        ? 'Revoked'
                                        : 'No credential'
                                }
                                color={data?.scim?.status === 'active' || data?.scim?.status === 'overlap' ? 'success' : 'default'}
                            />
                        </Stack>
                        <TextField
                            label='SCIM base URL'
                            value={scimBaseUrl}
                            InputProps={{ readOnly: true }}
                            helperText='Use this URL in the identity provider.'
                        />
                        {scimBaseUrl && (
                            <Button sx={{ alignSelf: 'flex-start' }} onClick={() => copyText(scimBaseUrl)}>
                                Copy base URL
                            </Button>
                        )}
                        {data?.scim?.displayPrefix && <Typography>Credential: {data.scim.displayPrefix}</Typography>}
                        {data?.scim?.createdAt && (
                            <Typography color='text.secondary'>
                                Created by {data.scim.createdBy || 'unknown'} at {new Date(data.scim.createdAt).toLocaleString()}
                            </Typography>
                        )}
                        <Typography color='text.secondary'>
                            Last used: {data?.scim?.lastUsedAt ? new Date(data.scim.lastUsedAt).toLocaleString() : 'Never'}
                        </Typography>
                        {scimClear && (
                            <Alert severity='warning' data-testid='scim-clear-value'>
                                Save this value now. It will not be shown again.
                                <TextField fullWidth sx={{ mt: 1 }} value={scimClear} InputProps={{ readOnly: true }} />
                            </Alert>
                        )}
                        <Stack direction='row' spacing={1} useFlexGap flexWrap='wrap' alignItems='center'>
                            {data?.scim?.status === 'none' || data?.scim?.status === 'revoked' ? (
                                <Button variant='contained' onClick={() => changeScim(api.createScimToken)}>
                                    Create
                                </Button>
                            ) : (
                                <>
                                    <Select
                                        size='small'
                                        aria-label='Rotation overlap window'
                                        value={overlapHours}
                                        onChange={(event) => setOverlapHours(Number(event.target.value))}
                                    >
                                        <MenuItem value={0}>No overlap</MenuItem>
                                        <MenuItem value={1}>1 hour overlap</MenuItem>
                                        <MenuItem value={4}>4 hour overlap</MenuItem>
                                        <MenuItem value={24}>24 hour overlap</MenuItem>
                                    </Select>
                                    <Button variant='contained' onClick={() => changeScim(() => api.rotateScimToken(overlapHours))}>
                                        Rotate
                                    </Button>
                                    {data?.scim?.status === 'overlap' && (
                                        <Button onClick={() => changeScim(api.endScimOverlap)}>End previous now</Button>
                                    )}
                                    <Button color='error' onClick={() => changeScim(api.revokeScimToken)}>
                                        Revoke
                                    </Button>
                                </>
                            )}
                            <Button onClick={reauthenticate}>Sign in again</Button>
                        </Stack>
                        <Typography color='text.secondary'>Groups are not available yet.</Typography>
                    </Stack>
                </Paper>
            </Stack>
            <Dialog open={Boolean(stage)} onClose={() => setStage(null)}>
                <DialogTitle>End all interactive sessions?</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} sx={{ mt: 1 }}>
                        <Alert severity='warning'>Everyone, including you, must sign in again. API keys remain enabled.</Alert>
                        <TextField label='Type END SESSIONS' value={confirm} onChange={(event) => setConfirm(event.target.value)} />
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setStage(null)}>Cancel</Button>
                    <Button color='error' variant='contained' disabled={confirm !== 'END SESSIONS'} onClick={apply}>
                        Change method
                    </Button>
                </DialogActions>
            </Dialog>
            <Dialog open={warningConfirmationOpen} onClose={() => setWarningConfirmationOpen(false)}>
                <DialogTitle>Acknowledge and end all interactive sessions?</DialogTitle>
                <DialogContent>
                    <Alert severity='warning'>Everyone, including you, must sign in again.</Alert>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setWarningConfirmationOpen(false)}>Cancel</Button>
                    <Button color='error' variant='contained' onClick={acknowledgeWarning}>
                        Acknowledge and end sessions
                    </Button>
                </DialogActions>
            </Dialog>
        </MainCard>
    )
}
