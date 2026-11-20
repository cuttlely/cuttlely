import client from './client'

const status = (chatflowId) => client.get(`/import-verify/${encodeURIComponent(chatflowId)}`)

const start = (chatflowId, body = {}) => client.post(`/import-verify/${encodeURIComponent(chatflowId)}`, body)

const cancel = (chatflowId) => client.post(`/import-verify/${encodeURIComponent(chatflowId)}/cancel`, {})

export default { status, start, cancel }
