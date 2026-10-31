import { useEffect, useState } from 'react'
import {
    Alert,
    Box,
    Button,
    Checkbox,
    Chip,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    Paper,
    Radio,
    RadioGroup,
    Stack,
    TextField,
    Typography
} from '@mui/material'
import MainCard from '@/ui-component/cards/MainCard'
import api from '@/api/authenticationSettings'
import { RECOVERY_FIX } from './RecoveryWarningBanner'

const label = (method) =>
    method === 'workos' ? 'WorkOS' : method === 'local' ? 'Local login' : method === 'oidc' ? 'Generic OIDC' : 'No ordinary method'

export default function AuthenticationSettings() {
    const [data, setData] = useState(null)
    const [error, setError] = useState('')
    const [choice, setChoice] = useState('')
    const [stage, setStage] = useState(null)
    const [confirm, setConfirm] = useState('')
    const [oidc, setOidc] = useState(null)
    const [oidcForm, setOidcForm] = useState({
        issuer: '',
        clientId: '',
        clientSecretEnvVar: 'CUTTLELY_OIDC_CLIENT_SECRET',
        trustMissingEmailVerification: false,
        privateIssuerHosts: ''
    })
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
        api.getOidc()
            .then(({ data: value }) => {
                setOidc(value)
                if (value.draft?.configured) {
                    setOidcForm({
                        issuer: value.draft.issuer || '',
                        clientId: value.draft.clientId || '',
                        clientSecretEnvVar: value.draft.clientSecretEnvVar || '',
                        trustMissingEmailVerification: value.draft.trustMissingEmailVerification === true,
                        privateIssuerHosts: (value.draft.privateIssuerHosts || []).join(', ')
                    })
                }
            })
            .catch(() => setError('OIDC settings could not be loaded.'))
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
        const path =
            data?.activeMethod === 'workos'
                ? '/api/v1/auth/reauthenticate'
                : data?.activeMethod === 'oidc'
                ? '/api/v1/auth/oidc/reauthenticate'
                : '/signin?reauth=1'
        window.location.assign(path)
    }
    const acknowledgeWarning = async () => {
        setError('')
        try {
            await api.acknowledgeWarning(data.version)
            await load()
        } catch (cause) {
            setError(cause?.response?.data?.message || 'The warning could not be acknowledged.')
        }
    }
    const saveOidc = async () => {
        setError('')
        try {
            const result = await api.saveOidc({
                ...oidcForm,
                privateIssuerHosts: oidcForm.privateIssuerHosts
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean),
                version: oidc?.draft?.version || 0
            })
            setOidc((current) => ({
                ...current,
                draft: result.data.draft,
                callbackUrl: result.data.callbackUrl,
                activeCallbackUrl: result.data.activeCallbackUrl
            }))
            await load()
        } catch (cause) {
            setError(cause?.response?.data?.message || 'OIDC settings could not be saved.')
        }
    }
    const testOidc = async () => {
        setError('')
        try {
            window.location.assign((await api.testOidc()).data.url)
        } catch (cause) {
            setError(cause?.response?.data?.message || 'OIDC test sign-in could not start.')
        }
    }
    const activateOidc = async () => {
        setError('')
        try {
            setChoice('oidc')
            setStage({ ...(await api.stage('oidc', data.version)).data, stateVersion: data.version })
        } catch (cause) {
            setError(cause?.response?.data?.message || 'OIDC could not be activated.')
        }
    }
    const workosBlockedByRecovery = Boolean(data?.methods.workos.configured && !data?.recovery.available)
    const oidcMatchesActive = Boolean(
        data?.activeMethod === 'oidc' && oidc?.draft?.fingerprint && oidc.draft.fingerprint === oidc?.active?.fingerprint
    )
    return (
        <MainCard title='Auth / SSO'>
            <Stack spacing={3} sx={{ maxWidth: 820 }}>
                {error && <Alert severity='error'>{error}</Alert>}
                {data && !data.recovery.available && (
                    <Alert severity='error' data-testid='owner-recovery-blocking-warning'>
                        Owner recovery is not ready. {RECOVERY_FIX} Until this is fixed, panel activation of WorkOS or OIDC is refused.
                    </Alert>
                )}
                {data?.warning && data.warningKind === 'workos-client-mismatch' && (
                    <Alert
                        severity='warning'
                        action={
                            <Button color='inherit' size='small' onClick={acknowledgeWarning}>
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
                        <FormControlLabel
                            value='oidc'
                            control={<Radio />}
                            disabled={!data?.methods.oidc.configured}
                            label={`Generic OIDC${data?.methods.oidc.configured ? '' : ' — not configured'}`}
                        />
                    </RadioGroup>
                    <Button variant='contained' disabled={!choice || choice === data?.activeMethod} onClick={prepare}>
                        Review change
                    </Button>
                    <Button sx={{ ml: 1 }} onClick={reauthenticate}>
                        Sign in again
                    </Button>
                    {data?.activeMethod === 'workos' && (
                        <Typography color='text.secondary' sx={{ mt: 1 }}>
                            WorkOS satisfies this check only when it proves the sign-in time. If it cannot, use a local owner password at
                            /signin?reauth=1.
                        </Typography>
                    )}
                </Paper>
                <Paper variant='outlined' sx={{ p: 2.5 }}>
                    <Stack spacing={2}>
                        <Typography variant='h4'>Generic OIDC setup</Typography>
                        <TextField
                            label='Issuer URL'
                            value={oidcForm.issuer}
                            onChange={(event) => setOidcForm((value) => ({ ...value, issuer: event.target.value }))}
                        />
                        <TextField
                            label='Client id'
                            value={oidcForm.clientId}
                            onChange={(event) => setOidcForm((value) => ({ ...value, clientId: event.target.value }))}
                        />
                        <TextField
                            label='Client secret environment variable name'
                            value={oidcForm.clientSecretEnvVar}
                            onChange={(event) => setOidcForm((value) => ({ ...value, clientSecretEnvVar: event.target.value }))}
                            helperText={
                                oidc?.draft?.clientSecretPresent ? 'Value is set on this server.' : 'Value is not set on this server.'
                            }
                        />
                        <TextField
                            label='Draft callback URL'
                            value={oidc?.callbackUrl || ''}
                            InputProps={{ readOnly: true }}
                            helperText='Save the draft, then register this exact URL before Test sign-in.'
                        />
                        <TextField
                            label='Active callback URL'
                            value={oidc?.activeCallbackUrl || ''}
                            InputProps={{ readOnly: true }}
                            helperText='Keep this exact URL registered while this provider is active.'
                        />
                        {oidc?.callbackError && <Alert severity='error'>{oidc.callbackError}</Alert>}
                        <TextField label='Post-logout URL' value={oidc?.postLogoutUrl || ''} InputProps={{ readOnly: true }} />
                        <TextField label='Scopes' value='openid email profile' InputProps={{ readOnly: true }} />
                        <FormControlLabel
                            control={
                                <Checkbox
                                    checked={oidcForm.trustMissingEmailVerification}
                                    onChange={(event) =>
                                        setOidcForm((value) => ({ ...value, trustMissingEmailVerification: event.target.checked }))
                                    }
                                />
                            }
                            label='Trust issuer email when the verification claim is missing'
                        />
                        <Alert severity='warning'>
                            This option permits first linking when the issuer omits email verification. An explicit false value is always
                            refused.
                        </Alert>
                        <TextField
                            label='Private issuer hosts'
                            value={oidcForm.privateIssuerHosts}
                            onChange={(event) => setOidcForm((value) => ({ ...value, privateIssuerHosts: event.target.value }))}
                            helperText='Comma-separated exact host names. HTTP is accepted only for an allowlisted loopback host.'
                        />
                        <Stack direction='row' spacing={1} alignItems='center'>
                            <Chip
                                label={
                                    oidc?.draft?.health === 'ready' ? 'Discovery and keys ready' : oidc?.draft?.healthError || 'Not checked'
                                }
                                color={oidc?.draft?.health === 'ready' ? 'success' : 'warning'}
                            />
                            {oidc?.draft?.checkedAt && <Typography color='text.secondary'>Last check: {oidc.draft.checkedAt}</Typography>}
                        </Stack>
                        {oidc?.draft?.testResult && (
                            <Alert severity='success'>
                                Test passed. Steps: {(oidc.draft.testResult.steps || []).join(', ')}. Returned email:{' '}
                                {oidc.draft.testResult.email || 'not returned'}. Assurance: {oidc.draft.testResult.assuranceBasis}.
                            </Alert>
                        )}
                        {oidc?.linkMigration?.inert > 0 && (
                            <Alert severity='info' data-testid='inert-workos-links'>
                                {oidc.linkMigration.inert} legacy WorkOS subject link
                                {oidc.linkMigration.inert === 1 ? '' : 's'} could not be attributed to a stable WorkOS provider identity.{' '}
                                {oidc.linkMigration.inert === 1 ? 'It remains' : 'They remain'} inert and will not match this OIDC provider.
                            </Alert>
                        )}
                        <Stack direction='row' spacing={1}>
                            <Button variant='outlined' onClick={saveOidc}>
                                Save draft
                            </Button>
                            <Button
                                variant='outlined'
                                onClick={testOidc}
                                disabled={oidc?.draft?.health !== 'ready' || Boolean(oidc?.callbackError)}
                            >
                                Test sign-in
                            </Button>
                            <Button
                                variant='contained'
                                onClick={activateOidc}
                                disabled={
                                    !oidc?.draft?.tested ||
                                    !oidc?.linkMigrationComplete ||
                                    !data?.recovery.available ||
                                    Boolean(oidc?.callbackError) ||
                                    oidcMatchesActive
                                }
                            >
                                {oidcMatchesActive ? 'Already active' : 'Activate'}
                            </Button>
                        </Stack>
                    </Stack>
                </Paper>
                <Paper variant='outlined' sx={{ p: 2.5 }}>
                    <Stack direction='row' justifyContent='space-between'>
                        <Box>
                            <Typography variant='h4'>Owner recovery</Typography>
                            <Typography color='text.secondary'>
                                WorkOS or OIDC can be activated only while the recovery route is enabled and an active owner has a usable
                                password.
                            </Typography>
                        </Box>
                        <Chip
                            label={data?.recovery.available ? 'Ready' : 'Needs owner credential'}
                            color={data?.recovery.available ? 'success' : 'warning'}
                        />
                    </Stack>
                </Paper>
                <Paper variant='outlined' sx={{ p: 2.5 }}>
                    <Typography variant='h4'>Provisioning</Typography>
                    <Typography color='text.secondary'>SCIM provisioning is not available in this release.</Typography>
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
        </MainCard>
    )
}
