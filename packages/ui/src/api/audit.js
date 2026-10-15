import client from './client'

const fetchLoginActivity = (body) => client.post(`/audit/login-activity`, body)

const getAudit = (params) => client.get('/audit', { params })

export default {
    fetchLoginActivity,
    getAudit
}
