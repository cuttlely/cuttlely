// The one-time setup page (/server-setup): what to show, and checks for the first account form.
import { validatePassword } from '@/utils/validation'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The message for a failed call: closed links and missing sessions say what to do next. */
export function setupProblem(error) {
    const status = error?.response?.status
    const data = error?.response?.data ?? {}
    if (status === 410) return { closed: true, message: data.message || 'This setup link no longer works. Sign in instead.' }
    if (status === 404 && data.code === 'BAD_CODE') return { closed: true, message: data.message }
    if (status === 401) return { closed: true, message: data.message || 'Open the setup link from the server log again.' }
    return { closed: false, message: data.message || 'Something went wrong. Try again.' }
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

/** Removes the code from the address bar once it has been used, so it isn't left in history or shared by mistake. */
export function addressWithoutCode(href) {
    const url = new URL(href)
    url.searchParams.delete('code')
    return `${url.pathname}${url.search}${url.hash}`
}
