import { isValidUUID } from 'flowise-components'
import chatflowsService from '../services/chatflows'
import logger from './logger'

// List of allowed URL slugs for public access to chatbots
// It assumes the URL format includes one of the following patterns:
// /prediction/{chatflowId}.
// /public-chatbotConfig/{chatflowId}
// /chatflows-streaming/{chatflowId}
const ALLOWED_SLUGS = ['/prediction/', '/public-chatbotConfig/', '/chatflows-streaming/']

// The TTS generate endpoint passes chatflowId in the request body, not the URL path
const TTS_GENERATE_PATH = '/api/v1/text-to-speech/generate'

/**
 * Validates if the origin is allowed for a specific chatflow
 * @param chatflowId - The chatflow ID to validate against
 * @param origin - The origin URL to validate
 * @param workspaceId - Optional workspace ID for enterprise features
 * @returns Promise<boolean> - True if domain is allowed, false otherwise
 */
async function validateChatflowDomain(chatflowId: string, origin: string, workspaceId?: string): Promise<boolean> {
    try {
        if (!chatflowId || !isValidUUID(chatflowId)) {
            throw new Error('Invalid chatflowId format - must be a valid UUID')
        }

        const chatflow = workspaceId
            ? await chatflowsService.getChatflowById(chatflowId, workspaceId)
            : await chatflowsService.getChatflowById(chatflowId)

        if (!chatflow?.chatbotConfig) {
            return true
        }

        const config = JSON.parse(chatflow.chatbotConfig)

        // If no allowed origins configured or first entry is empty, allow all
        if (!config.allowedOrigins?.length || config.allowedOrigins[0] === '') {
            return true
        }

        const originHost = new URL(origin).host
        const isAllowed = config.allowedOrigins.some((domain: string) => {
            try {
                const allowedOrigin = new URL(domain).host
                return originHost === allowedOrigin
            } catch (error) {
                logger.warn(`Invalid domain format in allowedOrigins: ${domain}`)
                return false
            }
        })

        return isAllowed
    } catch (error) {
        logger.error(`Error validating domain for chatflow ${chatflowId}:`, error)
        return false
    }
}

const DEFAULT_UNAUTHORIZED_ORIGIN_ERROR = 'This site is not allowed to access this chatbot'

// The host an Origin header names, or null when it names no site (`null`, or not a URL).
const originHost = (originHeader: string): string | null => {
    if (originHeader.trim().toLowerCase() === 'null') return null
    try {
        return new URL(originHeader).host || null
    } catch {
        return null
    }
}

// Chat files (charts and other images a run saved) are read from GET /api/v1/get-upload-file?chatflowId&chatId&fileName.
const UPLOAD_FILE_PATH = '/api/v1/get-upload-file'

/** True for a request to the chat file read route, by path only (the query never decides it). */
function isUploadFileReadRequest(url: string): boolean {
    const path = String(url || '')
        .split('?')[0]
        .toLowerCase()
        .replace(/\/+$/, '')
    return path === UPLOAD_FILE_PATH
}

/** The one chatflowId a chat file read names in its query, or null when it names none, several, or not a UUID. */
function uploadFileChatflowId(url: string): string | null {
    try {
        const ids = new URL(String(url || ''), 'http://localhost').searchParams.getAll('chatflowId')
        if (ids.length !== 1 || !isValidUUID(ids[0])) return null
        return ids[0]
    } catch {
        return null
    }
}

/**
 * True only when the chatflow lists this origin's site in its allowed domains (Embed > Allowed Domains), matched by host
 * as for predictions. Unlike `validateChatflowDomain`, a flow with no allowed domains (or an emptied list) lists no one,
 * so it grants nothing; an unknown flow, a bad id or config, or an Origin that names no site is false.
 */
async function isOriginListedByChatflow(chatflowId: string, origin: string): Promise<boolean> {
    try {
        if (!chatflowId || !isValidUUID(chatflowId)) return false
        const host = originHost(origin)
        if (!host) return false
        const chatflow = await chatflowsService.getChatflowById(chatflowId)
        if (!chatflow?.chatbotConfig) return false
        const config = JSON.parse(chatflow.chatbotConfig)
        const list = Array.isArray(config?.allowedOrigins) ? config.allowedOrigins : []
        if (!list.length || list[0] === '') return false
        return list.some((domain: unknown) => {
            if (typeof domain !== 'string' || !domain.trim()) return false
            try {
                return new URL(domain.trim()).host === host
            } catch {
                return false
            }
        })
    } catch {
        logger.warn(`Could not check the allowed domains of chatflow ${chatflowId} for a chat file read`)
        return false
    }
}

