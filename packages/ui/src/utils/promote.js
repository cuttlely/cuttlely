// Plain-words helpers for moving a flow from Dev to Prod. No Git words on screen: versions arrive from Dev
// and are promoted, never pulled, fetched or merged.

export const PROMOTE_PATH = '/promote'
export const CREDENTIALS_PATH = '/credentials'

export const promotePath = (flowId) => (flowId ? `${PROMOTE_PATH}/${encodeURIComponent(flowId)}` : PROMOTE_PATH)

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

// "2 flows have a new version from Dev", for the card and the flows list.
export const incomingSummary = (flows = [], sourceTitle = 'Dev') => {
    const n = flows.length
    if (!n) return ''
    return n === 1 ? `1 flow has a new version from ${sourceTitle}` : `${n} flows have a new version from ${sourceTitle}`
}

// The line on each flow.
export const incomingLabel = (flow, sourceTitle = 'Dev') =>
    flow?.status === 'new' ? `New flow from ${sourceTitle}` : `New version available from ${sourceTitle}`

// "3 changes on Dev since the last promote", or for a new flow how many versions Dev has published.
export const changesLine = (flow, sourceTitle = 'Dev') => {
    const n = (flow?.changes || []).length
    const more = flow?.moreChanges ? '+' : ''
    if (!n) return ''
    if (flow?.status === 'new' || !flow?.lastPromoted) return `${plural(n, 'version', 'versions')}${more} published on ${sourceTitle}`
    return `${plural(n, 'change', 'changes')}${more} on ${sourceTitle} since the last promote`
}

// The previous environment, as the screen names it. "Dev" when the list is the saved pair or the name is dev.
export const sourceTitleOf = (record) => {
    const chain = record?.environments || []
    const source = chain.find((item) => item.server === record?.source)
    if (!source || String(source.name).toLowerCase() === 'dev') return 'Dev'
    if (String(source.name).toLowerCase() === 'prod') return 'Prod'
    return source.name
}

export const showEnvironmentChain = (record) => (record?.environments || []).length > 2

// The Dev and Prod buttons. Any other list, including two entries with other server identities, uses its own names.
export const isSavedDevProdPair = (environments) => {
    if (!environments || environments.length !== 2) return false
    const [dev, prod] = environments
    const named = (item, server) =>
        item?.server === server && String(item?.name || '').toLowerCase() === server && (item.branch == null || item.branch === 'main')
    return named(dev, 'dev') && named(prod, 'prod')
}

export const howItWorks = (record) => {
    if (!showEnvironmentChain(record)) return HOW_IT_WORKS
    const from = sourceTitleOf(record)
    return `${from} publishes versions, and this server promotes them to Live. Promotion moves only to the next environment. Nothing goes Live here until you promote it.`
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

export const historyNote = (result, sourceTitle = 'Dev') =>
    result?.recorded === false
        ? 'It is Live, but it could not be added to version history here.'
        : sourceTitle === 'Dev'
        ? 'History shows it as promoted from Dev. Roll back from version history any time.'
        : `History shows it as promoted from ${sourceTitle}. Roll back from version history any time.`

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

const UNREADABLE_LIST = 'The environment list could not be read. Save it again.'
const LIST_UNREADABLE_CODE = 'LIST_UNREADABLE'

// The environment file only. A connection file that cannot be read uses a different sentence and a different code.
export const listUnreadable = (status) => status?.code === LIST_UNREADABLE_CODE || status?.message === UNREADABLE_LIST

// The environment this server reads from. "Dev" for the saved pair. Empty when the list file cannot be read.
export const previousEnvironmentTitle = (status) => {
    if (listUnreadable(status)) return ''
    const chain = status?.environments || []
    const index = chain.findIndex((item) => item.server === status?.environment)
    const previous = index > 0 ? chain[index - 1] : null
    if (!previous || String(previous.name).toLowerCase() === 'dev') return 'Dev'
    if (String(previous.name).toLowerCase() === 'prod') return 'Prod'
    return previous.name
}

export const promoteLoadError = (status) => {
    const from = previousEnvironmentTitle(status)
    if (!from) return 'New versions could not be loaded.'
    return from === 'Dev' ? 'New versions from Dev could not be loaded.' : `New versions from ${from} could not be loaded.`
}

export const promotePageTitle = (status, list) => {
    if (listUnreadable(status)) return 'New versions'
    const from = list ? sourceTitleOf(list) : previousEnvironmentTitle(status)
    if (!from) return 'New versions'
    return from === 'Dev' ? 'From Dev' : `From ${from}`
}

export const promotePageDescription = (status, list) => {
    if (listUnreadable(status)) return 'New versions could not be loaded.'
    const from = list ? sourceTitleOf(list) : previousEnvironmentTitle(status)
    if (!from) return 'New versions could not be loaded.'
    return from === 'Dev'
        ? 'Review what Dev published and promote it to Live on this server'
        : `Review what ${from} published and promote it to Live on this server`
}

// The card's line on a server that only reads. Names the previous environment.
export const readLine = (status, timeAgo) => {
    if (!status?.connected || status.role !== 'read') return ''
    if (status.state === 'retrying' || status.state === 'stopped') return ''
    const from = previousEnvironmentTitle(status)
    if (status.lastCheckedAt) {
        return from === 'Dev'
            ? `Looked for new versions from Dev ${timeAgo(status.lastCheckedAt)}`
            : `Looked for new versions from ${from} ${timeAgo(status.lastCheckedAt)}`
    }
    return from === 'Dev' ? 'Looking for new versions from Dev' : `Looking for new versions from ${from}`
}

// The card's subtitle on a server that only reads.
export const readIntro = (status) => {
    const from = previousEnvironmentTitle(status)
    return from === 'Dev'
        ? 'Get new versions from your Dev server through your GitHub repository.'
        : `Get new versions from your ${from} server through your GitHub repository.`
}
