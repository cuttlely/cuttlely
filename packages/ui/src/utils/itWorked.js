import { IT_WORKED_URL } from '@/store/constant'
import { useSnackbar } from 'notistack'
import { useCallback } from 'react'
import { useConfig } from '@/store/context/ConfigContext'

const SHOWN_KEY = 'cuttlely.itWorked.shown'
const DISMISSED_KEY = 'cuttlely.itWorked.dismissed'

export const itWorkedUrl = IT_WORKED_URL

export function shouldShowItWorked(config = {}) {
    if (config?.IT_WORKED_DISABLED) return false
    if (localStorage.getItem(DISMISSED_KEY) === 'true') return false
    if (localStorage.getItem(SHOWN_KEY) === 'true') return false
    return true
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

/** Hook: call onSuccess() after a successful first run to show a one-time toast (no network calls). */
export function useItWorkedNotice() {
    const { enqueueSnackbar, closeSnackbar } = useSnackbar()
    const { config } = useConfig()
    const onSuccess = useCallback(() => {
        if (!shouldShowItWorked(config)) return
        // Mark as shown so concurrent toasts do not show twice.
        markItWorkedShown()
        const key = Date.now() + Math.random()
        enqueueSnackbar('It worked! If Cuttlely helped, a GitHub star helps others find it.', {
            key,
            variant: 'info',
            autoHideDuration: 8000,
            action: () => (
                // eslint-disable-next-line react/jsx-no-target-blank
                <div style={{ display: 'flex', gap: 8 }}>
                    <a href={IT_WORKED_URL} target='_blank' rel='noreferrer' style={{ color: '#1976d2' }}>
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
    }, [enqueueSnackbar, closeSnackbar, config])
    return { onSuccess }
}

export default useItWorkedNotice
