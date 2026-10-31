import { useEffect, useState } from 'react'
import { Alert, Button } from '@mui/material'
import { Link } from 'react-router-dom'
import { useSelector } from 'react-redux'
import api from '@/api/authenticationSettings'

export const RECOVERY_FIX = (
    <>
        Run <code>pnpm user --email owner@example.com</code> on the server to create a usable local password for an active owner. See the{' '}
        <a href='https://github.com/cuttlely/cuttlely/blob/main/docs/how-to/auth-sso.md#change-the-method'>Auth / SSO guide</a>.
    </>
)

export default function RecoveryWarningBanner() {
    const permissions = useSelector((state) => state.auth.permissions)
    const isGlobal = useSelector((state) => state.auth.isGlobal)
    const allowed = isGlobal || permissions?.includes('authentication:manage')
    const [state, setState] = useState({ needed: false, alert: null })

    useEffect(() => {
        if (!allowed) return
        const load = () =>
            api
                .get()
                .then(({ data }) => setState({ needed: !data?.recovery?.available, alert: data?.recovery?.alert || null }))
                .catch(() => {})
        void load()
        window.addEventListener('cuttlely:recovery-alert-acknowledged', load)
        return () => window.removeEventListener('cuttlely:recovery-alert-acknowledged', load)
    }, [allowed])

    if (!allowed || (!state.needed && !state.alert)) return null
    return (
        <Alert
            severity={state.alert ? 'warning' : 'error'}
            action={
                <Button color='inherit' component={Link} to='/authentication-settings'>
                    Open Auth / SSO
                </Button>
            }
            sx={{ mb: 2 }}
            data-testid={state.alert ? 'owner-recovery-alert' : 'owner-recovery-warning'}
        >
            {state.alert ? (
                <>
                    An owner recovery sign-in occurred at {new Date(state.alert.occurredAt).toLocaleString()}. Acknowledge it on Auth / SSO.
                </>
            ) : (
                <>Owner recovery is not ready. {RECOVERY_FIX}</>
            )}
        </Alert>
    )
}
