import { UnnamedCredentialError, flowNeedsCredentialList } from './credentialMarks'

// Canvas export names a credential. It never writes the id or the secret.
// Import puts the destination id back when one credential on that server has the same name and type.

export { UnnamedCredentialError, flowNeedsCredentialList }

const BUNDLE_FLOW_KEYS = ['AgentFlow', 'AgentFlowV2', 'AssistantFlow', 'ChatFlow']

export function bundleNeedsCredentialList(bundle) {
    for (const row of bundleFlowRows(bundle)) {
        if (!row || typeof row.flowData !== 'string') continue
        try {
            if (flowNeedsCredentialList(JSON.parse(row.flowData))) return true
        } catch {
            // A flow the server cannot parse is reported by the import.
        }
    }
    return false
}

export function exportErrorMessage(error) {
    if (error instanceof UnnamedCredentialError) return error.message
    return exportFailureMessage()
}

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
                const matches = rows.filter((row) => {
                    const rowName = row && typeof row.name === 'string' ? row.name.trim() : ''
                    const rowType = row && typeof row.credentialName === 'string' ? row.credentialName.trim() : ''
                    return rowName === name && rowType === credentialName && typeof row.id === 'string' && row.id
                })
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
                if (key === 'credential') {
                    // Node data keeps the id on inputs. Agent, LLM, condition, and tool
                    // configs have no inputs child and read FLOWISE_CREDENTIAL_ID on this object.
                    const inputs = value.inputs
                    if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) inputs.FLOWISE_CREDENTIAL_ID = matches[0].id
                    else value.FLOWISE_CREDENTIAL_ID = matches[0].id
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
            `This server has ${ref.count} credentials named "${ref.name}" (${ref.credentialName}). The import does not choose one. Give them different names so only one has this name and type, then import again.`
        )
    }
    return lines.join(' ')
}

function bundleFlowRows(bundle) {
    if (!bundle || typeof bundle !== 'object') return []
    const rows = []
    for (const key of BUNDLE_FLOW_KEYS) {
        if (Array.isArray(bundle[key])) rows.push(...bundle[key])
    }
    return rows
}

export function bundleHasCredentialRefs(bundle) {
    for (const row of bundleFlowRows(bundle)) {
        if (!row || typeof row.flowData !== 'string') continue
        try {
            if (flowHasCredentialRefs(JSON.parse(row.flowData))) return true
        } catch {
            // The server reports a flow it cannot parse.
        }
    }
    return false
}

export function rebindCredentialBundle(bundle, credentials) {
    const next = { ...bundle }
    const errors = []
    for (const key of BUNDLE_FLOW_KEYS) {
        if (!Array.isArray(next[key])) continue
        next[key] = next[key].map((row) => {
            if (!row || typeof row.flowData !== 'string') return row
            let parsed
            try {
                parsed = JSON.parse(row.flowData)
            } catch {
                return row
            }
            if (!flowHasCredentialRefs(parsed)) return row
            const rebound = rebindFlowCredentials(parsed, credentials)
            const message = credentialRebindError(rebound)
            if (message) errors.push(message)
            return { ...row, flowData: JSON.stringify(rebound.flow) }
        })
    }
    return { bundle: next, message: [...new Set(errors)].join(' ') }
}

export async function rebindImportedBundle(bundle) {
    if (!bundleHasCredentialRefs(bundle)) return { ok: true, bundle }
    let credentials
    try {
        credentials = await credentialsForExport()
    } catch {
        return { ok: false, message: importListFailureMessage() }
    }
    const rebound = rebindCredentialBundle(bundle, credentials)
    if (rebound.message) return { ok: false, message: rebound.message }
    return { ok: true, bundle: rebound.bundle }
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
