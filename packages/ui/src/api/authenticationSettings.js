import client from './client'

export default {
    get: () => client.get('/authentication-settings'),
    stage: (method, version) => client.post('/authentication-settings/stage', { method, version }),
    apply: (staged, confirm) =>
        client.post('/authentication-settings/apply', {
            stage: staged.stage,
            stageVersion: staged.stageVersion,
            method: staged.method,
            stateVersion: staged.stateVersion,
            confirm
        }),
    acknowledgeWarning: (version) => client.post('/authentication-settings/acknowledge-warning', { version })
}
