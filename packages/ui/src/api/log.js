import client from './client'

const getLogs = (startDate, endDate, level) => client.get('/logs', { params: { startDate, endDate, level } })

export default {
    getLogs
}
