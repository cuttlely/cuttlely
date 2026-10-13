import client from './client'

const getUsage = (params) => client.get('/stats/usage', { params })

const getModelPrices = () => client.get('/model-prices')

const setModelPrice = (body) => client.put('/model-prices', body)

const clearModelPrice = (model) => client.delete('/model-prices', { data: { model } })

export default {
    getUsage,
    getModelPrices,
    setModelPrice,
    clearModelPrice
}
