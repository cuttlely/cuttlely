import { useRef, useState } from 'react'
import { useError } from '@/store/context/ErrorContext'
import { isCancel, isNoResponse } from '@/api/resilience'

// currentOnly: each request starts clean and a late reply from an older request is ignored.
// localNoAnswer: the caller shows its own message when the request gets no answer, so that failure is not
// reported as a page error (whose text asks the person to reload and would discard unsaved canvas edits).
export default (apiFunc, { currentOnly = false, localNoAnswer = false } = {}) => {
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
            if (!(localNoAnswer && isNoResponse(err))) handleError(err || 'Unexpected Error!')
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
