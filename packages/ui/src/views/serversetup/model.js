// The one-time setup page (/setup): what to show, and checks for the first account form.
import { t } from '@/i18n'
import { safeSetupNext } from '@/utils/firstRun'
import { validatePassword } from '@/utils/validation'

const EXPIRED_CODE = 'This setup code has expired. A new code was printed in the server log.'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The message for a failed call. A wrong code can be tried again. A closed link cannot. */
export function setupProblem(error) {
    const status = error?.response?.status
    const data = error?.response?.data ?? {}
    if (status === 410) return { closed: true, message: data.message || 'This setup link no longer works. Sign in instead.' }
    if ((status === 404 || status === 400) && (data.reason === 'expired' || data.code === 'CODE_EXPIRED')) {
        return {
            closed: false,
            retry: true,
            expired: true,
            message: data.message || EXPIRED_CODE
        }
    }
    if (status === 404 && data.code === 'BAD_CODE') {
        return {
            closed: false,
            retry: true,
            message: data.message || 'This setup code is not right. Copy it again from the server log.'
        }
    }
    if (status === 401) return { closed: true, message: data.message || 'Open the setup link from the server log again.' }
    return { closed: false, message: data.message || 'Something went wrong. Try again.' }
}

/** Where the setup page says to read the code. The service name comes from the server. */
export function setupCodeHelp(serviceName) {
    const service = String(serviceName || '').trim() || 'the service'
    return {
        before: t('setup.code.help.before'),
        command: t('setup.code.help.command').replaceAll('{service}', service),
        after: t('setup.code.help.after')
    }
}

/** Problems with the first account form, by field. Empty when it can be sent. */
export function ownerProblems(form) {
    const problems = {}
    if (!form.name.trim()) problems.name = 'Enter your name.'
    else if (form.name.trim().length > 100) problems.name = 'Use at most 100 characters.'
    if (!EMAIL.test(form.email.trim())) problems.email = 'Enter an email address.'
    const weak = validatePassword(form.password)
    if (weak.length) problems.password = weak[0]
    if (form.confirm !== form.password) problems.confirm = 'The two passwords are different.'
    return problems
}

/** Server field errors ({ key, message }[]) as a by-field map. */
export function fieldErrors(errors) {
    return Object.fromEntries((errors ?? []).map((error) => [error.key, error.message]))
}

/** Removes the code and the return path from the query and the fragment, and keeps every other part. */
export function addressWithoutCode(href) {
    const url = new URL(href)
    url.searchParams.delete('code')
    url.searchParams.delete('next')
    const hash = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : '')
    hash.delete('code')
    hash.delete('next')
    const hashText = hash.toString()
    const search = url.searchParams.toString()
    return `${url.pathname}${search ? `?${search}` : ''}${hashText ? `#${hashText}` : ''}`
}

/**
 * Reads the setup code from the address and the address with that code removed.
 * The fragment wins over a query code. This does not call the network.
 */
export function readSetupCode(href) {
    const url = new URL(href)
    const hash = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : '')
    const fromHash = hash.get('code')
    const fromQuery = url.searchParams.get('code')
    const code = String(fromHash || fromQuery || '').trim()
    let next = '/'
    try {
        next = safeSetupNext(url.searchParams.get('next') || '')
    } catch {
        next = '/'
    }
    return { code, next, href: addressWithoutCode(href) }
}
