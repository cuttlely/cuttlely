/**
 * Unit tests for MCP Streamable HTTP helpers and the UI catch-all guard.
 */
import express from 'express'
import request from 'supertest'
import { isMcpEndpointPath } from '../../identity/apiGate'
import { MCP_ENDPOINT_ALLOW, sendMcpMethodNotAllowed } from './http'

describe('sendMcpMethodNotAllowed', () => {
    it('answers 405 with Allow and a JSON-RPC error body', async () => {
        const app = express()
        app.get('/mcp/:chatflowId', (_req, res) => {
            sendMcpMethodNotAllowed(res)
        })

        const res = await request(app).get('/mcp/test-flow')

        expect(res.status).toBe(405)
        expect(res.headers.allow).toBe(MCP_ENDPOINT_ALLOW)
        expect(MCP_ENDPOINT_ALLOW).toBe('POST, DELETE, OPTIONS')
        expect(res.body).toEqual({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Method Not Allowed. This MCP endpoint does not offer server-initiated streams.' },
            id: null
        })
    })
})

describe('UI catch-all does not serve HTML for MCP paths', () => {
    function appWithCatchAll() {
        const app = express()
        // No MCP GET route: this is the built-server fall-through the catch-all must stop.
        app.use((req, res) => {
            if (isMcpEndpointPath(`${req.baseUrl}${req.path}`)) {
                sendMcpMethodNotAllowed(res)
                return
            }
            res.status(200).type('html').send('<html>ui</html>')
        })
        return app
    }

    it('returns 405 JSON for GET /api/v1/mcp/:chatflowId instead of index.html', async () => {
        const res = await request(appWithCatchAll()).get('/api/v1/mcp/test-flow')

        expect(res.status).toBe(405)
        expect(res.headers.allow).toBe('POST, DELETE, OPTIONS')
        expect(res.body.jsonrpc).toBe('2.0')
        expect(res.text).not.toContain('<html>')
        expect(res.type).not.toMatch(/html/)
    })

    it('returns 405 for GET /api/v1/mcp with no chatflow id', async () => {
        const res = await request(appWithCatchAll()).get('/api/v1/mcp')

        expect(res.status).toBe(405)
        expect(res.headers.allow).toBe('POST, DELETE, OPTIONS')
        expect(res.text).not.toContain('<html>')
    })

    it('still serves the UI for a normal client route', async () => {
        const res = await request(appWithCatchAll()).get('/chatflows')

        expect(res.status).toBe(200)
        expect(res.text).toBe('<html>ui</html>')
    })

    it('does not treat /api/v1/mcp-server as an MCP Streamable HTTP path', async () => {
        const res = await request(appWithCatchAll()).get('/api/v1/mcp-server/flow-123')

        expect(res.status).toBe(200)
        expect(res.text).toBe('<html>ui</html>')
    })
})
