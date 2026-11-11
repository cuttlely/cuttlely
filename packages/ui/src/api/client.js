import axios from 'axios'
import { baseURL, ErrorMessage } from '@/store/constant'
import AuthUtils from '@/utils/authUtils'

const apiClient = axios.create({
    baseURL: `${baseURL}/api/v1`,
    headers: {
        'Content-type': 'application/json',
        'x-request-from': 'internal'
    },
    withCredentials: true
})

// A request that got no answer (network drop, timeout, proxy or CORS failure) has no response.
// It is rejected as it is, so callers see the real error instead of a TypeError from this handler.
export const onResponseError = async (error) => {
    if (error?.response?.status === 401) {
        // check if refresh is needed
        if (error.response.data?.message === ErrorMessage.TOKEN_EXPIRED && error.response.data?.retry === true) {
            const originalRequest = error.config
            // call api to get new token
            const response = await axios.post(`${baseURL}/api/v1/auth/refreshToken`, {}, { withCredentials: true })
            if (response.data.id) {
                // retry the original request
                return apiClient.request(originalRequest)
            }
        }
        localStorage.removeItem('username')
        localStorage.removeItem('password')
        AuthUtils.removeCurrentUser()
    }

    return Promise.reject(error)
}

apiClient.interceptors.response.use((response) => response, onResponseError)

export default apiClient
