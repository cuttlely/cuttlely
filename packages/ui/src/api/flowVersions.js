import client from './client'

const getStatus = () => client.get('/flow-versions/status')
const listVersions = (chatflowId) => client.get(`/flow-versions/${encodeURIComponent(chatflowId)}`)
const getVersion = (chatflowId, sha) => client.get(`/flow-versions/${encodeURIComponent(chatflowId)}/${encodeURIComponent(sha)}`)
const diffVersion = (chatflowId, sha, against = 'previous') =>
    client.get(`/flow-versions/${encodeURIComponent(chatflowId)}/${encodeURIComponent(sha)}/diff`, { params: { against } })
const restoreVersion = (chatflowId, sha) =>
    client.post(`/flow-versions/${encodeURIComponent(chatflowId)}/${encodeURIComponent(sha)}/restore`)

// Copy to GitHub and the Dev or Prod label. Server-wide, for the owner only.
const getGithub = () => client.get('/flow-versions/github')
const listGithubRepos = (body) => client.post('/flow-versions/github/repos', body)
const createGithubRepo = (body) => client.post('/flow-versions/github/repos/new', body)
const connectGithub = (body) => client.put('/flow-versions/github', body)
const disconnectGithub = () => client.delete('/flow-versions/github')
const syncGithub = () => client.post('/flow-versions/github/push')
const setEnvironment = (environment) => client.put('/flow-versions/environment', { environment })

// Promote, on a server labeled Prod: new versions from Dev. For the owner only.
const incomingPath = (chatflowId) => `/flow-versions/incoming/${encodeURIComponent(chatflowId)}`
const listIncoming = () => client.get('/flow-versions/incoming')
const getIncoming = (chatflowId) => client.get(incomingPath(chatflowId))
const promote = (chatflowId, sha) => client.post(`${incomingPath(chatflowId)}/promote`, { sha })
// The behavior check, in the shape the publish check panel uses.
const promoteCheckApi = {
    getCheckSetup: (chatflowId) => client.get(`${incomingPath(chatflowId)}/check`),
    startCheck: (chatflowId, questions, includeRiskySteps = false) =>
        client.post(`${incomingPath(chatflowId)}/check`, { questions, includeRiskySteps }),
    getCheck: (chatflowId, checkId) => client.get(`${incomingPath(chatflowId)}/check/${encodeURIComponent(checkId)}`),
    stopCheck: (chatflowId, checkId) => client.delete(`${incomingPath(chatflowId)}/check/${encodeURIComponent(checkId)}`)
}

export default {
    getGithub,
    listGithubRepos,
    createGithubRepo,
    connectGithub,
    disconnectGithub,
    syncGithub,
    setEnvironment,
    listIncoming,
    getIncoming,
    promote,
    promoteCheckApi,
    getStatus,
    listVersions,
    getVersion,
    diffVersion,
    restoreVersion
}
