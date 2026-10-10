// Plain-words helpers for moving a flow from Dev to Prod. No Git words on screen: versions arrive from Dev
// and are promoted, never pulled, fetched or merged.

export const PROMOTE_PATH = '/promote'
export const CREDENTIALS_PATH = '/credentials'

export const promotePath = (flowId) => (flowId ? `${PROMOTE_PATH}/${encodeURIComponent(flowId)}` : PROMOTE_PATH)

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

// "2 flows have a new version from Dev", for the card and the flows list.
export const incomingSummary = (flows = []) => {
    const n = flows.length
    if (!n) return ''
    return n === 1 ? '1 flow has a new version from Dev' : `${n} flows have a new version from Dev`
}

// The line on each flow.
export const incomingLabel = (flow) => (flow?.status === 'new' ? 'New flow from Dev' : 'New version available from Dev')

// "3 changes on Dev since the last promote", or for a new flow how many versions Dev has published.
export const changesLine = (flow) => {
    const n = (flow?.changes || []).length
    const more = flow?.moreChanges ? '+' : ''
    if (!n) return ''
    if (flow?.status === 'new' || !flow?.lastPromoted) return `${plural(n, 'version', 'versions')}${more} published on Dev`
    return `${plural(n, 'change', 'changes')}${more} on Dev since the last promote`
}

// "OpenAI key (OpenAI)" style names for the missing-credentials list. The type is shown as Dev wrote it.
export const credentialText = (ref) => (ref?.credentialName ? `${ref.name} (${ref.credentialName})` : ref?.name || '')

export const MISSING_TITLE = 'Add these credentials on this server first'
export const missingIntro = (missing = []) =>
    missing.length === 1
        ? 'This version uses a credential this server does not have yet. Add one with the same name and type, then come back to promote.'
        : 'This version uses credentials this server does not have yet. Add each with the same name and type, then come back to promote.'

export const DRAFT_NOTE =
    'This flow has unpublished changes on this server. Promote keeps them as they are, and Publish will ask before it replaces the promoted version.'

export const NEW_FLOW_NOTE = 'This flow is not on this server yet. Promote adds it, Live, with the same name.'

export const HOW_IT_WORKS =
    'Dev and this server share one GitHub repository. Dev copies each version it publishes there, and this server only reads it. Nothing goes Live here until you promote it.'

// One sentence after a promote.
export const promotedMessage = (result) => {
    if (result?.unchanged) return 'Live here already matched this version, so nothing changed.'
    if (result?.created) return 'Promoted. The flow is now Live on this server.'
    return 'Promoted. This version is now Live on this server.'
}

export const historyNote = (result) =>
    result?.recorded === false
        ? 'It is Live, but it could not be added to version history here.'
        : 'History shows it as promoted from Dev. Roll back from version history any time.'

// Promote can run when nothing is missing and nothing is in flight.
export const canPromote = ({ detail, promoting = false, done = false }) =>
    Boolean(detail?.version?.sha) && !(detail?.missingCredentials || []).length && !promoting && !done

// The version Roll back returns to after a promote: the newest Live version before it, from this server's history.
export const rollbackTarget = (versions = [], promotedSha) => {
    const index = versions.findIndex((v) => v.sha === promotedSha)
    const before = index >= 0 ? versions.slice(index + 1) : []
    const target = before.find((v) => v.kind !== 'delete')
    return target ? target.sha : null
}

// The card's line on Prod.
export const readLine = (status, timeAgo) => {
    if (!status?.connected || status.role !== 'read') return ''
    if (status.state === 'retrying' || status.state === 'stopped') return ''
    if (status.lastCheckedAt) return `Looked for new versions from Dev ${timeAgo(status.lastCheckedAt)}`
    return 'Looking for new versions from Dev'
}
