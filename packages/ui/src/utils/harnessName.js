// Draft tries compile into a profile named try plus 8 to 32 hex characters. That shape cannot be saved.
const TRY_PROFILE_NAME = /^try[a-f0-9]{8,32}$/i

export function reservedHarnessNameMessage(name) {
    const text = String(name || '').trim()
    if (!TRY_PROFILE_NAME.test(text)) return ''
    return `Harness name "${text}" is reserved for a draft try. Choose a different name.`
}
