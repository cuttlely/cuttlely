import client from './client'

// Build with AI: one description in, an unsaved canvas out (nodes, edges, starter questions, missing credentials).
const build = (kind, body) => client.post(`/builder/${kind}/build`, body)

export default {
    build
}
