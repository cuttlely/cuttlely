import axios from 'axios'
import { baseURL, ErrorMessage } from '@/store/constant'
import AuthUtils from '@/utils/authUtils'
import {
    abortableSleep,
    backoffDelay,
    cloneResponse,
    dedupeKey,
    inFlightRequests,
    isCancel,
    isNoResponse,
    isRetryableStatus,
    shouldRetry
} from './resilience'
import { beginReconnect, endReconnect } from './connectionState'

const apiClient = axios.create({
    baseURL: `${baseURL}/api/v1`,
    headers: {
        'Content-type': 'application/json',
        'x-request-from': 'internal'
    },
    withCredentials: true
})

let refreshPromise = null
let retrySleep = abortableSleep
let retryTrackingSequence = 0
const activeRetryTrackingIds = new Set()

export const setRetrySleep = (sleep) => {
    retrySleep = sleep || abortableSleep
}

const startRetryTracking = (config) => {
    if (!config._reconnectTrackingId) {
        retryTrackingSequence += 1
        config._reconnectTrackingId = `request-${retryTrackingSequence}`
    }
    if (activeRetryTrackingIds.has(config._reconnectTrackingId)) return
    activeRetryTrackingIds.add(config._reconnectTrackingId)
    beginReconnect()
}

const finishRetryTracking = (config) => {
    if (!config?._reconnectTrackingId || !activeRetryTrackingIds.delete(config._reconnectTrackingId)) return
    endReconnect()
}

const waitForRetry = async (config) => {
    startRetryTracking(config)
    config._retryCount = (config._retryCount || 0) + 1
    await retrySleep(backoffDelay(config._retryCount), config.signal)
}

const refreshSession = async () => {
    let tracked = false
    try {
        for (let attempt = 0; attempt <= 3; attempt += 1) {
            try {
                return await axios.post(`${baseURL}/api/v1/auth/refreshToken`, {}, { withCredentials: true, retry: false })
            } catch (error) {
                if (isCancel(error) || (!isNoResponse(error) && !isRetryableStatus(error)) || attempt >= 3) throw error
                if (!tracked) {
                    tracked = true
                    beginReconnect()
                }
                await retrySleep(backoffDelay(attempt + 1))
            }
        }
    } finally {
        if (tracked) endReconnect()
    }
}

const logout = () => {
    localStorage.removeItem('username')
    localStorage.removeItem('password')
    AuthUtils.removeCurrentUser()
}

export const onResponseError = async (error) => {
    const config = error?.config

    if (config && shouldRetry(config, error)) {
        if (!config._firstRetryError) config._firstRetryError = error
        try {
            await waitForRetry(config)
            return await apiClient.request(config)
        } catch (retryError) {
            finishRetryTracking(config)
            return Promise.reject(retryError)
        }
    }

    if (error?.response?.status === 401) {
        const expired = error.response.data?.message === ErrorMessage.TOKEN_EXPIRED && error.response.data?.retry === true
        if (expired && config && !config._authRetried) {
            config._authRetried = true
            if (!refreshPromise) refreshPromise = refreshSession().finally(() => (refreshPromise = null))
            let response
            try {
                response = await refreshPromise
            } catch (refreshError) {
                finishRetryTracking(config)
                if (isNoResponse(refreshError) || isRetryableStatus(refreshError) || isCancel(refreshError)) {
                    return Promise.reject(refreshError)
                }
                logout()
                return Promise.reject(refreshError)
            }
            if (response?.data?.id) return apiClient.request(config)
            logout()
        } else {
            logout()
        }
    }

    finishRetryTracking(config)
    const exhaustedRetry = config?._firstRetryError && (isNoResponse(error) || isRetryableStatus(error))
    return Promise.reject(exhaustedRetry ? config._firstRetryError : error)
}

apiClient.interceptors.response.use((response) => {
    finishRetryTracking(response.config)
    return response
}, onResponseError)

const axiosRequest = apiClient.request.bind(apiClient)
apiClient.request = (configOrUrl, config = {}) => {
    const requestConfig =
        typeof configOrUrl === 'string'
            ? { ...config, url: configOrUrl, baseURL: config.baseURL || apiClient.defaults.baseURL }
            : { ...(configOrUrl || {}), baseURL: configOrUrl?.baseURL || apiClient.defaults.baseURL }
    const key = dedupeKey(requestConfig)
    if (!key) return axiosRequest(requestConfig)

    const pending = inFlightRequests.get(key)
    if (pending) return pending.then(cloneResponse)

    const request = axiosRequest(requestConfig)
    inFlightRequests.set(key, request)
    return request.then(cloneResponse).finally(() => {
        if (inFlightRequests.get(key) === request) inFlightRequests.delete(key)
    })
}

for (const method of ['get', 'delete', 'head', 'options']) {
    apiClient[method] = (url, config = {}) => apiClient.request({ ...config, method, url })
}
for (const method of ['post', 'put', 'patch']) {
    apiClient[method] = (url, data, config = {}) => apiClient.request({ ...config, method, url, data })
}

export const resetClientState = () => {
    refreshPromise = null
    retrySleep = abortableSleep
    inFlightRequests.clear()
    for (const _id of activeRetryTrackingIds) endReconnect()
    activeRetryTrackingIds.clear()
    retryTrackingSequence = 0
}

export default apiClient
