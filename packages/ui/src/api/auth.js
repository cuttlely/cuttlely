import client from './client'

// auth
const resolveLogin = (body) => client.post(`/auth/resolve`, body)
const login = (body) => client.post(`/auth/login`, body)
const localLogin = (body) => client.post(`/auth/local/login`, body, { headers: { 'x-request-from': 'internal' } })
const recoveryLogin = (body) => client.post(`/auth/recovery/login`, body, { headers: { 'x-request-from': 'internal' } })

// permissions
const getAllPermissions = (type) => client.get(`/auth/permissions/${type}`)
const ssoSuccess = (token) => client.get(`/auth/sso-success?token=${token}`)
const refreshSession = () => client.post(`/auth/refreshToken`)

export default {
    resolveLogin,
    login,
    localLogin,
    recoveryLogin,
    getAllPermissions,
    ssoSuccess,
    refreshSession
}
