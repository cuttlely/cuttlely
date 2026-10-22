// Text for the Agent Team list and page. Kept here so the wording is tested without rendering a page.

export const HARNESS_DELETE_PERMISSION = 'chatflows:delete,agentflows:delete'

export function harnessDeleteTitle(name) {
    return `Delete agent team "${name}"?`
}

export function harnessDeleteBody(harness) {
    const parts = [`"${harness?.name}" and its roster, specialists, playbooks and run history will be deleted.`]
    if (harness?.chatflowId && !harness?.orphaned) parts.push('Its canvas and chat messages go with it.')
    parts.push('This cannot be undone.')
    return parts.join(' ')
}

// What to show instead of the page. Null is a harness that opens normally.
export function harnessOpenProblem(harness, error) {
    const status = error?.response?.status
    if (status === 404) return { severity: 'warning', message: 'This agent team no longer exists. It may have been deleted.' }
    if (error) return { severity: 'error', message: 'This agent team could not be loaded. Try again.' }
    if (harness?.orphaned) {
        return {
            severity: 'warning',
            message:
                'The canvas this agent team was built from has been deleted, so the team cannot run. Delete it from the Agent Team list, or build it again on a new canvas.'
        }
    }
    return null
}

export function harnessCardDescription(harness) {
    if (harness?.orphaned) return 'Canvas deleted. This team cannot run.'
    return harness?.description || `${harness?.specialists?.length || 0} specialists`
}
