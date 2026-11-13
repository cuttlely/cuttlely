// Name and type only. No id, no secret. Kept separate so the export helper does not load the credentials API.

export function credentialById(credentials) {
    const map = new Map()
    for (const row of credentials || []) {
        if (row && typeof row.id === 'string' && row.id.trim()) map.set(row.id.trim(), row)
    }
    return map
}

function credentialRef(value, byId) {
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && '$credential' in value)
        return value
    // An empty slot is not a credential. Leave it empty instead of marking it unresolved.
    if (typeof value !== 'string') return value
    if (!value.trim()) return ''
    const found = byId.get(value.trim())
    const name = typeof found?.name === 'string' ? found.name.trim() : ''
    const credentialName = typeof found?.credentialName === 'string' ? found.credentialName.trim() : ''
    if (!name || !credentialName) return { $credential: null }
    return { $credential: { name, credentialName } }
}

export function replaceCredentialIds(value, byId) {
    if (Array.isArray(value)) return value.map((item) => replaceCredentialIds(item, byId))
    if (!value || typeof value !== 'object') return value
    const out = {}
    let promoted = null
    for (const [key, item] of Object.entries(value)) {
        if (key === 'FLOWISE_CREDENTIAL_ID') {
            promoted = credentialRef(item, byId)
            continue
        }
        out[key] = key === 'credential' ? credentialRef(item, byId) : replaceCredentialIds(item, byId)
    }
    // A saved config often has credential: "" next to the id that was actually chosen.
    // An empty string is present, so it must not hide that id.
    const slotEmpty =
        out.credential === undefined || out.credential === null || (typeof out.credential === 'string' && !out.credential.trim())
    if (promoted && slotEmpty) out.credential = promoted
    return out
}

export function stripCredentialIds(value) {
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map((item) => stripCredentialIds(item))
    const out = {}
    for (const [key, item] of Object.entries(value)) {
        if (key === 'FLOWISE_CREDENTIAL_ID') continue
        out[key] = stripCredentialIds(item)
    }
    return out
}