/**
 * The per-chatflow origin rule used by `POST /prediction` (the controller and `authorizePrediction`).
 * A request with no Origin header is allowed. An Origin that names a site is allowed on a flow with no allowed
 * origins (or an emptied list).
 * Otherwise the Origin host must equal the host of one allowed origin. `error` is the flow's
 * `allowedOriginsError` or the default message. An Origin that names no site (`null`, or not a URL) is refused.
 * Throws, as before, on unparsable chatbot config JSON.
 */
function checkChatflowOrigin(
    chatbotConfig: string | undefined | null,
    originHeader: string | undefined
): { allowed: boolean; error: string } {
    const parsedConfig = chatbotConfig ? JSON.parse(chatbotConfig) : {}
    // An empty first entry means the user set a value and then removed it.
    const isValidAllowedOrigins = parsedConfig.allowedOrigins?.length && parsedConfig.allowedOrigins[0] !== ''
    const error = parsedConfig.allowedOriginsError || DEFAULT_UNAUTHORIZED_ORIGIN_ERROR
    if (!originHeader) return { allowed: true, error }
    // `Origin: null` (sandboxed iframes, file:// pages, some redirects) or any Origin that is not a URL names no site,
    // so it is refused like any other site that is not allowed: 403, never a 500 from parsing it.
    const origin = originHost(originHeader)
    if (!origin) return { allowed: false, error }
    if (!isValidAllowedOrigins) return { allowed: true, error }
    const allowed =
        parsedConfig.allowedOrigins.filter((domain: string) => {
            try {
                return origin === new URL(domain).host
            } catch (e) {
                return false
            }
        }).length > 0
    return { allowed, error }
}

// NOTE: This function extracts the chatflow ID from a prediction URL.
// It assumes the URL format is /prediction/{chatflowId}.
/**
 * Extracts chatflow ID from prediction URL
 * @param url - The request URL
 * @returns string | null - The chatflow ID or null if not found
 */
function extractChatflowId(url: string): string | null {
    try {
        const urlParts = url.split('/')
        const slug = extractSlugFromUrl(url)
        if (!slug) return null
        const slugIndex = urlParts.indexOf(slug)

        if (slugIndex !== -1 && urlParts.length > slugIndex + 1) {
            const chatflowId = urlParts[slugIndex + 1]
            // Remove query parameters if present
            return chatflowId.split('?')[0]
        }

        return null
    } catch (error) {
        logger.error('Error extracting chatflow ID from URL:', error)
        return null
    }
}

/**
 * Extracts the slug from the URL if it matches any of the allowed slugs
 * @param url - The request URL
 * @returns string | null - The matched slug or null if no match
 */
function extractSlugFromUrl(url: string): string | null {
    for (const publicUrl of ALLOWED_SLUGS) {
        if (url.includes(publicUrl)) {
            return publicUrl.replace(/\//g, '') // remove slashes
        }
    }
    return null
}

/**
 * Validates if a request is for public chatflows (embedded chatbots)
 * @param url - The request URL
 * @returns boolean - True if it's a public chatflow request
 */
function isPublicChatflowRequest(url: string): boolean {
    return extractSlugFromUrl(url) !== null
}

/**
 * Checks if the request is for the TTS generate endpoint.
 * This endpoint passes chatflowId in the request body rather than the URL path.
 * @param url - The request URL
 * @returns boolean - True if it's the TTS generate endpoint
 */
function isTTSGenerateRequest(url: string): boolean {
    return url.split('?')[0] === TTS_GENERATE_PATH
}

/**
 * Get the custom error message for unauthorized origin
 * @param chatflowId - The chatflow ID
 * @param workspaceId - Optional workspace ID
 * @returns Promise<string> - Custom error message or default
 */
async function getUnauthorizedOriginError(chatflowId: string, workspaceId?: string): Promise<string> {
    try {
        const chatflow = workspaceId
            ? await chatflowsService.getChatflowById(chatflowId, workspaceId)
            : await chatflowsService.getChatflowById(chatflowId)

        if (chatflow?.chatbotConfig) {
            const config = JSON.parse(chatflow.chatbotConfig)
            return config.allowedOriginsError || 'This site is not allowed to access this chatbot'
        }

        return 'This site is not allowed to access this chatbot'
    } catch (error) {
        logger.error(`Error getting unauthorized origin error for chatflow ${chatflowId}:`, error)
        return 'This site is not allowed to access this chatbot'
    }
}

export {
    isPublicChatflowRequest,
    isTTSGenerateRequest,
    extractChatflowId,
    validateChatflowDomain,
    getUnauthorizedOriginError,
    checkChatflowOrigin,
    isUploadFileReadRequest,
    uploadFileChatflowId,
    isOriginListedByChatflow
}
