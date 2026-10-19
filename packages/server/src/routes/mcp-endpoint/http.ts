import { Response } from 'express'

/** Methods this MCP Streamable HTTP resource actually accepts. GET is registered only to answer 405. */
export const MCP_ENDPOINT_METHODS = ['POST', 'DELETE', 'OPTIONS'] as const

export const MCP_ENDPOINT_ALLOW = MCP_ENDPOINT_METHODS.join(', ')

/**
 * MCP 2025-03-26 Streamable HTTP: a server that does not offer server-initiated
 * streams answers GET with 405. Same body for any method that still reaches the
 * UI catch-all.
 */
export function sendMcpMethodNotAllowed(res: Response): void {
    res.set('Allow', MCP_ENDPOINT_ALLOW)
    res.status(405).json({
        jsonrpc: '2.0',
        error: {
            code: -32000,
            message: 'Method Not Allowed. This MCP endpoint does not offer server-initiated streams.'
        },
        id: null
    })
}
