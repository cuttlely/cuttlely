import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'

// material-ui
import { BackdropLoader } from '@/ui-component/loading/BackdropLoader'

// project imports
import MainCard from '@/ui-component/cards/MainCard'

// API
import authApi from '@/api/auth'

// Hooks
import useApi from '@/hooks/useApi'

import { loginRedirect, loginTarget } from './resolveLogin'

// ==============================|| ResolveLoginPage ||============================== //

const ResolveLoginPage = () => {
    const location = useLocation()
    const returnPath = location.state?.path
    const resolveLogin = useApi(authApi.resolveLogin)
    const [loading, setLoading] = useState(false)

    useEffect(() => {
        resolveLogin.request({})
        setLoading(true)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // With no sign-in method on, the server answers 404 and the Sign In page explains it, instead of an empty page.
    // A full page load drops router state, so the page they were opening is carried on /setup as next.
    useEffect(() => {
        const target = loginTarget(resolveLogin.data, resolveLogin.error)
        if (resolveLogin.data || resolveLogin.error) setLoading(false)
        if (target) window.location.href = loginRedirect(target, returnPath)
    }, [resolveLogin.data, resolveLogin.error, returnPath])

    return (
        <>
            <MainCard maxWidth='md'>{loading && <BackdropLoader open={loading} />}</MainCard>
        </>
    )
}

export default ResolveLoginPage
