// Canvas export names a credential. It never writes the id or the secret.
// Import puts the destination id back when one credential on that server has the same name and type.

export async function credentialsForExport() {
    try {
        const { default: credentialsApi } = await import('../api/credentials')
        const resp = await credentialsApi.getAllCredentials()
        if (!Array.isArray(resp?.data)) throw new Error('The credential list did not load.')
        return resp.data
    } catch (error) {
        if (error instanceof Error && error.message === 'The credential list did not load.') throw error
        throw new Error('The credential list did not load.')
    }
}

export function exportFailureMessage() {
    return 'The credential list did not load, so this export was not saved.'
}

export function importListFailureMessage() {
    return 'The credential list did not load, so this import stopped.'
}

export function flowHasCredentialRefs(value) {
    if (Array.isArray(value)) return value.some((item) => flowHasCredentialRefs(item))
    if (!value || typeof value !== 'object') return false
    for (const [key, item] of Object.entries(value)) {
        if ((key === 'FLOWISE_CREDENTIAL_ID' || key === 'credential') && isCredentialMark(item)) return true
        if (flowHasCredentialRefs(item)) return true
    }
    return false
}

function isCredentialMark(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && '$credential' in value
}

export function rebindFlowCredentials(flow, credentials) {
    const rows = Array.isArray(credentials) ? credentials : []
    const missing = []
    const ambiguous = []
    const seen = new Set()
    const next = structuredClone(flow)
    const note = (bucket, key, item) => {
        if (seen.has(key)) return
        seen.add(key)
        bucket.push(item)
    }
    const walk = (value) => {
        if (Array.isArray(value)) {
            value.forEach(walk)
            return
        }
        if (!value || typeof value !== 'object') return
        for (const [key, item] of Object.entries(value)) {
            if ((key === 'FLOWISE_CREDENTIAL_ID' || key === 'credential') && isCredentialMark(item)) {
                const ref = item.$credential
                const name = ref && typeof ref.name === 'string' ? ref.name.trim() : ''
                const credentialName = ref && typeof ref.credentialName === 'string' ? ref.credentialName.trim() : ''
                if (!name || !credentialName) {
                    note(missing, 'unnamed', null)
                    value[key] = ''
                    continue
                }
                const matches = rows.filter(
                    (row) => row && row.name === name && row.credentialName === credentialName && typeof row.id === 'string' && row.id
                )
                if (matches.length === 0) {
                    note(missing, `${credentialName}\0${name}`, { name, credentialName })
                    value[key] = ''
                    continue
                }
                if (matches.length > 1) {
                    note(ambiguous, `many:${credentialName}\0${name}`, { name, credentialName, count: matches.length })
                    value[key] = ''
                    continue
                }
                value[key] = matches[0].id
                if (key === 'credential' && value.inputs && typeof value.inputs === 'object' && !Array.isArray(value.inputs)) {
                    value.inputs.FLOWISE_CREDENTIAL_ID = matches[0].id
                }
            } else {
                walk(item)
            }
        }
    }
    walk(next)
    return { flow: next, missing, ambiguous }
}

export function credentialRebindError(result) {
    const lines = []
    for (const ref of result?.missing || []) {
        if (!ref) {
            lines.push(
                'A credential on this flow was not named in the export. Export it again from a server that still has that credential.'
            )
        } else {
            lines.push(
                `This server has no credential named "${ref.name}" (${ref.credentialName}). Add it, then import again. The import did not create one.`
            )
        }
    }
    for (const ref of result?.ambiguous || []) {
        lines.push(
            `This server has ${ref.count} credentials named "${ref.name}" (${ref.credentialName}). Rename them so one name and type match, then import again.`
        )
    }
    return lines.join(' ')
}

export async function rebindImportedFlow(flow) {
    if (!flowHasCredentialRefs(flow)) return { ok: true, flow }
    let credentials
    try {
        credentials = await credentialsForExport()
    } catch {
        return { ok: false, message: importListFailureMessage() }
    }
    const rebound = rebindFlowCredentials(flow, credentials)
    const message = credentialRebindError(rebound)
    if (message) return { ok: false, message }
    return { ok: true, flow: rebound.flow }
}
