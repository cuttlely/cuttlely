import client from './client'

const getLogs = (params) => client.get('/logs', { params })

export default {
    getLogs
}
