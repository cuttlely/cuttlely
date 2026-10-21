import { safeSetupNext } from '@/utils/firstRun'

/**
 * Where the login page sends the browser. The server answers with the page to open. With no account yet that page
 * is /setup. When accounts exist and no sign-in method is on, the server answers 404 and the Sign In page says so.
 */
export function loginTarget(data, error) {
    if (data && typeof data.redirectUrl === 'string' && data.redirectUrl.startsWith('/')) return data.redirectUrl
    if (error) return '/signin'
    return null
}

/**
 * A full page load drops router state, so the page the person was opening rides on /setup as next.
 * Other targets are left as the server named them. A path that is not on this server is left off.
 */
export function loginRedirect(target, path) {
    if (typeof target !== 'string') return target
    const pathname = target.split('?')[0].split('#')[0]
    if (pathname !== '/setup') return target
    const next = safeSetupNext(path)
    if (next === '/') return target
    const query = target.includes('?') ? target.slice(target.indexOf('?') + 1).split('#')[0] : ''
    const params = new URLSearchParams(query)
    params.set('next', next)
    const text = params.toString()
    return text ? `/setup?${text}` : '/setup'
}
