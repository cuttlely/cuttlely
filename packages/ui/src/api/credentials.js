import client from './client'

const getAllCredentials = (config) => client.get('/credentials', config)

const getCredentialsByName = (componentCredentialName, config) =>
    client.get(`/credentials?credentialName=${componentCredentialName}`, config)

const getAllComponentsCredentials = () => client.get('/components-credentials')

const getSpecificCredential = (id) => client.get(`/credentials/${id}`)

const getSpecificComponentCredential = (name, config) => client.get(`/components-credentials/${name}`, config)

const createCredential = (body) => client.post(`/credentials`, body)

const updateCredential = (id, body) => client.put(`/credentials/${id}`, body)

const deleteCredential = (id) => client.delete(`/credentials/${id}`)

export default {
    getAllCredentials,
    getCredentialsByName,
    getAllComponentsCredentials,
    getSpecificCredential,
    getSpecificComponentCredential,
    createCredential,
    updateCredential,
    deleteCredential
}
