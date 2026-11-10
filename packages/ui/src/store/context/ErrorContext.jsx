import { createContext, useCallback, useContext, useState } from 'react'
import { redirectWhenUnauthorized } from '@/utils/genericHelper'
import PropTypes from 'prop-types'
import { useLocation, useNavigate } from 'react-router-dom'
import { store } from '@/store'
import { logoutSuccess } from '@/store/reducers/authSlice'
import { ErrorMessage } from '../constant'

const ErrorContext = createContext()

export const ErrorProvider = ({ children }) => {
    const [pageError, setPageError] = useState(null)
    const [authRateLimitError, setAuthRateLimitError] = useState(null)
    const navigate = useNavigate()
    const { pathname } = useLocation()

    // A page error belongs to the page whose request failed. A request from the canvas that fails
    // after you leave it must not replace the next page with an error card.
    // Clearing from another page leaves this page's error alone.
    const setError = useCallback(
        (err) => setPageError((current) => (err ? { error: err, pathname } : current && current.pathname !== pathname ? current : null)),
        [pathname]
    )
    const error = pageError && pageError.pathname === pathname ? pageError.error : null

    const handleError = async (err) => {
        console.error(err)
        if (err?.response?.status === 429 && err?.response?.data?.type === 'authentication_rate_limit') {
            setAuthRateLimitError("You're making a lot of requests. Please wait and try again later.")
        } else if (err?.response?.status === 429 && err?.response?.data?.type !== 'authentication_rate_limit') {
            const retryAfterHeader = err?.response?.headers?.['retry-after']
            let retryAfter = 60 // Default in seconds
            if (retryAfterHeader) {
                const parsedSeconds = parseInt(retryAfterHeader, 10)
                if (Number.isNaN(parsedSeconds)) {
                    const retryDate = new Date(retryAfterHeader)
                    if (!Number.isNaN(retryDate.getTime())) {
                        retryAfter = Math.max(0, Math.ceil((retryDate.getTime() - Date.now()) / 1000))
                    }
                } else {
                    retryAfter = parsedSeconds
                }
            }
            navigate('/rate-limited', { state: { retryAfter, message: err?.response?.data?.message } })
        } else if (err?.response?.status === 403) {
            navigate('/unauthorized', { state: { message: err?.response?.data?.message } })
        } else if (err?.response?.status === 401) {
            if (ErrorMessage.INVALID_MISSING_TOKEN === err?.response?.data?.message) {
                store.dispatch(logoutSuccess())
                navigate('/login')
            } else {
                const isRedirect = err?.response?.data?.redirectTo && err?.response?.data?.error

                if (isRedirect) {
                    redirectWhenUnauthorized({
                        error: err.response.data.error,
                        redirectTo: err.response.data.redirectTo
                    })
                } else {
                    const currentPath = window.location.pathname
                    if (currentPath !== '/signin' && currentPath !== '/login') {
                        store.dispatch(logoutSuccess())
                        navigate('/login')
                    }
                }
            }
        } else setError(err)
    }

    return (
        <ErrorContext.Provider
            value={{
                error,
                setError,
                handleError,
                authRateLimitError,
                setAuthRateLimitError
            }}
        >
            {children}
        </ErrorContext.Provider>
    )
}

export const useError = () => useContext(ErrorContext)

ErrorProvider.propTypes = {
    children: PropTypes.any
}
