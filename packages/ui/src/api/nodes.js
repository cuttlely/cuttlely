import client from './client'

const getAllNodes = () => client.get('/nodes', { params: { client: 'agentflowv2' } })

const getNodePackIndex = () => client.get('/nodes/pack-index')

const getSpecificNode = (name, config = {}) =>
    client.get(`/nodes/${name}`, { ...config, params: { client: 'agentflowv2', ...config.params } })
const getNodesByCategory = (name) => client.get(`/nodes/category/${name}`, { params: { client: 'agentflowv2' } })

const executeCustomFunctionNode = (body) => client.post(`/node-custom-function`, body)

const executeNodeLoadMethod = (name, body, config = {}) => client.post(`/node-load-method/${name}`, body, { ...config, retry: true })

export default {
    getAllNodes,
    getNodePackIndex,
    getSpecificNode,
    executeCustomFunctionNode,
    getNodesByCategory,
    executeNodeLoadMethod
}
