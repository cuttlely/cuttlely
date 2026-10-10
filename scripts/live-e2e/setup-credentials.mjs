// Stores the provider keys as real Flowise credentials in the running Cuttlely (encrypted by the server).
// Keys are read from this process's environment only to send them to the credential API; they are never printed.
import { api, log } from './lib.mjs'

const WANTED = [
    { name: 'e2e-openai', credentialName: 'openAIApi', field: 'openAIApiKey', env: 'OPENAI_API_KEY' },
    { name: 'e2e-xai', credentialName: 'xaiApi', field: 'xaiApiKey', env: 'XAI_API_KEY' },
    { name: 'e2e-pinecone', credentialName: 'pineconeApi', field: 'pineconeApiKey', env: 'PINECONE_API_KEY' }
]

const existing = await api('GET', '/credentials')
for (const want of WANTED) {
    const found = existing.find((c) => c.name === want.name)
    if (found) {
        log(`credential ${want.name} (${want.credentialName}) exists: ${found.id}`)
        continue
    }
    const value = process.env[want.env]
    if (!value) throw new Error(`${want.env} is not set`)
    const created = await api('POST', '/credentials', {
        name: want.name,
        credentialName: want.credentialName,
        plainDataObj: { [want.field]: value }
    })
    log(`created credential ${want.name} (${want.credentialName}): ${created.id}`)
}
