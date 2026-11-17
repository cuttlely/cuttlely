import { useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import { Alert, Box, Button, MenuItem, Stack, TextField, Typography } from '@mui/material'
import serverSettingsApi from '@/api/serverSettings'

// The server supplies every capability. A nonoperator receives only the narrowly scoped proof eligibility.
export default function OperatorPanel({ onChanged }) {
    const [status, setStatus] = useState(null)
    const [action, setAction] = useState('')
    const [target, setTarget] = useState('')
    const [confirm, setConfirm] = useState('')
    const [code, setCode] = useState('')
    const [requested, setRequested] = useState(false)
    const [message, setMessage] = useState('')
    const [failed, setFailed] = useState(false)
    const [busy, setBusy] = useState(false)
    const load = () =>
        serverSettingsApi
            .getOperator()
            .then((res) => setStatus(res.data))
            .catch(() => setStatus(null))
    useEffect(() => {
        load()
    }, [])
    if (!status || !(status.operator || status.proofPurpose)) return null
    const purpose = status.proofPurpose
    const proof = !status.operator
    const word = proof ? purpose.toUpperCase() : action.toUpperCase()
    const execute = async (requestProof = false) => {
        setBusy(true)
        setMessage('')
        setFailed(false)
        try {
            const res = await serverSettingsApi.operatorAction(requestProof ? 'request' : proof ? purpose : action, {
                purpose,
                confirm,
                code,
                userId: target
            })
            setCode('')
            if (requestProof) {
                setRequested(true)
                setMessage(res.data.message)
            } else {
                setRequested(false)
                setAction('')
                setConfirm('')
                setMessage('Instance operator updated.')
                await load()
                onChanged()
            }
        } catch (error) {
            setFailed(true)
            setMessage(error?.response?.data?.message ?? 'The operator action could not be completed.')
        } finally {
            setBusy(false)
        }
    }
    return (
        <Box sx={{ my: 3 }} data-testid='operator-panel'>
            <Typography variant='h3' sx={{ mb: 1 }}>
                Instance operator
            </Typography>
            {status.reauthenticateUrl && <Button href={status.reauthenticateUrl}>Verify a fresh sign-in</Button>}
            {message && (
                <Alert severity={failed ? 'error' : 'success'} sx={{ my: 1 }}>
                    {message}
                </Alert>
            )}
            {status.operator ? (
                <>
                    <Typography>
                        Current operator: {status.operator.userId}. Source: {status.operator.source}.
                    </Typography>
                    {status.mutable ? (
                        <Stack gap={2} sx={{ mt: 2, maxWidth: 600 }}>
                            <TextField
                                select
                                label='Operator action'
                                value={action}
                                onChange={(e) => {
                                    setAction(e.target.value)
                                    setConfirm('')
                                }}
                            >
                                <MenuItem value='transfer'>Transfer to another active owner</MenuItem>
                                <MenuItem value='revoke'>Revoke browser service administration</MenuItem>
                            </TextField>
                            {action === 'transfer' && (
                                <TextField select label='New operator' value={target} onChange={(e) => setTarget(e.target.value)}>
                                    {status.owners
                                        .filter((u) => u.id !== status.operator.userId)
                                        .map((u) => (
                                            <MenuItem key={u.id} value={u.id}>
                                                {u.email}
                                            </MenuItem>
                                        ))}
                                </TextField>
                            )}
                            {action && (
                                <>
                                    <Alert severity='warning'>
                                        This changes service-wide authority immediately. Sign in again if your authentication is older than
                                        10 minutes. Revocation leaves a Disabled state. Rearming requires the separate host-proof recovery
                                        flow.
                                    </Alert>
                                    <TextField
                                        label={`Type ${word} to confirm`}
                                        value={confirm}
                                        onChange={(e) => setConfirm(e.target.value)}
                                    />
                                    <Button
                                        disabled={busy || confirm !== word || (action === 'transfer' && !target)}
                                        onClick={() => execute()}
                                    >
                                        Confirm {action}
                                    </Button>
                                </>
                            )}
                        </Stack>
                    ) : (
                        <Alert sx={{ mt: 1 }}>The host environment controls this designation. Panel changes are disabled.</Alert>
                    )}
                </>
            ) : (
                <Stack gap={2} sx={{ maxWidth: 600 }}>
                    <Typography>
                        {purpose === 'rebind'
                            ? 'Rebind your operator designation after verifying the changed database.'
                            : purpose === 'recover'
                            ? 'Recover service authority explicitly with host-log proof. This replaces the disabled or invalid authority state.'
                            : 'Explicitly claim instance operator authority for this account.'}{' '}
                        Sign in within the last 10 minutes, request a code, then read it from the host log. The code lasts 5 minutes and
                        works only in this session.
                    </Typography>
                    <Typography>
                        State: {status.state}. Unsafe files require host recovery. A new browser session requires requesting a new code
                        after the current code expires.
                    </Typography>
                    <TextField label={`Type ${word} to confirm`} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                    <Button disabled={busy || !(confirm === word)} onClick={() => execute(true)}>
                        Request host-log code
                    </Button>
                    {(requested || status.proofPending) && (
                        <>
                            <TextField
                                label='One-time host-log code'
                                type='password'
                                autoComplete='off'
                                value={code}
                                onChange={(e) => setCode(e.target.value)}
                            />
                            <Button disabled={busy || !code || confirm !== word} onClick={() => execute()}>
                                Confirm {purpose}
                            </Button>
                        </>
                    )}
                </Stack>
            )}
        </Box>
    )
}
OperatorPanel.propTypes = { onChanged: PropTypes.func.isRequired }
