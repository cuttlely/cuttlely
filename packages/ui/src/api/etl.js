import client from './client'

const listPipelines = () => client.get('/etl/pipelines')
const getPipeline = (id) => client.get(`/etl/pipelines/${id}`)
const getVersion = (id, version) => client.get(`/etl/pipelines/${id}/versions/${version}`)
const previewPipeline = (id, body) => client.post(`/etl/pipelines/${id}/preview`, body)
const startRun = (id, body) => client.post(`/etl/pipelines/${id}/runs`, body)
const listRuns = (id) => client.get(`/etl/pipelines/${id}/runs`)
const getRun = (runId) => client.get(`/etl/runs/${runId}`)
const pauseRun = (runId) => client.post(`/etl/runs/${runId}/pause`)
const resumeRun = (runId) => client.post(`/etl/runs/${runId}/resume`)
const cancelRun = (runId) => client.post(`/etl/runs/${runId}/cancel`)
const search = (id, body) => client.post(`/etl/pipelines/${id}/search`, body)
const listSamples = () => client.get('/etl/samples')
const importSample = (sample) => client.post(`/etl/samples/${sample}/import`)
const listSchedules = (id) => client.get(`/etl/pipelines/${id}/schedules`)
const createSchedule = (id, body) => client.post(`/etl/pipelines/${id}/schedules`, body)
const updateSchedule = (id, body) => client.patch(`/etl/schedules/${id}`, body)
const pauseSchedule = (id) => client.post(`/etl/schedules/${id}/pause`)
const resumeSchedule = (id) => client.post(`/etl/schedules/${id}/resume`)
const deleteSchedule = (id) => client.delete(`/etl/schedules/${id}`)

// The browser streams the File from disk; the server writes it under the pipeline's workspace in .cuttlely/etl/uploads.
const upload = (id, file, onUploadProgress) =>
    client.post(`/etl/pipelines/${id}/uploads`, file, {
        params: { name: file.name },
        headers: { 'Content-Type': 'application/octet-stream' },
        onUploadProgress,
        timeout: 0
    })

export default {
    listPipelines,
    getPipeline,
    getVersion,
    previewPipeline,
    startRun,
    listRuns,
    getRun,
    pauseRun,
    resumeRun,
    cancelRun,
    search,
    listSamples,
    importSample,
    upload,
    listSchedules,
    createSchedule,
    updateSchedule,
    pauseSchedule,
    resumeSchedule,
    deleteSchedule
}
