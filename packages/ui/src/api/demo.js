import client from './client'

// Try the demo: the key types it runs on and the demo already made here, then making it with one key.
const getDemo = () => client.get('/demo')
const createDemo = (credentialId) => client.post('/demo', { credentialId })

export default { getDemo, createDemo }
