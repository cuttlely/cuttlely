/**
 * Where the login page sends the browser. The server answers with the page to open. With no account yet that page
 * is /setup. When accounts exist and no sign-in method is on, the server answers 404 and the Sign In page says so.
 */
export function loginTarget(data, error) {
    if (data && typeof data.redirectUrl === 'string' && data.redirectUrl.startsWith('/')) return data.redirectUrl
    if (error) return '/signin'
    return null
}
