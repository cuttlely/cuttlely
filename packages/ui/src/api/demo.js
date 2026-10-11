import client from './client'

// Try the demo: the key types the demos run on and the demos already made here, then making one with one key.
// demo is 'customer-care' (the main demo) or 'bakery' (the quickstart).
const getDemo = () => client.get('/demo')
const createDemo = (credentialId, demo) => client.post('/demo', { credentialId, demo })

export default { getDemo, createDemo }
