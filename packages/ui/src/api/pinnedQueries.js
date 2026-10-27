import client from './client'

const testPinnedQuery = (chatflowId, body) => client.post(`/pinned-queries/${chatflowId}/test`, body)

const suggestPinnedTypes = (chatflowId, body) => client.post(`/pinned-queries/${chatflowId}/suggest`, body)

export default {
    testPinnedQuery,
    suggestPinnedTypes
}
