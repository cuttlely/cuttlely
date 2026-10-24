import { REDACTED_CREDENTIAL_VALUE } from '@/store/constant'

const URL_PASSWORD_MASK = '\u2022\u2022\u2022\u2022\u2022\u2022'
const MASK_CHAR = '\u2022'
const ENCODED_MASK_CHAR = /%E2%80%A2/i
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * The raw password of a URL-shaped value. WHATWG URL first; a connection string it refuses (a MongoDB replica set
 * such as mongodb://u:p@db1:27017,db2:27017/app) is read from its authority: the user info is everything before the
 * last @ ahead of the first /, ? or #, and the password is what follows its first colon.
 */
const urlPassword = (value) => {
    try {
        return new URL(value).password
    } catch {
        const rest = value.slice(value.indexOf('://') + 3)
        const authority = rest.split(/[/?#]/, 1)[0]
        const at = authority.lastIndexOf('@')
        if (at < 0) return ''
        const userInfo = authority.slice(0, at)
        const colon = userInfo.indexOf(':')
        return colon < 0 ? '' : userInfo.slice(colon + 1)
    }
}

/**
 * True for a URL whose password is the mask, typed as shown or percent-encoded. Fails closed: a percent-encoded
 * bullet anywhere, or a password that does not percent-decode, counts as masked.
 */
export const isMaskedUrlValue = (value) => {
    if (typeof value !== 'string') return false
    if (value.includes(URL_PASSWORD_MASK)) return true
    // A percent-encoded bullet anywhere (any case) is the mask, typed or pasted encoded.
    if (ENCODED_MASK_CHAR.test(value)) return true
    // Fail closed: a URL-shaped value whose password cannot be read or decoded is treated as masked, so it
    // never replaces a stored password.
    if (!URL_LIKE.test(value.trim())) return false
    try {
        const password = decodeURIComponent(urlPassword(value.trim()))
        return password.includes(MASK_CHAR) || ENCODED_MASK_CHAR.test(password)
    } catch {
        return true
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
