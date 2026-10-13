import {
    TOKEN_GUIDE_URL,
    checkRepoName,
    environmentHint,
    environmentSwitchNote,
    filterRepos,
    ownCredentials,
    pollMs,
    retryIn,
    statusChip,
    syncLine,
    timeAgo,
    tokenCreateUrl,
    tokenHelp,
    tokenHint
} from './githubSync'

const NOW = new Date('2026-10-08T23:00:00Z').getTime()

describe('githubSync helpers', () => {
    test('a chip for every state, in plain words', () => {
        expect(statusChip({ state: 'off' }).label).toBe('History off')
        expect(statusChip({ connected: false, state: 'not-connected' }).label).toBe('Not connected')
        expect(statusChip({ connected: true, state: 'up-to-date' })).toMatchObject({ label: 'Up to date', color: 'success' })
        expect(statusChip({ connected: true, state: 'copying' }).label).toBe('Syncing')
        expect(statusChip({ connected: true, state: 'retrying' })).toMatchObject({ label: 'Retrying', color: 'warning' })
        expect(statusChip({ connected: true, state: 'stopped' })).toMatchObject({ label: 'Needs attention', color: 'error' })
    })

    test('polls faster while syncing', () => {
        expect(pollMs({ state: 'copying' })).toBe(3000)
        expect(pollMs({ state: 'up-to-date' })).toBe(15000)
    })

    test('times read naturally', () => {
        expect(timeAgo('2026-10-08T22:59:50Z', NOW)).toBe('just now')
        expect(timeAgo('2026-10-08T22:58:00Z', NOW)).toBe('2 minutes ago')
        expect(timeAgo('2026-10-08T22:00:00Z', NOW)).toBe('1 hour ago')
        expect(timeAgo(null, NOW)).toBe('')
        expect(retryIn('2026-10-08T23:02:00Z', NOW)).toBe('Trying again in 2 minutes')
        expect(retryIn('2026-10-08T23:00:20Z', NOW)).toBe('Trying again in a few seconds')
    })

    test('the sync line never uses Git words', () => {
        const lines = [
            syncLine({ connected: true, state: 'up-to-date', lastCopiedAt: '2026-10-08T22:58:00Z' }, NOW),
            syncLine({ connected: true, state: 'up-to-date' }, NOW),
            syncLine({ connected: true, state: 'copying' }, NOW),
            syncLine({ connected: true, state: 'waiting', waiting: 1 }, NOW),
            syncLine({ connected: true, state: 'retrying', nextTryAt: '2026-10-08T23:05:00Z' }, NOW)
        ]
        expect(lines).toEqual([
            'Last synced 2 minutes ago',
            'Every version is on GitHub',
            'Syncing your versions now',
            '1 new version syncs in a moment',
            'Trying again in 5 minutes'
        ])
        for (const line of lines) expect(line).not.toMatch(/push|commit|branch|main|merge/i)
    })

    test('filters repositories and puts empty ones first', () => {
        const repos = [
            { repo: 'acme/site', empty: false },
            { repo: 'acme/flows', empty: true },
            { repo: 'other/flows-old', empty: false }
        ]
        expect(filterRepos(repos).map((r) => r.repo)).toEqual(['acme/flows', 'acme/site', 'other/flows-old'])
        expect(filterRepos(repos, 'FLOWS').map((r) => r.repo)).toEqual(['acme/flows', 'other/flows-old'])
    })

    test('checks a new repository name', () => {
        expect(checkRepoName(' cuttlely-flows ')).toEqual({ name: 'cuttlely-flows' })
        expect(checkRepoName('').error).toBeTruthy()
        expect(checkRepoName('two words').error).toBeTruthy()
    })

    test('only GitHub sign-ins from this workspace are offered', () => {
        const list = [
            { id: 'a', name: 'GitHub: acme/flows' },
            { id: 'b', name: 'Shared GitHub', shared: true }
        ]
        expect(ownCredentials(list).map((c) => c.id)).toEqual(['a'])
        expect(ownCredentials(undefined)).toEqual([])
    })
    test("the token link opens GitHub's fine-grained page with Contents only, Read and write on Dev and Read-only on Prod", () => {
        const dev = new URL(tokenCreateUrl())
        expect(dev.origin + dev.pathname).toBe('https://github.com/settings/personal-access-tokens/new')
        expect(dev.searchParams.get('contents')).toBe('write')
        expect(dev.searchParams.get('expires_in')).toBe('90')
        expect(dev.searchParams.get('name').length).toBeLessThanOrEqual(40)
        // Contents, and nothing else: no other permission is asked for.
        const asked = [...dev.searchParams.keys()].filter((k) => !['name', 'description', 'expires_in'].includes(k))
        expect(asked).toEqual(['contents'])
        expect(new URL(tokenCreateUrl(true)).searchParams.get('contents')).toBe('read')
    })

    test('the token help says one repository, Contents only, and a set expiry, in plain words', () => {
        const dev = tokenHelp()
        const text = JSON.stringify(dev)
        expect(text).toContain('Fine-grained')
        expect(text).toContain('Only select repositories')
        expect(text).toContain('Contents: Read and write. Nothing else.')
        expect(text).toContain('Metadata: Read-only')
        expect(text).toContain('Expiration')
        expect(JSON.stringify(tokenHelp(true))).toContain('Contents: Read-only')
        expect(tokenHelp(true, 'Staging').note).toContain('your Staging server copies to')
        expect(tokenHelp(true, 'Staging').note).not.toContain('your Dev server')
        expect(tokenHelp(false, 'Dev').note).toContain('your Dev server copies to')
        expect(tokenHelp(false, 'Dev').note).not.toContain('empty private repository')
        expect(tokenHint()).toContain('Contents set to Read and write')
        expect(tokenHint(true)).toContain('Read-only')
        expect(TOKEN_GUIDE_URL).toMatch(/docs\/how-to\/versioning\.md#which-github-token-to-use$/)
        const pair = [
            { name: 'dev', branch: 'main', server: 'dev' },
            { name: 'prod', branch: 'main', server: 'prod' }
        ]
        const chain = [
            { name: 'Dev', branch: 'main', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        expect(environmentHint(pair)).toContain('Dev copies')
        expect(environmentHint(pair)).toContain('Prod reads')
        expect(environmentHint(chain)).toContain('Staging reads Dev and copies what it publishes')
        expect(environmentHint(chain)).toContain('Prod reads Staging')
        expect(environmentSwitchNote({ environment: 'prod', environments: pair })).toContain('Prod reads Dev')
        expect(environmentSwitchNote({ environment: 'dev', environments: pair })).toContain(
            'Disconnect GitHub before changing what this server reads or copies'
        )
        expect(environmentSwitchNote({ environment: 'staging', environments: chain })).toContain('Staging reads Dev')
        expect(environmentSwitchNote({ environment: 'staging', environments: chain })).toContain('Prod reads Staging')
        expect(environmentSwitchNote({ environment: 'dev', environments: chain })).toContain('Staging reads Dev')
        // No Git words on screen.
        for (const word of ['push', 'commit', 'branch', 'clone', 'scope']) expect(text.toLowerCase()).not.toContain(word)
    })
})
