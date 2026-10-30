import { useEffect, useState } from 'react'
import { Alert, Button } from '@mui/material'
import { Link } from 'react-router-dom'
import { useSelector } from 'react-redux'
import api from '@/api/authenticationSettings'

export const RECOVERY_FIX = (
    <>
        Enable <code>CUTTLELY_LOCAL_ADMIN</code>, then run <code>pnpm user --email</code> on the server to create the owner recovery
        credential. See the{' '}
        <a href='https://github.com/cuttlely/cuttlely/blob/main/docs/how-to/auth-sso.md#change-the-method'>Auth / SSO guide</a>.
    </>
)

export default function RecoveryWarningBanner() {
    const permissions = useSelector((state) => state.auth.permissions)
    const isGlobal = useSelector((state) => state.auth.isGlobal)
    const allowed = isGlobal || permissions?.includes('authentication:manage')
    const [needed, setNeeded] = useState(false)

    useEffect(() => {
        if (!allowed) return
        api.get()
            .then(({ data }) => setNeeded(!data?.recovery?.available))
            .catch(() => {})
    }, [allowed])

    if (!allowed || !needed) return null
    return (
        <Alert
            severity='error'
            action={
                <Button color='inherit' component={Link} to='/authentication-settings'>
                    Open Auth / SSO
                </Button>
            }
            sx={{ mb: 2 }}
            data-testid='owner-recovery-warning'
        >
            Owner recovery is not ready. {RECOVERY_FIX}
        </Alert>
    )
}
