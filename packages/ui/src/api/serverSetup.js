import axios from 'axios'
import { baseURL } from '@/store/constant'

// The one-time setup link (no account exists yet). Its own client: there is no signed-in user to refresh or forget.
const client = axios.create({
    baseURL: `${baseURL}/api/v1/server-setup`,
    headers: { 'Content-type': 'application/json', 'x-request-from': 'internal' },
    withCredentials: true
})

const open = (code) => client.post('/open', { code })
const getState = () => client.get('/state')
const createOwner = (owner) => client.post('/owner', owner)
// The same calls as Set up AuthKit in Server settings, so the wizard works unchanged.
const checkAuthKit = (values) => client.post('/authkit/check', { values })
const startAuthKitTest = (values) => client.post('/authkit/test', { values })
const authKitTestStatus = () => client.get('/authkit/test')
const applyAuthKitTest = () => client.post('/authkit/apply', {})

export default { open, getState, createOwner, checkAuthKit, startAuthKitTest, authKitTestStatus, applyAuthKitTest }
