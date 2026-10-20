// The browser session opened by the one-time setup link. Only the link's code opens one; it lasts 30 minutes, lives
// in server memory only (the cookie holds a random value, the server keeps a hash of it and the HMAC of the code
// that opened it), and every session ends as soon as the setup is done.
import { createHash, randomBytes } from 'crypto'
import { Request, Response } from 'express'

export const SETUP_COOKIE = 'cuttlely-setup'
export const SETUP_SESSION_MS = 30 * 60 * 1000

interface HeldSession {
    expires: number
    codeHmac: string
}

const sessions = new Map<string, HeldSession>()

function hash(value: string): string {
    return createHash('sha256').update(`${SETUP_COOKIE}\n${value}`).digest('hex')
}

function held(req: Request, now: number): { key: string; session: HeldSession } | null {
    const value = ((req.cookies || {}) as Record<string, string | undefined>)[SETUP_COOKIE]
    if (!value || typeof value !== 'string') return null
    const key = hash(value)
    const session = sessions.get(key)
    if (!session) return null
    if (session.expires <= now) {
        sessions.delete(key)
        return null
    }
    return { key, session }
}

/** Opens a setup session for this code's HMAC and sets its cookie. */
export function openSetupSession(req: Request, res: Response, codeHmac: string, now = Date.now()): void {
    const value = randomBytes(32).toString('base64url')
    for (const [key, session] of sessions) if (session.expires <= now) sessions.delete(key)
    sessions.set(hash(value), { expires: now + SETUP_SESSION_MS, codeHmac })
    res.cookie(SETUP_COOKIE, value, {
        httpOnly: true,
        sameSite: 'strict',
        secure: req.secure,
        path: '/',
        maxAge: SETUP_SESSION_MS
    })
}

/** The setup session of this request, as a hash, or null when there is none (or it ran out). */
export function setupSessionHash(req: Request, now = Date.now()): string | null {
    return held(req, now)?.key ?? null
}

/** HMAC of the code that opened this request's setup session, or null when the session is missing. */
export function setupSessionCodeHmac(req: Request, now = Date.now()): string | null {
    const codeHmac = held(req, now)?.session.codeHmac
    return codeHmac ? codeHmac : null
}

/** Ends every setup session. */
export function endSetupSessions(res?: Response): void {
    sessions.clear()
    res?.clearCookie(SETUP_COOKIE, { path: '/', httpOnly: true, sameSite: 'strict' })
}
