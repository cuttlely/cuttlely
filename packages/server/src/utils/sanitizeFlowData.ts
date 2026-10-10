import { INodeParams } from 'flowise-components'
import { IReactFlowObject } from '../Interface'

const SENSITIVE_HEADER_KEYS = new Set(['authorization', 'x-api-key', 'x-auth-token', 'cookie'])

/** Fields the embed widget reads off the Start node. Everything else on that node stays off the public response. */
const PUBLIC_START_INPUTS = ['startInputType', 'formTitle', 'formDescription', 'formInputTypes'] as const

export const isChatflowKeyProtected = (apiKeyId: string | null | undefined): boolean => typeof apiKeyId === 'string' && apiKeyId.length > 0

/**
 * Sanitizes flowData before returning it from a public endpoint.
 * Strips password/file/folder inputs, credential ID references, and
 * auth-related HTTP headers so sensitive credentials are never exposed.
 */
export const sanitizeFlowDataForPublicEndpoint = (flowDataString: string): string => {
    if (!flowDataString) return flowDataString
    try {
        const flowData: IReactFlowObject = JSON.parse(flowDataString)
        if (!Array.isArray(flowData.nodes)) return flowDataString

        for (const node of flowData.nodes) {
            if (!node.data) continue

            // Remove credential ID reference
            delete node.data.credential

            const inputs = node.data.inputs

            if (!inputs) continue
            const inputParams: INodeParams[] = node.data.inputParams ?? []

            const sanitizedInputs: Record<string, unknown> = {}
            for (const key of Object.keys(inputs)) {
                const param = inputParams.find((p) => p.name === key)

                if (param && (param.type === 'password' || param.type === 'file' || param.type === 'folder')) {
                    continue
                }

                if (key === 'headers' && inputs[key]) {
                    try {
                        const rawHeaders = inputs[key]
                        // Array format: [{ key: string, value: string }, ...] (e.g. HTTP agentflow node)
                        if (Array.isArray(rawHeaders)) {
                            sanitizedInputs[key] = rawHeaders.filter(
                                (h: { key?: string; value?: string }) => !h.key || !SENSITIVE_HEADER_KEYS.has(h.key.toLowerCase())
                            )
                            continue
                        }
                        // Object/string format: Record<string, string> or JSON string thereof
                        const headers: Record<string, string> =
                            typeof rawHeaders === 'string' ? JSON.parse(rawHeaders) : { ...(rawHeaders as object) }
                        for (const h of Object.keys(headers)) {
                            if (SENSITIVE_HEADER_KEYS.has(h.toLowerCase())) delete headers[h]
                        }
                        sanitizedInputs[key] = typeof rawHeaders === 'string' ? JSON.stringify(headers) : headers
                        continue
                    } catch {
                        // Drop headers that cannot be parsed
                        continue
                    }
                }

                sanitizedInputs[key] = inputs[key]
            }
            node.data.inputs = sanitizedInputs
        }

        return JSON.stringify(flowData)
    } catch {
        return JSON.stringify({ nodes: [], edges: [] })
    }
}

/**
 * flowData for GET /api/v1/public-chatbotConfig/:id.
 * A chatflow with an API key does not get the canvas. The embed only needs the Start node's form fields.
 * An unprotected chatflow still gets the sanitized graph.
 */
export const flowDataForPublicChatbotConfig = (flowDataString: string, apiKeyId?: string | null): string | undefined => {
    if (!isChatflowKeyProtected(apiKeyId)) return sanitizeFlowDataForPublicEndpoint(flowDataString)
    return startNodeFormFlowData(flowDataString)
}

const startNodeFormFlowData = (flowDataString: string): string | undefined => {
    if (!flowDataString) return undefined
    try {
        const flowData: IReactFlowObject = JSON.parse(flowDataString)
        if (!Array.isArray(flowData.nodes)) return undefined
        const start = flowData.nodes.find((node) => node?.data?.name === 'startAgentflow')
        if (!start?.data) return undefined
        const inputs = (start.data.inputs ?? {}) as Record<string, unknown>
        const publicInputs: Record<string, unknown> = {}
        for (const key of PUBLIC_START_INPUTS) {
            if (inputs[key] !== undefined) publicInputs[key] = inputs[key]
        }
        return JSON.stringify({
            nodes: [
                {
                    id: start.id,
                    data: {
                        name: 'startAgentflow',
                        inputs: publicInputs
                    }
                }
            ],
            edges: []
        })
    } catch {
        return undefined
    }
}
