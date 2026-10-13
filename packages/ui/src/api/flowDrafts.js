import client from './client'

const path = (chatflowId) => `/flow-drafts/${encodeURIComponent(chatflowId)}`

const getStatus = (chatflowId) => client.get(path(chatflowId))

const saveDraft = (chatflowId, flowData) => client.put(path(chatflowId), { flowData })

const discardDraft = (chatflowId) => client.delete(path(chatflowId))

const updateSettings = (chatflowId, body) =>
    client.put(`${path(chatflowId)}/settings`, typeof body === 'boolean' ? { publishInstantly: body } : body)

const publish = (chatflowId, body = {}) => client.post(`${path(chatflowId)}/publish`, body)

const rollback = (chatflowId, sha) => client.post(`${path(chatflowId)}/rollback`, { sha })

const getCheckSetup = (chatflowId) => client.get(`${path(chatflowId)}/check`)

const startCheck = (chatflowId, questionsOrBody, includeRiskySteps = false) => {
    const body =
        questionsOrBody && typeof questionsOrBody === 'object' && !Array.isArray(questionsOrBody)
            ? questionsOrBody
            : { questions: questionsOrBody, includeRiskySteps }
    return client.post(`${path(chatflowId)}/check`, body)
}

const getCheck = (chatflowId, checkId) => client.get(`${path(chatflowId)}/check/${encodeURIComponent(checkId)}`)

const stopCheck = (chatflowId, checkId) => client.delete(`${path(chatflowId)}/check/${encodeURIComponent(checkId)}`)

export default {
    getStatus,
    saveDraft,
    discardDraft,
    updateSettings,
    publish,
    rollback,
    getCheckSetup,
    startCheck,
    getCheck,
    stopCheck
}
