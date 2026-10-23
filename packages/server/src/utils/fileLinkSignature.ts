// Signed download links for files an Agent writes into its answer (GET /api/v1/get-upload-file). A plain link can't
// carry the flow's API key, so a browser user of a key-protected flow got 401. The link instead carries an expiry and
// an HMAC over the organization, flow id, chat id and file name, made with the server's own TOKEN_HASH_SECRET (created
// on first start under SECRETKEY_PATH; no setup step). It opens that one file, in that chat of that flow, for 15
// minutes. The organization is not in the address: the server signs with the flow's organization and checks against
// the organization the flow belongs to when the link is opened. No API key ever goes into a URL.
import { createHmac, timingSafeEqual } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { authSecret } from '../identity/authSecrets'

export const FILE_LINK_TTL_SECONDS = 15 * 60
const PURPOSE = 'cuttlely-file-link-v1'

export interface FileLinkTarget {
    /** The organization the flow belongs to (its workspace's organization). Signed, never put in the address. */
    orgId: string
    chatflowId: string
    chatId: string
    fileName: string
}

export type FileLinkCheck = 'valid' | 'expired' | 'invalid' | 'missing'

let secretOverride: string | undefined

/** TOKEN_HASH_SECRET: loaded at boot, else the environment, else its file (a queue worker does not load it at boot). */
function serverSecret(): string | undefined {
    if (secretOverride) return secretOverride
    try {
        return authSecret('TOKEN_HASH_SECRET')
    } catch {
        const fromEnv = process.env.TOKEN_HASH_SECRET?.trim()
        if (fromEnv) return fromEnv
        try {
            const dir = process.env.SECRETKEY_PATH || path.join(os.homedir(), '.cuttlely')
            const fromFile = fs.readFileSync(path.join(dir, 'token-hash.secret'), 'utf8')
            return fromFile || undefined
        } catch {
            return undefined
        }
    }
}

function mac(secret: string, target: FileLinkTarget, expires: number): string {
    // A key of its own for links, so a link signature can never stand in for a chat session token.
    const key = createHmac('sha256', secret).update(PURPOSE).digest()
    return createHmac('sha256', key)
        .update([target.orgId, target.chatflowId, target.chatId, target.fileName, String(expires)].join('\0'))
        .digest('base64url')
}

/** Expiry (unix seconds) and signature for one file, or undefined when the server has no secret to sign with. */
export function signFileLink(
    target: FileLinkTarget,
    now: number = Date.now(),
    ttlSeconds: number = FILE_LINK_TTL_SECONDS
): { expires: number; signature: string } | undefined {
    const secret = serverSecret()
    if (!secret || !target.orgId || !target.chatflowId || !target.chatId || !target.fileName) return undefined
    const expires = Math.floor(now / 1000) + ttlSeconds
    return { expires, signature: mac(secret, target, expires) }
}

/** The download address for a file in an Agent answer: signed when the server can sign, plain otherwise. */
export function fileDownloadUrl(
    baseURL: string,
    target: FileLinkTarget,
    now: number = Date.now(),
    ttlSeconds: number = FILE_LINK_TTL_SECONDS
): string {
    const params = new URLSearchParams({
        chatflowId: target.chatflowId,
        chatId: target.chatId,
        fileName: target.fileName,
        download: 'true'
    })
    const signed = signFileLink(target, now, ttlSeconds)
    if (signed) {
        params.set('expires', String(signed.expires))
        params.set('signature', signed.signature)
    }
    return `${baseURL}/api/v1/get-upload-file?${params.toString()}`
}

/** Checks a link's signature against exactly this organization, flow, chat and file. */
export function verifyFileLink(
    target: Partial<FileLinkTarget>,
    expires: unknown,
    signature: unknown,
    now: number = Date.now()
): FileLinkCheck {
    if (typeof signature !== 'string' || !signature || typeof expires !== 'string' || !expires) return 'missing'
    if (!/^\d{1,12}$/.test(expires) || signature.length > 128) return 'invalid'
    if (!target.orgId || !target.chatflowId || !target.chatId || !target.fileName) return 'invalid'
    const secret = serverSecret()
    if (!secret) return 'invalid'
    const expected = Buffer.from(mac(secret, target as FileLinkTarget, Number(expires)))
    const given = Buffer.from(signature)
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'invalid'
    if (Number(expires) * 1000 <= now) return 'expired'
    return 'valid'
}

/** Tests sign with a fixed secret. */
export function setFileLinkSecretForTests(secret: string | undefined): void {
    secretOverride = secret
}
