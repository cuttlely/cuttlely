import client from './client'

const listHarnesses = () => client.get('/harnesses')
const getHarness = (name) => client.get(`/harnesses/${encodeURIComponent(name)}`)
const saveHarness = (body) => client.post('/harnesses', body)
const deleteHarness = (name) => client.delete(`/harnesses/${encodeURIComponent(name)}`)
const listRuns = (name) => client.get(`/harnesses/${encodeURIComponent(name)}/runs`)
const getRun = (name, runId) => client.get(`/harnesses/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}`)

export default {
    listHarnesses,
    getHarness,
    saveHarness,
    deleteHarness,
    listRuns,
    getRun
}
