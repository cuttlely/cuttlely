import { useRef, useState } from 'react'
import { useError } from '@/store/context/ErrorContext'
import { isCancel, isConnectionUnavailable } from '@/api/resilience'

// currentOnly: each request starts clean and a late reply from an older request is ignored.
// localUnavailable: the caller shows its own action-specific message when a request gets no answer or a
// 502/503/504 gateway response, so that ambiguous write failure is not also reported as a reload page error.
export default (apiFunc, { currentOnly = false, localUnavailable = false } = {}) => {
    const [data, setData] = useState(null)
    const [loading, setLoading] = useState(false)
    const [error, setApiError] = useState(null)
    const latestRequestId = useRef(0)
    const { setError, handleError } = useError()

    const request = async (...args) => {
        const requestId = ++latestRequestId.current
        if (currentOnly) {
            setData(null)
            setApiError(null)
        }
        setLoading(true)
        try {
            const result = await apiFunc(...args)
            if (currentOnly && requestId !== latestRequestId.current) return
            setData(result.data)
            setError(null)
            setApiError(null)
        } catch (err) {
            if (isCancel(err)) return
            if (currentOnly && requestId !== latestRequestId.current) return
            if (!(localUnavailable && isConnectionUnavailable(err))) handleError(err || 'Unexpected Error!')
            setApiError(err || 'Unexpected Error!')
        } finally {
            if (!currentOnly || requestId === latestRequestId.current) setLoading(false)
        }
    }

    return {
        error,
        data,
        loading,
        request
    }
}
