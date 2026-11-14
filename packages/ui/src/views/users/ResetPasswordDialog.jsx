import { useEffect, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material'

export default function ResetPasswordDialog({ userId, userEmail, createLink, onClose }) {
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [result, setResult] = useState(null)
    const [copied, setCopied] = useState(false)
    const [copyError, setCopyError] = useState('')
    const pending = useRef(false)
    const mounted = useRef(true)

    useEffect(() => {
        mounted.current = true
        return () => {
            mounted.current = false
        }
    }, [])

    const generate = async () => {
        if (pending.current || result) return
        pending.current = true
        setBusy(true)
        setError('')
        try {
            const response = await createLink(userId)
            if (!response.data?.link) throw new Error('No reset link was returned. Refresh the user list and try again.')
            if (mounted.current) setResult(response.data)
        } catch (error) {
            if (mounted.current) {
                setError(
                    error.response?.data?.message || 'Could not confirm a reset link. You can try again; a new link replaces the old one.'
                )
            }
        } finally {
            pending.current = false
            if (mounted.current) setBusy(false)
        }
    }

    const copy = async () => {
        setCopyError('')
        try {
            await navigator.clipboard.writeText(result.link)
            if (mounted.current) setCopied(true)
        } catch {
            if (mounted.current) setCopyError('Copy is unavailable. Select the link below and copy it manually.')
        }
    }

    return (
        <Dialog open fullWidth maxWidth='sm' onClose={busy ? undefined : onClose} aria-labelledby='reset-password-title'>
            <DialogTitle id='reset-password-title'>Reset password</DialogTitle>
            <DialogContent>
                <Stack spacing={2} sx={{ pt: 1 }}>
                    <Typography>Reset the local password for {userEmail}.</Typography>
                    {!result ? (
                        <>
                            <Typography variant='body2'>
                                Generate a one-time link so this person can choose a new password. Their existing sessions end when they
                                save it. A new link replaces any previous reset link for this team.
                            </Typography>
                            <Typography variant='body2'>
                                If email delivery is configured, the link is also emailed to them. Accounts using SSO must recover their
                                password with their sign-in provider.
                            </Typography>
                        </>
                    ) : (
                        <>
                            <Alert severity={result.mailed ? 'success' : 'info'}>
                                {result.mailed
                                    ? 'Reset link emailed. You can also copy it below.'
                                    : 'Send this reset link privately to the person. It has not been emailed.'}
                            </Alert>
                            <Typography variant='body2'>
                                This link is shown only here and expires according to server settings. Treat it like a password.
                            </Typography>
                            {copyError && <Alert severity='warning'>{copyError}</Alert>}
                            <TextField
                                label='One-time reset link'
                                value={result.link}
                                multiline
                                fullWidth
                                InputProps={{ readOnly: true }}
                                onFocus={(event) => event.target.select()}
                            />
                        </>
                    )}
                    {error && <Alert severity='error'>{error}</Alert>}
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button disabled={busy} onClick={onClose}>
                    {result ? 'Done' : 'Cancel'}
                </Button>
                {result ? (
                    <Button onClick={copy}>{copied ? 'Copied' : 'Copy link'}</Button>
                ) : (
                    <Button variant='contained' disabled={busy} onClick={generate}>
                        {busy ? 'Generating…' : 'Generate reset link'}
                    </Button>
                )}
            </DialogActions>
        </Dialog>
    )
}

ResetPasswordDialog.propTypes = {
    userId: PropTypes.string.isRequired,
    userEmail: PropTypes.string.isRequired,
    createLink: PropTypes.func.isRequired,
    onClose: PropTypes.func.isRequired
}
