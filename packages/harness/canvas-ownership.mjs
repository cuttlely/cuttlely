import { HarnessError } from './errors.mjs'
import { getHarness } from './store.mjs'

// Only the trusted server-side canvas selector can attach this witness. JSON exports,
// stored roster fields and run bodies cannot impersonate it.
const publishedCanvas = Symbol('published canvas owner')

function sameCanvas(saved, roster) {
    return Boolean(
        roster.workspaceId &&
            roster.chatflowId &&
            saved?.name === roster.name &&
            saved.workspaceId === roster.workspaceId &&
            saved.chatflowId === roster.chatflowId
    )
}

export function bindCanvasOwner(roster, published) {
    const saved = getHarness(roster.name)
    if (saved && !sameCanvas(saved, roster)) throw new HarnessError('wrong_workspace', 'The selected canvas does not own this agent team.')
    if (saved) {
        // These registry fields have no graph representation. Compile all roles and assignments from the selected graph.
        roster.credentials = saved.credentials
        roster.description = saved.description || ''
    }
    if (published && saved?.createdAt && !saved.tryId) {
        roster[publishedCanvas] = Object.freeze({ generation: saved.createdAt, revision: saved.updatedAt })
    } else if (!roster.tryId) {
        throw new HarnessError('harness_changed', 'The published canvas owner could not be verified.')
    }
    return roster
}

export function publishedCanvasSource(roster) {
    const owner = roster[publishedCanvas]
    if (!owner) return
    const current = getHarness(roster.name)
    if (!sameCanvas(current, roster) || current.createdAt !== owner.generation || current.updatedAt !== owner.revision || current.tryId)
        throw new HarnessError('harness_changed', 'The published canvas changed during this turn.')
    // Return the trusted published host identity. The caller keeps the exact selected graph and its private Try session.
    return current
}
