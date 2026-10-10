/**
 * Where the login page sends the browser. The server answers with the page to open, or 404 when no sign-in method is
 * on at all; then the Sign In page says so instead of leaving an empty page.
 */
export function loginTarget(data, error) {
    if (data && typeof data.redirectUrl === 'string' && data.redirectUrl.startsWith('/')) return data.redirectUrl
    if (error) return '/signin'
    return null
}
