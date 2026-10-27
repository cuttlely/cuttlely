import client from './client'

const path = (chatflowId) => `/flow-drafts/${encodeURIComponent(chatflowId)}`

const getStatus = (chatflowId) => client.get(path(chatflowId))

const saveDraft = (chatflowId, flowData, options = {}) => {
    const body = { flowData }
    if (options && Object.prototype.hasOwnProperty.call(options, 'expectedDraftHash')) {
        const hash = options.expectedDraftHash
        if (typeof hash === 'string' || hash === null) body.expectedDraftHash = hash
    }
    if (options && options.overwriteDraftChanges === true) body.overwriteDraftChanges = true
    return client.put(path(chatflowId), body)
}

const discardDraft = (chatflowId) => client.delete(path(chatflowId))

const updateSettings = (chatflowId, body) =>
    client.put(`${path(chatflowId)}/settings`, typeof body === 'boolean' ? { publishInstantly: body } : body)

const publish = (chatflowId, body = {}) => client.post(`${path(chatflowId)}/publish`, body)

const rollback = (chatflowId, sha) => client.post(`${path(chatflowId)}/rollback`, { sha })

const getCheckSetup = (chatflowId) => client.get(`${path(chatflowId)}/check`)

const getCheckHistory = (chatflowId, params) => client.get(`${path(chatflowId)}/check/history`, { params })

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
    getCheckHistory,
    startCheck,
    getCheck,
    stopCheck
}
