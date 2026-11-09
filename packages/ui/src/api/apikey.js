import client from './client'

const getAllAPIKeys = (params) => client.get('/apikey', { params })

const createNewAPI = (body) => client.post(`/apikey`, body)

const updateAPI = (id, body) => client.put(`/apikey/${id}`, body)

const deleteAPI = (id) => client.delete(`/apikey/${id}`)

export default {
    validate: (body) => client.post('/apikey/validate', body),
    options: () => client.get('/apikey/options'),
    rotate: (id, graceSeconds) => client.post(`/apikey/${id}/rotate`, { graceSeconds }),
    revokeCredential: (id, credentialId) => client.post(`/apikey/${id}/credentials/${credentialId}/revoke`),
    getAllAPIKeys,
    createNewAPI,
    updateAPI,
    deleteAPI
}
