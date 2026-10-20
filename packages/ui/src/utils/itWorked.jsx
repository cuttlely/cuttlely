import { Button } from '@mui/material'
import { IT_WORKED_URL } from '@/store/constant'
import { t } from '@/i18n'
import { useSnackbar } from 'notistack'
import { useCallback } from 'react'
import { useConfig } from '@/store/context/ConfigContext'

const SHOWN_KEY = 'cuttlely.itWorked.shown'
const DISMISSED_KEY = 'cuttlely.itWorked.dismissed'
export const IT_WORKED_HIDE_MS = 10000
export const IT_WORKED_SHARE_EVENT = 'cuttlely-open-share'

export const itWorkedUrl = IT_WORKED_URL

const defaultStorageReader = (key) => {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
}

const defaultStorageWriter = (key, value) => {
    if (typeof localStorage === 'undefined') {
        throw new Error('localStorage is not available')
    }
    localStorage.setItem(key, value)
}

let storageReader = defaultStorageReader
let storageWriter = defaultStorageWriter

/** Test hook: replace the storage reader. Pass null to restore the default. */
export function setItWorkedStorageReader(reader) {
    storageReader = reader || defaultStorageReader
}

/** Test hook: replace the storage writer. Pass null to restore the default. */
export function setItWorkedStorageWriter(writer) {
    storageWriter = writer || defaultStorageWriter
}

export function readItWorkedStorage(key) {
    return storageReader(key)
}

function storageGet(key) {
    return readItWorkedStorage(key)
}

function storageSet(key, value) {
    storageWriter(key, value)
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

/** Persist the shown marker. Returns true only when the marker is stored. */
export function markItWorkedShown() {
    try {
        storageSet(SHOWN_KEY, 'true')
        return storageGet(SHOWN_KEY) === 'true'
    } catch {
        return false
    }
}

export function dismissItWorked() {
    try {
        storageSet(DISMISSED_KEY, 'true')
        return storageGet(DISMISSED_KEY) === 'true'
    } catch {
        return false
    }
}

/** True only when the toast may show and the shown marker actually persisted. */
export function claimItWorkedShown(config, options) {
    if (!shouldShowItWorked(config, options)) return false
    return markItWorkedShown()
}

/**
 * Shows the one-time toast. The shown marker is written only after enqueue succeeds.
 * The share action asks the open canvas to open the API dialog. The star link is secondary.
 */
export function presentItWorked({ enqueueSnackbar, closeSnackbar, config, options }) {
    if (!shouldShowItWorked(config, options)) return false
    const key = Date.now() + Math.random()
    enqueueSnackbar(t('itWorked.next'), {
        key,
        variant: 'info',
        autoHideDuration: IT_WORKED_HIDE_MS,
        action: (snackbarKey) => (
            <div style={{ display: 'flex', gap: 8 }}>
                <Button
                    type='button'
                    aria-label={t('itWorked.share')}
                    style={{ color: 'white' }}
                    onClick={() => {
                        window.dispatchEvent(new Event(IT_WORKED_SHARE_EVENT))
                        closeSnackbar(snackbarKey)
                    }}
                >
                    {t('itWorked.share')}
                </Button>
                <a
                    href={IT_WORKED_URL}
                    target='_blank'
                    rel='noopener noreferrer'
                    aria-label='Star on GitHub (opens in a new tab)'
                    style={{ color: 'white' }}
                    onClick={() => closeSnackbar(snackbarKey)}
                >
                    {t('itWorked.star')}
                </a>
                <Button
                    type='button'
                    aria-label='Dismiss'
                    style={{ color: 'white' }}
                    onClick={() => {
                        dismissItWorked()
                        closeSnackbar(snackbarKey)
                    }}
                >
                    {t('itWorked.dismiss')}
                </Button>
            </div>
        )
    })
    return markItWorkedShown()
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
            presentItWorked({
                enqueueSnackbar,
                closeSnackbar,
                config,
                options: { configLoading: loading, configFailed: settingsFailed }
            })
        } catch {
            // never throw into the chat path
        }
    }, [enqueueSnackbar, closeSnackbar, config, loading])
    return { onSuccess }
}

export default useItWorkedNotice
