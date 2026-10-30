import client from './client'

export default {
    get: () => client.get('/authentication-settings'),
    stage: (method, version) => client.post('/authentication-settings/stage', { method, version }),
    apply: (stage, confirm) => client.post('/authentication-settings/apply', { stage, confirm })
}
