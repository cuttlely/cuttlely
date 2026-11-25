import { createHash } from 'node:crypto'
import { getHarness, listHarnessNames } from './store.mjs'

// Bind a named transcript to the saved harness and its canvas/team. Reusing a profile folder name in
// another workspace cannot recover the previous owner's PostgreSQL transcript.
export function publishedSessionScope(name) {
    const lower = name.toLowerCase()
    let record = getHarness(name)
    if (!record) {
        const matches = listHarnessNames().filter((candidate) => candidate.toLowerCase() === lower)
        if (matches.length > 1) throw new Error('Resolve case-colliding harness records before migrating their sessions.')
        if (matches.length) record = getHarness(matches[0])
    }
    if (!record) return 'profile:' + lower
    const owner = createHash('sha256')
        .update(JSON.stringify([record.name, record.workspaceId, record.chatflowId, record.createdAt]))
        .digest('hex')
    return 'profile:' + lower + ':' + owner
}
