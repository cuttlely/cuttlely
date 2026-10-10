// Plain-words helpers for the version history panel and viewer.

const KIND_LABELS = {
    create: 'Created',
    save: 'Saved',
    restore: 'Restored',
    delete: 'Deleted',
    publish: 'Published',
    rollback: 'Rolled back',
    promote: 'Promoted from Dev'
}

export const kindLabel = (kind) => KIND_LABELS[kind] || 'Saved'

// "just now", "5 minutes ago", "yesterday", or a date for anything older than a week.
export const relativeTime = (iso, now = Date.now()) => {
    const then = new Date(iso).getTime()
    if (!Number.isFinite(then)) return ''
    const seconds = Math.max(0, Math.round((now - then) / 1000))
    if (seconds < 45) return 'just now'
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`
    const days = Math.round(hours / 24)
    if (days === 1) return 'yesterday'
    if (days < 7) return `${days} days ago`
    return new Date(then).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export const exactTime = (iso) => {
    const date = new Date(iso)
    if (!Number.isFinite(date.getTime())) return ''
    return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// Which canvas a flow type opens in, for the "Back to editing" link.
// Where the viewer's back button goes. The first known flow type wins: the loaded version, the type the
// history drawer passed along, or the flow itself. With none known yet, null, so the button waits.
export const backPathFor = (chatflowId, ...types) => {
    const type = types.find((item) => typeof item === 'string' && item)
    return type ? canvasPathFor(type, chatflowId) : null
}

export const canvasPathFor = (type, chatflowId) => {
    const id = encodeURIComponent(chatflowId)
    switch (type) {
        case 'AGENTFLOW':
            return `/v2/agentcanvas/${id}`
        case 'MULTIAGENT':
            return `/agentcanvas/${id}`
        case 'HARNESS':
            return `/harnesscanvas/${id}`
        case 'ETL':
            return `/etlcanvas/${id}`
        default:
            return `/canvas/${id}`
    }
}

export const isAgentflowV2 = (type) => type === 'AGENTFLOW'

// Colors for what changed. Green is added, amber is changed. Removed nodes are not on the canvas, so they are listed.
export const CHANGE_COLORS = {
    added: '#2e7d32',
    changed: '#ed6c02'
}

const FIELD_LABELS = {
    inputs: 'settings',
    label: 'name',
    credential: 'credential',
    outputs: 'outputs',
    definition: 'component version'
}

export const fieldLabel = (field) => {
    if (typeof field !== 'string' || !field) return ''
    const name = field.replace(/^(inputs|node)\./, '')
    if (FIELD_LABELS[name]) return FIELD_LABELS[name]
    // systemMessage -> system message, max_tokens -> max tokens
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .toLowerCase()
}

// Adds an outline to each added or changed node. Returns new node objects and leaves the input alone.
export const decorateNodes = (nodes, diff) => {
    if (!Array.isArray(nodes)) return []
    if (!diff) return nodes
    const added = new Set((diff.added || []).map((node) => node.id))
    const changed = new Set((diff.changed || []).map((node) => node.id))
    return nodes.map((node) => {
        const status = added.has(node.id) ? 'added' : changed.has(node.id) ? 'changed' : null
        if (!status) return node
        return {
            ...node,
            data: { ...node.data, versionChange: status },
            style: {
                ...(node.style || {}),
                outline: `3px solid ${CHANGE_COLORS[status]}`,
                outlineOffset: '4px',
                borderRadius: '12px'
            }
        }
    })
}

// Plain-words lines for the change list next to the canvas.
// With "previous", the lines say what this version did. With "current", they say how this version differs from now.
// Pass the version's nodes to name moved nodes.
export const describeDiff = (diff, against = 'previous', nodes = []) => {
    if (!diff) return []
    const now = against === 'current'
    const lines = []
    if (diff.renamed) lines.push({ status: 'changed', text: `Name: "${diff.renamed.from}" to "${diff.renamed.to}"` })
    for (const node of diff.added || []) {
        lines.push({ status: 'added', text: now ? `${node.label} is in this version, not now` : `Added ${node.label}` })
    }
    for (const node of diff.changed || []) {
        const fields = (node.fields || []).map(fieldLabel).filter(Boolean)
        const detail = fields.length ? `: ${fields.join(', ')}` : ''
        lines.push({ status: 'changed', text: now ? `${node.label} differs from now${detail}` : `Changed ${node.label}${detail}` })
    }
    for (const node of diff.removed || []) {
        lines.push({ status: 'removed', text: now ? `${node.label} is there now, not in this version` : `Removed ${node.label}` })
    }
    if (diff.edgesChanged) lines.push({ status: 'changed', text: now ? 'Connections differ from now' : 'Rewired connections' })
    const moved = diff.moved || []
    if (moved.length) {
        const labels = new Map((nodes || []).map((node) => [node?.id, node?.data?.label || node?.data?.name || node?.id]))
        const named = moved.map((id) => labels.get(id)).filter(Boolean)
        const what =
            named.length === moved.length && named.length <= 3 ? named.join(', ') : `${moved.length} node${moved.length === 1 ? '' : 's'}`
        if (!lines.length)
            lines.push({ status: 'moved', text: now ? `Only positions differ from now: ${what}` : `Only node positions changed: ${what}` })
        else lines.push({ status: 'moved', text: now ? `In a different place now: ${what}` : `Moved ${what}` })
    }
    return lines
}

// Who made a version. A signed-in user's change carries their name; API keys and system saves are Cuttlely.
export const authorLabel = (version) => {
    if (version?.authorKind === 'user') return version.author || 'Unknown user'
    return 'Cuttlely (API key or system)'
}

export const authorKey = (version) => (version?.authorKind === 'user' && version.authorId ? `user:${version.authorId}` : 'system')

// The people in a list of versions, in the order they first appear (newest first).
export const authorOptions = (versions = []) => {
    const seen = new Map()
    for (const version of versions) {
        const key = authorKey(version)
        if (!seen.has(key)) seen.set(key, { key, label: authorLabel(version) })
    }
    return [...seen.values()]
}

export const filterByAuthor = (versions = [], key = 'all') => (key === 'all' ? versions : versions.filter((v) => authorKey(v) === key))

// The version to name in "Last edited by", from the history list response. When the latest save
// could not be written to history, the newest version is not the latest edit, so nothing is named.
export const lastEditedVersion = (data) => (data?.lastError ? null : data?.versions?.[0] || null)

export const lastEditedText = (version, now = Date.now()) =>
    version ? `Last edited by ${authorLabel(version)}, ${relativeTime(version.date, now)}` : ''

// When more than one credential has the name a version asks for: which one is used.
export const ambiguousCredentialText = (list = []) =>
    (list || [])
        .map((ref) =>
            ref.using === 'current'
                ? `${ref.count} credentials are named ${ref.name}. This version uses the one the flow uses now.`
                : `${ref.count} credentials are named ${ref.name}. None is in use, so this version uses the oldest one.`
        )
        .join(' ')

// The text the stored version holds where a secret-looking value was hidden.
export const SECRET_PLACEHOLDER = '[secret hidden]'

const countText = (count) =>
    count === 1 ? '1 secret-looking value was hidden from history' : `${count} secret-looking values were hidden from history`

// The note on a history entry, from its hiddenSecrets count.
export const hiddenNote = (version) => (version?.hiddenSecrets > 0 ? countText(version.hiddenSecrets) : '')

const hiddenPlaces = (list = []) => [...new Set((list || []).map((item) => `${item.label} (${item.inputLabel})`))].join(', ')

// The warning on a version, from its hiddenSecrets list.
export const hiddenSecretText = (list = []) => {
    const total = (list || []).reduce((sum, item) => sum + (item.count || 0), 0)
    if (!total) return ''
    return `${countText(total)}: ${hiddenPlaces(
        list
    )}. This version has ${SECRET_PLACEHOLDER} there instead. Replace it before you run this version, and keep keys in a credential.`
}

// Chips on a history row. "Current" stays when it is the same as Live and drafts are not in use,
// so a server with drafts off still reads the way it does today.
export const versionMarkers = (version, { liveSha, currentSha, draftMode } = {}) => {
    const markers = []
    if (version?.published) markers.push('Published')
    const isLive = Boolean(liveSha) && version?.sha === liveSha
    const isCurrent = Boolean(currentSha) && version?.sha === currentSha
    if (isLive && (draftMode || !isCurrent)) markers.push('Live')
    if (isCurrent && !markers.includes('Live')) markers.push('Current')
    return markers
}

// What to tell the user after a restore, from the restore response.
export const restoreMessage = (data = {}) => {
    const missing = (data.missingCredentials || []).map((ref) => ref.name)
    if (data.restoredTo === 'draft') {
        // Opening a version as the draft never adds a version to history (the server always sends
        // recorded: false), so that alone is not a problem worth a warning. Publish records it later.
        if (data.unchanged) return { message: 'This version is already live. There is nothing new to publish.', variant: 'info' }
        const notes = []
        if (missing.length) notes.push(`Add these credentials before you publish: ${missing.join(', ')}.`)
        if (data.hiddenSecrets?.length)
            notes.push(`Replace ${SECRET_PLACEHOLDER} in ${hiddenPlaces(data.hiddenSecrets)} before you publish.`)
        const base = 'Opened this version as your draft. Live is unchanged until you publish.'
        if (notes.length) return { message: `${base} ${notes.join(' ')}`, variant: 'warning' }
        return { message: base, variant: 'success' }
    }
    if (data.unchanged) return { message: 'The flow already matches this version.', variant: 'info' }
    if (data.recorded === false) {
        const reason = data.historyError ? ` ${data.historyError}` : ''
        return { message: `Restored, but history could not record it.${reason}`, variant: 'warning' }
    }
    const warnings = []
    if (missing.length) warnings.push(`Add these credentials before running it: ${missing.join(', ')}.`)
    if (data.hiddenSecrets?.length) warnings.push(`Replace ${SECRET_PLACEHOLDER} in ${hiddenPlaces(data.hiddenSecrets)} before running it.`)
    if (warnings.length) return { message: `Restored. ${warnings.join(' ')}`, variant: 'warning' }
    return { message: 'Restored. History has a new version, so you can undo this the same way.', variant: 'success' }
}
