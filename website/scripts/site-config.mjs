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
    'watch-a-team-resolve-a-complaint',
    'chat-with-a-team-in-minutes',
    'ab-test-every-change-before-it-goes-live',
    'test-every-change-before-it-goes-live',
    'ship-changes-safely-draft-compare-publish-roll-back',
    'agent-teams-that-power-your-apps',
    'use-a-team-from-your-app',
    'small-context-big-answers',
    'tools-your-teams-use',
    'start-in-minutes',
    'run-it-your-way',
    'bring-your-existing-flows'
]
