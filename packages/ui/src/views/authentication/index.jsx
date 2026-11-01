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
    MenuItem,
    Select,
    Stack,
    TextField,
    Typography
} from '@mui/material'
import MainCard from '@/ui-component/cards/MainCard'
import api from '@/api/authenticationSettings'
import { RECOVERY_FIX } from './RecoveryWarningBanner'

const label = (method) =>
    method === 'workos' ? 'WorkOS' : method === 'local' ? 'Local login' : method === 'oidc' ? 'Generic OIDC' : 'No ordinary method'
export const reauthenticationTarget = (method) =>
    method === 'workos' ? '/owner-recovery' : method === 'oidc' ? '/api/v1/auth/oidc/reauthenticate' : '/signin?reauth=1'

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
    const [oidc, setOidc] = useState(null)
    const [oidcForm, setOidcForm] = useState({
        issuer: '',
        clientId: '',
        clientSecretEnvVar: 'CUTTLELY_OIDC_CLIENT_SECRET',
        trustMissingEmailVerification: false,
        privateIssuerHosts: ''
    })
    const [warningConfirmationOpen, setWarningConfirmationOpen] = useState(false)
    const [scimClear, setScimClear] = useState('')
    const [overlapHours, setOverlapHours] = useState(1)
    const [mappingGroup, setMappingGroup] = useState('')
    const [mappingWorkspace, setMappingWorkspace] = useState('')
    const [mappingRole, setMappingRole] = useState('')
    const [mappingCreation, setMappingCreation] = useState(null)
    const [mappingRemoval, setMappingRemoval] = useState(null)
    const load = () =>
        api
            .get()
            .then(({ data: value }) => {
                setData(value)
                setChoice(value.activeMethod || '')
            })
            .catch(() => setError('Authentication settings could not be loaded.'))
    const loadOidc = () =>
        api
            .getOidc()
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
    useEffect(() => {
        load()
        loadOidc()
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
            const result = (await api.apply(stage, stage?.sessionsWillEnd ? confirm : 'APPLY SETTINGS')).data
            if (result.redirectTo) {
                window.location.assign(result.redirectTo)
                return
            }
            setStage(null)
            setConfirm('')
            await Promise.all([load(), loadOidc()])
        } catch (cause) {
            setError(cause?.response?.data?.message || 'The sign-in method was not changed.')
            setStage(null)
        }
    }
    const reauthenticate = () => {
        window.location.assign(reauthenticationTarget(data?.activeMethod))
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
                activeCallbackUrl: result.data.activeCallbackUrl,
                testedDraftDiffersFromActive: result.data.testedDraftDiffersFromActive
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
    const previewMappingCreation = async () => {
        setError('')
        try {
            setMappingCreation((await api.previewScimMappingCreation(mappingGroup, mappingWorkspace, mappingRole)).data)
        } catch (cause) {
            setError(cause?.response?.data?.message || 'The SCIM mapping could not be previewed.')
        }
    }
    const confirmMappingCreation = async () => {
        try {
            await api.confirmScimMappingCreation(mappingCreation.mapping, mappingCreation.fingerprint)
            setMappingCreation(null)
            setMappingGroup('')
            setMappingWorkspace('')
            setMappingRole('')
            await load()
        } catch (cause) {
            setMappingCreation(null)
            setError(cause?.response?.data?.message || 'The mapping changed. Preview it again.')
        }
    }
    const previewMappingRemoval = async (id) => {
        setError('')
        try {
            setMappingRemoval((await api.previewScimMappingRemoval(id)).data)
        } catch (cause) {
            setError(cause?.response?.data?.message || 'The mapping removal could not be previewed.')
        }
    }
    const confirmMappingRemoval = async () => {
        try {
            await api.removeScimMapping(mappingRemoval.mapping.id, mappingRemoval.fingerprint)
            setMappingRemoval(null)
            await load()
        } catch (cause) {
            setMappingRemoval(null)
            setError(cause?.response?.data?.message || 'The mapping changed. Preview its removal again.')
        }
    }
    const scimBaseUrl = data?.scim?.basePath ? `${window.location.origin}${data.scim.basePath}` : ''
    const workosBlockedByRecovery = Boolean(data?.methods.workos.configured && !data?.recovery.available)
    const oidcMatchesActive = Boolean(
        data?.activeMethod === 'oidc' && oidc?.draft?.fingerprint && oidc.draft.fingerprint === oidc?.active?.fingerprint
    )
    const oidcRefreshAvailable = Boolean(oidcMatchesActive && oidc?.testedDraftDiffersFromActive)
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
                            disabled={!data?.methods.local.selectable}
                            label={`Local login${
                                !data?.methods.local.configured
                                    ? ' — not configured'
                                    : data?.methods.local.scope === 'owner-only'
                                    ? ' — owner only'
                                    : data?.methods.local.scope === 'local-users'
                                    ? ' — local users'
                                    : ''
                            }`}
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
                        {data?.activeMethod === 'workos' ? 'Use Owner recovery' : 'Sign in again'}
                    </Button>
                    {data?.activeMethod === 'workos' && (
                        <Typography color='text.secondary' sx={{ mt: 1 }}>
                            A WorkOS sign-in never counts as recent authentication. Use <strong>Owner recovery</strong> to continue.
                        </Typography>
                    )}
                    {data?.activeMethod === 'local' && (
                        <Typography color='text.secondary' sx={{ mt: 1 }}>
                            Sign in with the local password again, or use <strong>Owner recovery</strong>.
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
                        {oidc?.draft?.testResult?.passed === false && (
                            <Alert severity='error'>Test failed. {oidc.draft.testResult.reason || 'This identity cannot sign in.'}</Alert>
                        )}
                        {oidc?.draft?.tested && oidc?.draft?.testResult && (
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
                            {oidcRefreshAvailable ? (
                                <Button
                                    variant='contained'
                                    onClick={activateOidc}
                                    disabled={!oidc?.linkMigrationComplete || !data?.recovery.available || Boolean(oidc?.callbackError)}
                                >
                                    Apply refreshed provider settings
                                </Button>
                            ) : (
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
                            )}
                        </Stack>
                    </Stack>
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
                        <Box data-testid='scim-operations-view'>
                            <Typography variant='h5'>Operations</Typography>
                            <Typography color='text.secondary'>
                                Last successful request:{' '}
                                {data?.scim?.operations?.lastSuccessfulRequestAt
                                    ? new Date(data.scim.operations.lastSuccessfulRequestAt).toLocaleString()
                                    : 'None'}
                            </Typography>
                            <Typography color='text.secondary'>
                                Last completed request:{' '}
                                {data?.scim?.operations?.lastCompletedRequestAt
                                    ? new Date(data.scim.operations.lastCompletedRequestAt).toLocaleString()
                                    : 'None'}
                            </Typography>
                            <Typography color='text.secondary'>
                                Last failed request:{' '}
                                {data?.scim?.operations?.lastFailedRequestAt
                                    ? new Date(data.scim.operations.lastFailedRequestAt).toLocaleString()
                                    : 'None'}
                                ; category: {data?.scim?.operations?.lastFailedRequestCategory || 'None'}
                            </Typography>
                            <Typography color='text.secondary'>
                                Users created {data?.scim?.operations?.counts?.usersCreated || 0}; updated{' '}
                                {data?.scim?.operations?.counts?.usersUpdated || 0}; disabled{' '}
                                {data?.scim?.operations?.counts?.usersDisabled || 0}; group operations{' '}
                                {data?.scim?.operations?.counts?.groupOperations || 0}; membership operations{' '}
                                {data?.scim?.operations?.counts?.membershipOperations || 0}
                            </Typography>
                            {(data?.scim?.operations?.recentErrors || []).map((item) => (
                                <Alert severity='warning' key={`${item.correlationId}-${item.completedAt}`} sx={{ mt: 1 }}>
                                    {item.category}: {item.detail} Correlation ID: {item.correlationId}
                                </Alert>
                            ))}
                            <Typography color='text.secondary'>Diagnostics are retained for 30 days.</Typography>
                        </Box>
                        <Box data-testid='scim-mappings-view'>
                            <Typography variant='h5' gutterBottom>
                                Group mappings
                            </Typography>
                            <Typography color='text.secondary'>
                                A mapping owns only team assignments it creates. Existing manual memberships remain manual.
                            </Typography>
                            {(data?.scim?.mapping?.mappings || []).map((mapping) => (
                                <Stack key={mapping.id} direction='row' alignItems='center' justifyContent='space-between' sx={{ mt: 1 }}>
                                    <Typography>
                                        {mapping.groupName} → {mapping.workspaceName}
                                        {mapping.roleName ? ` (${mapping.roleName})` : ''} · {mapping.ownedAssignments} owned
                                    </Typography>
                                    <Button color='error' onClick={() => previewMappingRemoval(mapping.id)}>
                                        Remove
                                    </Button>
                                </Stack>
                            ))}
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 2 }}>
                                <Select
                                    size='small'
                                    displayEmpty
                                    aria-label='SCIM group'
                                    value={mappingGroup}
                                    onChange={(event) => setMappingGroup(event.target.value)}
                                >
                                    <MenuItem value=''>Choose group</MenuItem>
                                    {(data?.scim?.mapping?.groups || []).map((group) => (
                                        <MenuItem key={group.id} value={group.id}>
                                            {group.displayName}
                                        </MenuItem>
                                    ))}
                                </Select>
                                <Select
                                    size='small'
                                    displayEmpty
                                    aria-label='Mapped team'
                                    value={mappingWorkspace}
                                    onChange={(event) => setMappingWorkspace(event.target.value)}
                                >
                                    <MenuItem value=''>Choose team</MenuItem>
                                    {(data?.scim?.mapping?.workspaces || []).map((workspace) => (
                                        <MenuItem key={workspace.id} value={workspace.id}>
                                            {workspace.name}
                                        </MenuItem>
                                    ))}
                                </Select>
                                <Select
                                    size='small'
                                    displayEmpty
                                    aria-label='Mapped role'
                                    value={mappingRole}
                                    onChange={(event) => setMappingRole(event.target.value)}
                                >
                                    <MenuItem value=''>Team membership only</MenuItem>
                                    {(data?.scim?.mapping?.roles || []).map((role) => (
                                        <MenuItem key={role.id} value={role.id}>
                                            {role.name}
                                        </MenuItem>
                                    ))}
                                </Select>
                                <Button variant='contained' disabled={!mappingGroup || !mappingWorkspace} onClick={previewMappingCreation}>
                                    Create mapping
                                </Button>
                            </Stack>
                        </Box>
                    </Stack>
                </Paper>
            </Stack>
            <Dialog open={Boolean(stage)} onClose={() => setStage(null)}>
                <DialogTitle>{stage?.sessionsWillEnd ? 'End all interactive sessions?' : 'Apply refreshed provider settings?'}</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} sx={{ mt: 1 }}>
                        {stage?.sessionsWillEnd ? (
                            <>
                                <Alert severity='warning'>Everyone, including you, must sign in again. API keys remain enabled.</Alert>
                                <TextField label='Type END SESSIONS' value={confirm} onChange={(event) => setConfirm(event.target.value)} />
                            </>
                        ) : (
                            <Alert severity='info'>
                                New sign-ins will use the refreshed provider settings. Existing sessions stay signed in.
                            </Alert>
                        )}
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setStage(null)}>Cancel</Button>
                    <Button
                        color={stage?.sessionsWillEnd ? 'error' : 'primary'}
                        variant='contained'
                        disabled={Boolean(stage?.sessionsWillEnd) && confirm !== 'END SESSIONS'}
                        onClick={apply}
                    >
                        {stage?.sessionsWillEnd ? 'Change method' : 'Apply settings'}
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
            <Dialog open={Boolean(mappingCreation)} onClose={() => setMappingCreation(null)}>
                <DialogTitle>Create group mapping?</DialogTitle>
                <DialogContent>
                    <Typography>
                        {mappingCreation?.mapping?.groupName} → {mappingCreation?.mapping?.workspaceName} (
                        {mappingCreation?.mapping?.roleName})
                    </Typography>
                    <Typography sx={{ mt: 1 }}>Assignments to add:</Typography>
                    {(mappingCreation?.assignments || []).map((assignment) => (
                        <Typography key={`${assignment.userId}-${assignment.workspaceId}`}>
                            {assignment.userName} · {assignment.workspaceName} · {assignment.roleName}
                        </Typography>
                    ))}
                    {!mappingCreation?.assignments?.length && <Typography>No assignments will be added.</Typography>}
                    {(mappingCreation?.manualMemberships || []).length > 0 && (
                        <Typography sx={{ mt: 1 }}>
                            {mappingCreation.manualMemberships.length} existing manual membership(s) will stay unchanged.
                        </Typography>
                    )}
                    {(mappingCreation?.conflicts || []).length > 0 && (
                        <Alert severity='warning' sx={{ mt: 1 }}>
                            {mappingCreation.conflicts.length} conflicting assignment(s) will receive no mapped role. Any mapping-owned role
                            for those people will be removed.
                        </Alert>
                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setMappingCreation(null)}>Cancel</Button>
                    <Button color='primary' variant='contained' onClick={confirmMappingCreation}>
                        Confirm creation
                    </Button>
                </DialogActions>
            </Dialog>
            <Dialog open={Boolean(mappingRemoval)} onClose={() => setMappingRemoval(null)}>
                <DialogTitle>Remove group mapping?</DialogTitle>
                <DialogContent>
                    <Typography>This removes exactly these mapping-owned assignments:</Typography>
                    {(mappingRemoval?.assignments || []).map((assignment) => (
                        <Typography key={`${assignment.userId}-${assignment.workspaceId}`}>
                            {assignment.userName} · {assignment.workspaceName} · {assignment.roleName}
                        </Typography>
                    ))}
                    {!mappingRemoval?.assignments?.length && <Typography>No owned assignments will be removed.</Typography>}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setMappingRemoval(null)}>Cancel</Button>
                    <Button color='error' variant='contained' onClick={confirmMappingRemoval}>
                        Confirm removal
                    </Button>
                </DialogActions>
            </Dialog>
        </MainCard>
    )
}
