import client from './client'

const listHarnesses = () => client.get('/harnesses')
const getHarness = (name) => client.get(`/harnesses/${encodeURIComponent(name)}`)
const saveHarness = (body) => client.post('/harnesses', body)
const updateHarnessCategory = (name, category) => client.put(`/harnesses/${encodeURIComponent(name)}/category`, { category })
const deleteHarness = (name) => client.delete(`/harnesses/${encodeURIComponent(name)}`)
const listRuns = (name) => client.get(`/harnesses/${encodeURIComponent(name)}/runs`)
const getRun = (name, runId) => client.get(`/harnesses/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}`)
const getSchedule = (name) => client.get(`/harnesses/${encodeURIComponent(name)}/schedule`)
const saveSchedule = (name, body) => client.put(`/harnesses/${encodeURIComponent(name)}/schedule`, body)
const pauseSchedule = (name) => client.post(`/harnesses/${encodeURIComponent(name)}/schedule/pause`)
const resumeSchedule = (name) => client.post(`/harnesses/${encodeURIComponent(name)}/schedule/resume`)
const deleteSchedule = (name) => client.delete(`/harnesses/${encodeURIComponent(name)}/schedule`)

export default {
    updateHarnessCategory,
    listHarnesses,
    getHarness,
    saveHarness,
    deleteHarness,
    listRuns,
    getRun,
    getSchedule,
    saveSchedule,
    pauseSchedule,
    resumeSchedule,
    deleteSchedule
}
