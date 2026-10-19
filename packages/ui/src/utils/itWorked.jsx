import { IT_WORKED_URL } from '@/store/constant'
import { useSnackbar } from 'notistack'
import { useCallback } from 'react'
import { useConfig } from '@/store/context/ConfigContext'

const SHOWN_KEY = 'cuttlely.itWorked.shown'
const DISMISSED_KEY = 'cuttlely.itWorked.dismissed'

export const itWorkedUrl = IT_WORKED_URL

let storageReader = (key) => {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
}

/** Test hook: replace the storage reader. Pass null to restore the default. */
export function setItWorkedStorageReader(reader) {
    storageReader =
        reader ||
        ((key) => {
            if (typeof localStorage === 'undefined') return null
            return localStorage.getItem(key)
        })
}

export function readItWorkedStorage(key) {
    return storageReader(key)
}

function storageGet(key) {
    return readItWorkedStorage(key)
}

export function shouldShowItWorked(config = {}, options = {}) {
    try {
        if (options.configLoading) return false
        if (options.configFailed) return false
        if (!config || typeof config !== 'object') return false
        if (!Object.prototype.hasOwnProperty.call(config, 'IT_WORKED_DISABLED')) return false
        if (config.IT_WORKED_DISABLED) return false
        if (storageGet(DISMISSED_KEY) === 'true') return false
        if (storageGet(SHOWN_KEY) === 'true') return false
        return true
    } catch {
        return false
    }
}

export function markItWorkedShown() {
    try {
        localStorage.setItem(SHOWN_KEY, 'true')
    } catch {
        // ignore storage errors
    }
}

export function dismissItWorked() {
    try {
        localStorage.setItem(DISMISSED_KEY, 'true')
    } catch {
        // ignore storage errors
    }
}

/** A stream toasts only when it produced a result and never saw error or abort. */
export function shouldToastOnStreamEnd({ sawResult, sawError, sawAbort } = {}) {
    return Boolean(sawResult) && !sawError && !sawAbort
}

/** Hook: call onSuccess() after a successful first run to show a one-time toast (no network calls). */
export function useItWorkedNotice() {
    const { enqueueSnackbar, closeSnackbar } = useSnackbar()
    const { config, loading } = useConfig() || {}
    const onSuccess = useCallback(() => {
        try {
            const settingsFailed = !loading && (!config || !Object.prototype.hasOwnProperty.call(config, 'IT_WORKED_DISABLED'))
            if (!shouldShowItWorked(config, { configLoading: loading, configFailed: settingsFailed })) return
            markItWorkedShown()
            const key = Date.now() + Math.random()
            enqueueSnackbar('It worked! If Cuttlely helped, a GitHub star helps others find it.', {
                key,
                variant: 'info',
                autoHideDuration: 8000,
                action: () => (
                    <div style={{ display: 'flex', gap: 8 }}>
                        <a href={IT_WORKED_URL} target='_blank' rel='noopener noreferrer' style={{ color: '#1976d2' }}>
                            Star on GitHub
                        </a>
                        <button
                            onClick={() => {
                                dismissItWorked()
                                closeSnackbar(key)
                            }}
                            style={{
                                background: 'transparent',
                                border: 'none',
                                color: '#6b7280',
                                cursor: 'pointer'
                            }}
                        >
                            Dismiss
                        </button>
                    </div>
                )
            })
        } catch {
            // never throw into the chat path
        }
    }, [enqueueSnackbar, closeSnackbar, config, loading])
    return { onSuccess }
}

export default useItWorkedNotice
