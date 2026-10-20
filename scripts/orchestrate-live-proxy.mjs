// Forward only Orchestrate and A2A routes to a local Cuttlely server. Used by the live test
// so the tunnel never reaches the admin UI or any other route.
import http from 'node:http'
import { pathToFileURL } from 'node:url'

const ORCH_PREFIX = '/api/v1/orchestrate/'
const A2A_PREFIX = '/api/v1/a2a/'
const PASS = ['authorization', 'x-api-key', 'x-ibm-thread-id', 'content-type', 'accept']

function allowed(method, path) {
    if (method === 'POST' && path.startsWith(ORCH_PREFIX) && path.length > ORCH_PREFIX.length) return true
    if (method === 'POST' && path.startsWith(A2A_PREFIX)) {
        const rest = path.slice(A2A_PREFIX.length).split('?')[0]
        return rest.length > 0 && !rest.includes('/')
    }
    if (method === 'GET' && path.startsWith(A2A_PREFIX)) {
        const rest = path.slice(A2A_PREFIX.length).split('?')[0]
        return /^[^/]+\/\.well-known\/agent-card\.json$/.test(rest)
    }
    return false
}

export function createOrchestrateProxy(target) {
    const dest = new URL(target)
    return http.createServer((req, res) => {
        const path = req.url || '/'
        if (!allowed(req.method, path)) {
            res.statusCode = 404
            res.end()
            return
        }
        const headers = {}
        for (const name of PASS) {
            const value = req.headers[name]
            if (typeof value === 'string') headers[name] = value
            else if (Array.isArray(value) && value[0]) headers[name] = value[0]
        }
        if (req.headers['content-length']) headers['content-length'] = req.headers['content-length']
        const upstream = http.request(
            {
                protocol: dest.protocol,
                hostname: dest.hostname,
                port: dest.port,
                path,
                method: req.method,
                headers
            },
            (up) => {
                res.writeHead(up.statusCode || 502, up.headers)
                if (typeof res.flushHeaders === 'function') res.flushHeaders()
                up.pipe(res)
            }
        )
        upstream.on('error', () => {
            if (!res.headersSent) res.writeHead(502)
            res.end()
        })
        req.pipe(upstream)
    })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const target = process.env.ORCHESTRATE_PROXY_TARGET || 'http://127.0.0.1:3000'
    const port = Number(process.env.ORCHESTRATE_PROXY_PORT || 0)
    const server = createOrchestrateProxy(target)
    server.listen(port, '127.0.0.1', () => {
        const addr = server.address()
        console.log(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : port}`)
    })
}
