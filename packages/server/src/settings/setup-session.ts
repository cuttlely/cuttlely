// The browser session opened by the one-time setup link. Only the link's code opens one; it lasts 30 minutes, lives
// in server memory only (the cookie holds a random value, the server keeps a hash of it), and every session ends
// as soon as the setup is done.
import { createHash, randomBytes } from 'crypto'
import { Request, Response } from 'express'

export const SETUP_COOKIE = 'cuttlely-setup'
export const SETUP_SESSION_MS = 30 * 60 * 1000

const sessions = new Map<string, number>()

function hash(value: string): string {
    return createHash('sha256').update(`${SETUP_COOKIE}\n${value}`).digest('hex')
}

/** Opens a setup session and sets its cookie. */
export function openSetupSession(req: Request, res: Response, now = Date.now()): void {
    const value = randomBytes(32).toString('base64url')
    for (const [key, expires] of sessions) if (expires <= now) sessions.delete(key)
    sessions.set(hash(value), now + SETUP_SESSION_MS)
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
    const value = ((req.cookies || {}) as Record<string, string | undefined>)[SETUP_COOKIE]
    if (!value || typeof value !== 'string') return null
    const key = hash(value)
    const expires = sessions.get(key)
    if (!expires) return null
    if (expires <= now) {
        sessions.delete(key)
        return null
    }
    return key
}

/** Ends every setup session. */
export function endSetupSessions(res?: Response): void {
    sessions.clear()
    res?.clearCookie(SETUP_COOKIE, { path: '/', httpOnly: true, sameSite: 'strict' })
}
