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
    acknowledgeWarning: (version) => client.post('/authentication-settings/acknowledge-warning', { version }),
    getOidc: () => client.get('/authentication-settings/oidc'),
    saveOidc: (value) => client.put('/authentication-settings/oidc', value),
    testOidc: () => client.post('/authentication-settings/oidc/test'),
    acknowledgeRecoveryAlert: (id) => client.post('/authentication-settings/acknowledge-recovery-alert', { id }),
    createScimToken: () => client.post('/authentication-settings/scim-token'),
    rotateScimToken: (overlapHours) => client.post('/authentication-settings/scim-token/rotate', { overlapHours }),
    endScimOverlap: () => client.post('/authentication-settings/scim-token/end-previous'),
    revokeScimToken: () => client.delete('/authentication-settings/scim-token'),
    previewScimMappingCreation: (groupId, workspaceId, roleId) =>
        client.post('/authentication-settings/scim-mappings/preview', { groupId, workspaceId, roleId: roleId || null }),
    confirmScimMappingCreation: (mapping, fingerprint) =>
        client.post('/authentication-settings/scim-mappings/confirm', {
            groupId: mapping.groupId,
            workspaceId: mapping.workspaceId,
            roleId: mapping.roleId,
            fingerprint
        }),
    previewScimMappingRemoval: (id) => client.get(`/authentication-settings/scim-mappings/${id}/remove-preview`),
    removeScimMapping: (id, fingerprint) => client.post(`/authentication-settings/scim-mappings/${id}/remove`, { fingerprint })
}
