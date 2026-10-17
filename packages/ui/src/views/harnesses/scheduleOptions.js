export function browserTimeZone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    } catch {
        return 'UTC'
    }
}

// The browser's own zone comes first after UTC: its canonical name can differ from the supported list, for example
// Asia/Kolkata against Asia/Calcutta.
export function timeZoneOptions(
    own = browserTimeZone(),
    supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
) {
    return [...new Set(['UTC', own, ...supported].filter(Boolean))]
}

export function ownerLabel(owner) {
    if (!owner) return 'unknown'
    return owner.name || owner.email || 'a removed user'
}
