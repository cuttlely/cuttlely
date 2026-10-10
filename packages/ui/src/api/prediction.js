import client from './client'

const sendMessageAndGetPrediction = (id, input) => client.post(`/internal-prediction/${id}`, input)
const sendMessageWithFiles = (id, formData) =>
    client.post(`/internal-prediction/${id}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
    })
const sendMessageAndStreamPrediction = (id, input) => client.post(`/internal-prediction/stream/${id}`, input)
const sendMessageAndGetPredictionPublic = (id, input) => client.post(`/prediction/${id}`, input)

export default {
    sendMessageAndGetPrediction,
    sendMessageWithFiles,
    sendMessageAndStreamPrediction,
    sendMessageAndGetPredictionPublic
}
