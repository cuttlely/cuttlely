import { INodeParams } from '@cuttlely/components'
import { IReactFlowObject } from '../Interface'

const SENSITIVE_HEADER_KEYS = new Set(['authorization', 'x-api-key', 'x-auth-token', 'cookie'])
const SECRET_PARAM_TYPES = new Set(['password', 'file', 'folder'])
const SECRET_INPUT_NAME = /(api[_-]?key|secret|token|password|authorization)/i
// Token-count settings (maxTokens, maxOutputTokens) are ordinary numbers, not credentials.
const TOKEN_COUNT_WORD = /tokens/gi
const SECRET_VALUE = /^\s*(sk-|sk_|xai-|ghp_|gho_|github_pat_|xox[abposr]-|AKIA|Bearer\s)/

/** True when a string value looks like a credential (provider key prefixes, bearer tokens). */
export const looksLikeSecretValue = (value: unknown): boolean => typeof value === 'string' && SECRET_VALUE.test(value)

/** True when an input name suggests it holds a credential. */
export const isSecretInputName = (name: string): boolean => SECRET_INPUT_NAME.test(name.replace(TOKEN_COUNT_WORD, ''))

/**
 * Allowlist filter for a node's saved inputs on public and template responses.
 * An input is kept only when the node defines it (inputParams or inputAnchors) with a non-secret type,
 * its name does not suggest a credential, and its value does not look like one.
 */
export const sanitizeNodeInputs = (
    inputs: Record<string, unknown> | undefined,
    inputParams: INodeParams[] | undefined,
    inputAnchors?: { name?: string }[] | undefined
): Record<string, unknown> => {
    const result: Record<string, unknown> = {}
    if (!inputs || typeof inputs !== 'object') return result
    const params = Array.isArray(inputParams) ? inputParams : []
    const anchors = Array.isArray(inputAnchors) ? inputAnchors : []
    for (const key of Object.keys(inputs)) {
        const param = params.find((p) => p?.name === key)
        const anchor = anchors.find((a) => a?.name === key)
        if (!param && !anchor) continue
        if (param && SECRET_PARAM_TYPES.has(param.type)) continue
        if (isSecretInputName(key)) continue
        const value = inputs[key]
        if (looksLikeSecretValue(value)) continue
        if (key === 'headers' && value) {
            const headers = sanitizeHeaders(value)
            if (headers !== undefined) result[key] = headers
            continue
        }
        result[key] = value
    }
    return result
}

const sanitizeHeaders = (rawHeaders: unknown): unknown => {
    try {
        // Array format: [{ key: string, value: string }, ...] (e.g. HTTP agentflow node)
        if (Array.isArray(rawHeaders)) {
            return rawHeaders.filter(
                (h: { key?: string; value?: string }) =>
                    !h?.key || (!SENSITIVE_HEADER_KEYS.has(h.key.toLowerCase()) && !looksLikeSecretValue(h.value))
            )
        }
        // Object/string format: Record<string, string> or JSON string thereof
        const headers: Record<string, string> = typeof rawHeaders === 'string' ? JSON.parse(rawHeaders) : { ...(rawHeaders as object) }
        for (const h of Object.keys(headers)) {
            if (SENSITIVE_HEADER_KEYS.has(h.toLowerCase()) || looksLikeSecretValue(headers[h])) delete headers[h]
        }
        return typeof rawHeaders === 'string' ? JSON.stringify(headers) : headers
    } catch {
        // Drop headers that cannot be parsed
        return undefined
    }
}

export const isChatflowKeyProtected = (apiKeyId: string | null | undefined): boolean => typeof apiKeyId === 'string' && apiKeyId.length > 0

/**
 * Sanitizes flowData before returning it from a public endpoint.
 * Keeps only defined, non-secret inputs (see sanitizeNodeInputs), removes credential ID
 * references and auth-related HTTP headers so sensitive credentials are never exposed.
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

            if (!node.data.inputs) continue
            node.data.inputs = sanitizeNodeInputs(node.data.inputs, node.data.inputParams, node.data.inputAnchors)
        }

        return JSON.stringify(flowData)
    } catch {
        return JSON.stringify({ nodes: [], edges: [] })
    }
}
