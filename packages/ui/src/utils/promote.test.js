import fs from 'fs'
import path from 'path'
import { GIT_WORDS, gitWordsIn, messagesInSource } from './plainWords'

import {
    canPromote,
    changesLine,
    credentialText,
    historyNote,
    incomingLabel,
    incomingSummary,
    missingIntro,
    previousEnvironmentTitle,
    promoteLoadError,
    promotePageDescription,
    promotePageTitle,
    promotePath,
    promotedMessage,
    readIntro,
    readLine,
    rollbackTarget,
    showEnvironmentChain,
    sourceTitleOf
} from './promote'

describe('promote helpers', () => {
    test('summary and labels in plain words', () => {
        expect(incomingSummary([])).toBe('')
        expect(incomingSummary([{}])).toBe('1 flow has a new version from Dev')
        expect(incomingSummary([{}, {}])).toBe('2 flows have a new version from Dev')
        expect(incomingLabel({ status: 'update' })).toBe('New version available from Dev')
        expect(incomingLabel({ status: 'new' })).toBe('New flow from Dev')
        expect(promotePath()).toBe('/promote')
        const unreadable = {
            environments: [],
            environment: null,
            state: 'stopped',
            message: 'The environment list could not be read. Save it again.'
        }
        expect(previousEnvironmentTitle(unreadable)).toBe('')
        expect(promotePageTitle(unreadable, null)).toBe('New versions')
        expect(promotePageTitle(unreadable, null)).not.toBe('From Dev')
        expect(promotePageDescription(unreadable, null)).toBe('New versions could not be loaded.')
        expect(promoteLoadError(unreadable)).toBe('New versions could not be loaded.')
        expect(promotePath('a b')).toBe('/promote/a%20b')
    })

    test('how many changes Dev made', () => {
        expect(changesLine({ status: 'update', changes: [{}, {}], lastPromoted: { sha: 'x' } })).toBe(
            '2 changes on Dev since the last promote'
        )
        expect(changesLine({ status: 'update', changes: [{}], moreChanges: true, lastPromoted: { sha: 'x' } })).toBe(
            '1 change+ on Dev since the last promote'
        )
        expect(changesLine({ status: 'new', changes: [{}, {}, {}] })).toBe('3 versions published on Dev')
        expect(changesLine({ changes: [] })).toBe('')
    })

    test('credentials and Promote readiness', () => {
        expect(credentialText({ name: 'OpenAI key', credentialName: 'openAIApi' })).toBe('OpenAI key (openAIApi)')
        expect(missingIntro([{}])).toContain('a credential this server does not have yet')
        expect(missingIntro([{}, {}])).toContain('credentials this server does not have yet')
        const detail = { version: { sha: 'a'.repeat(40) }, missingCredentials: [] }
        expect(canPromote({ detail })).toBe(true)
        expect(canPromote({ detail: { ...detail, missingCredentials: [{ name: 'x' }] } })).toBe(false)
        expect(canPromote({ detail, promoting: true })).toBe(false)
        expect(canPromote({ detail, done: true })).toBe(false)
    })

    test('after Promote: the message, the history note and what Roll back returns to', () => {
        expect(promotedMessage({ unchanged: true })).toContain('nothing changed')
        expect(promotedMessage({ created: true })).toBe('Promoted. The flow is now Live on this server.')
        expect(promotedMessage({})).toBe('Promoted. This version is now Live on this server.')
        expect(historyNote({ recorded: false })).toContain('could not be added')
        expect(historyNote({ recorded: true })).toContain('promoted from Dev')
        const versions = [{ sha: 'p' }, { sha: 'd', kind: 'delete' }, { sha: 'l', kind: 'publish' }]
        expect(rollbackTarget(versions, 'p')).toBe('l')
        expect(rollbackTarget(versions, 'zzz')).toBeNull()
        expect(rollbackTarget([{ sha: 'p' }], 'p')).toBeNull()
    })

    test('a longer chain names the previous environment, and the saved pair stays Dev', () => {
        const pair = {
            environments: [
                { name: 'dev', server: 'dev' },
                { name: 'prod', server: 'prod' }
            ],
            source: 'dev',
            target: 'prod'
        }
        const chain = {
            environments: [
                { name: 'Dev', server: 'dev' },
                { name: 'Staging', server: 'staging' },
                { name: 'Prod', server: 'prod' }
            ],
            source: 'staging',
            target: 'prod'
        }
        expect(showEnvironmentChain(pair)).toBe(false)
        expect(sourceTitleOf(pair)).toBe('Dev')
        expect(showEnvironmentChain(chain)).toBe(true)
        expect(sourceTitleOf(chain)).toBe('Staging')
        expect(incomingSummary([{}], 'Staging')).toBe('1 flow has a new version from Staging')
        expect(incomingLabel({ status: 'update' }, 'Staging')).toBe('New version available from Staging')
    })

    test('the card line on Prod', () => {
        const ago = () => '2 minutes ago'
        expect(readLine({ connected: true, role: 'read', state: 'up-to-date', lastCheckedAt: 'x' }, ago)).toBe(
            'Looked for new versions from Dev 2 minutes ago'
        )
        expect(readLine({ connected: true, role: 'read', state: 'waiting' }, ago)).toBe('Looking for new versions from Dev')
        expect(readLine({ connected: true, role: 'read', state: 'retrying' }, ago)).toBe('')
        expect(readLine({ connected: true, role: 'copy' }, ago)).toBe('')
        const prod = {
            connected: true,
            role: 'read',
            state: 'up-to-date',
            lastCheckedAt: 'x',
            environment: 'prod',
            environments: [
                { name: 'Dev', server: 'dev' },
                { name: 'Staging', server: 'staging' },
                { name: 'Prod', server: 'prod' }
            ]
        }
        expect(previousEnvironmentTitle(prod)).toBe('Staging')
        expect(readLine(prod, ago)).toBe('Looked for new versions from Staging 2 minutes ago')
        expect(readIntro(prod)).toBe('Get new versions from your Staging server through your GitHub repository.')
        expect(readIntro({ environment: 'prod' })).toBe('Get new versions from your Dev server through your GitHub repository.')
    })
})

