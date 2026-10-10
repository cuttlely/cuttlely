// First-run setup: after the first account is created, the owner goes on to where they were headed. The optional
// "Keep a copy in GitHub" page (/setup/github) is no longer part of setup; the same card is in Version History.
export const GITHUB_STEP_PATH = '/setup/github'

// Where to go after setup: the page the owner was headed to, when it is a page of this app,
// otherwise the home page.
export function nextAfterSetup(state) {
    const next = state?.next
    if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.startsWith(GITHUB_STEP_PATH)) return '/'
    return next
}

// The GitHub step only matters while version history is on. With history off there is nothing to copy.
export function skipGithubStep(status) {
    return status?.state === 'off'
}
