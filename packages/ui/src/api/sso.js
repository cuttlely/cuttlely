import client from './client'

const ssoLogin = (providerName) => client.get(`/${providerName}/login`, { retry: false })

export default {
    ssoLogin
}
