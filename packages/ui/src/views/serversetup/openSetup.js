// Opens /setup. A late hint must not move the page once begin has accepted the code.
// Cleanup aborts the controller from the previous run, so that run's answer is dropped.
import { t } from '@/i18n'
import { setupProblem } from './model'

let rememberedCode = ''

/** Keeps the code after the address is cleared, so a second effect run can still exchange it. */
export function rememberSetupCode(code) {
    if (typeof code === 'string' && code.trim()) rememberedCode = code.trim()
    return rememberedCode
}

/** Test hook. */
export function resetRememberedSetupCode() {
    rememberedCode = ''
}

function report(hooks, failure) {
    const next = setupProblem(failure)
    if (next.retry || !next.closed) hooks.onCode(next.message || '')
    else hooks.onClosed(next)
}

/**
 * @param {{ code?: string, resume?: boolean, api: object, signal?: AbortSignal, accepted: { current: boolean }, hooks: object }} options
 */
export async function openSetupPage({ code, resume, api, signal, accepted, hooks }) {
    const stopped = () => Boolean(signal?.aborted)
    if (stopped() || accepted?.current) return
    const config = signal ? { signal } : undefined
    try {
        if (resume) {
            const res = await api.getState(config)
            if (stopped() || accepted?.current) return
            hooks.onChoose(res?.data, true)
            return
        }
        if (code) {
            const hintPromise = Promise.resolve()
                .then(() => api.hint(config))
                .then((hint) => {
                    if (stopped()) return
                    const name = hint?.data?.serviceName || ''
                    if (name) hooks.onServiceName(name)
                })
                .catch(() => undefined)
            try {
                const begun = await api.begin(code, config)
                if (stopped()) return
                accepted.current = true
                if (begun?.data?.next === 'owner') {
                    hooks.onOwner(code)
                    return
                }
                const res = await api.getState(config)
                if (stopped()) return
                hooks.onChoose(res?.data, false)
            } catch (failure) {
                if (stopped() || accepted?.current) return
                await hintPromise
                if (stopped() || accepted?.current) return
                report(hooks, failure)
            }
            return
        }
        const hint = await api.hint(config)
        if (stopped() || accepted?.current) return
        hooks.onServiceName(hint?.data?.serviceName || '')
        if (hint?.data?.open) hooks.onCode('')
        else hooks.onClosed({ closed: true, message: t('setup.closed.notOpen') })
    } catch (failure) {
        if (stopped() || accepted?.current) return
        report(hooks, failure)
    }
}
