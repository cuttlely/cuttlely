// Shared constants for the cuttlely.com build scripts.
export const REPO_URL = 'https://github.com/cuttlely/cuttlely'
export const SITE_URL = 'https://cuttlely.com'
export const BRANCH = 'main'

// Repository files that become their own site pages. Everything under docs/ is rendered too.
export const ROOT_PAGES = {
    'CHANGELOG.md': '/changelog/',
    'SECURITY.md': '/security/',
    'CREDITS.md': '/credits/',
    NOTICE: '/credits/#notice'
}

// README sections that the home page shows with the same heading id, so links into the README land there.
export const HOME_ANCHORS = [
    'agent-teams-that-power-your-apps',
    'use-a-team-from-your-app',
    'chat-with-a-team-in-minutes',
    'tools-your-teams-use',
    'ship-changes-safely-draft-compare-publish-roll-back',
    'bring-your-existing-flows'
]