// Every message the promote screens and the GitHub card can show: no Git words such as main, branch, commit,
// push, pull or merge. The scanner is in utils/plainWords.
describe('plain words on screen', () => {
    const files = [
        path.join(__dirname, 'promote.js'),
        path.join(__dirname, 'githubSync.js'),
        path.join(__dirname, '..', 'views', 'promote', 'PromoteViews.jsx'),
        path.join(__dirname, '..', 'views', 'promote', 'index.jsx'),
        path.join(__dirname, '..', 'views', 'promote', 'PromoteFlow.jsx'),
        path.join(__dirname, '..', 'ui-component', 'flow', 'FromDevBanner.jsx'),
        path.join(__dirname, '..', 'views', 'versionsettings', 'GithubCard.jsx'),
        path.join(__dirname, '..', 'views', 'setup', 'GithubStep.jsx')
    ]

    test.each(files.map((file) => [path.basename(path.dirname(file)) + '/' + path.basename(file), file]))('%s', (_name, file) => {
        const source = fs.readFileSync(file, 'utf8')
        expect(messagesInSource(source).length).toBeGreaterThan(0)
        expect(gitWordsIn(source)).toEqual([])
    })

    test('the scan reads one-word labels, JSX text and strings joined with +', () => {
        const sample = [
            "const label = done ? 'Merged' : 'Pushing…'",
            "const text = 'Could not ' + 'push' + ' this version.'",
            '<Typography>Fetched</Typography>',
            "<Button variant='contained'>Promote to Live</Button>",
            '// Commit is a comment and never on screen.'
        ].join('\n')
        expect(messagesInSource(sample)).toEqual(
            expect.arrayContaining(['Merged', 'Pushing…', 'Could not push this version.', 'Fetched', 'Promote to Live'])
        )
        expect(gitWordsIn(sample).sort()).toEqual(['Could not push this version.', 'Fetched', 'Merged', 'Pushing…'].sort())
        for (const plain of ['Promoted from Dev', 'Look Now', 'Up to date']) expect(GIT_WORDS.test(plain)).toBe(false)
    })
})
