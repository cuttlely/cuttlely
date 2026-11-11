import { createContext, useCallback, useContext, useRef, useState } from 'react'
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
    const location = useLocation()
    const currentVisit = useRef(location)
    currentVisit.current = location

    // The page error belongs to one route visit: the router location of the page whose request
    // failed. A callback captured on an earlier visit (for example a canvas request that fails or
    // succeeds after you left) is ignored, so it cannot replace, clear or later bring back an error,
    // even when you return to the same path.
    const setError = useCallback(
        (err) => {
            if (currentVisit.current !== location) return
            setPageError(err ? { error: err, visit: location } : null)
        },
        [location]
    )
    const error = pageError && pageError.visit === location ? pageError.error : null

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
