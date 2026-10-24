import { REDACTED_CREDENTIAL_VALUE } from '@/store/constant'

const URL_PASSWORD_MASK = '\u2022\u2022\u2022\u2022\u2022\u2022'

/** True for a URL whose password is the mask, typed as shown or percent-encoded. */
export const isMaskedUrlValue = (value) => {
    if (typeof value !== 'string') return false
    if (value.includes(URL_PASSWORD_MASK)) return true
    try {
        return decodeURIComponent(new URL(value).password).includes(URL_PASSWORD_MASK)
    } catch {
        return false
    }
}

/**
 * Splits edited credential values into what to send and what cannot be saved. A value that is still the blank
 * placeholder value or the masked URL the dialog was shown is left out so the stored value is kept. A masked URL
 * that was edited (host, port, database) cannot be saved without its password, so it is reported instead of
 * being dropped without a word.
 */
export const credentialSaveValues = (edited, shown) => {
    const plainDataObj = {}
    const maskedEdits = []
    for (const key in edited) {
        const value = edited[key]
        if (value === REDACTED_CREDENTIAL_VALUE) continue
        if (isMaskedUrlValue(value)) {
            if (value !== shown?.[key]) maskedEdits.push(key)
            continue
        }
        plainDataObj[key] = value
    }
    return { plainDataObj, maskedEdits }
}

/** Message for a failed save: the server's message, else the error's own (a check in the dialog). */
export const saveErrorMessage = (error) => {
    const data = error?.response?.data
    if (data !== undefined) return typeof data === 'object' ? data?.message : data
    return error?.message ?? String(error)
}
