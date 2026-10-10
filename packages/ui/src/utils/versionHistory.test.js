import {
    canvasPathFor,
    decorateNodes,
    describeDiff,
    fieldLabel,
    kindLabel,
    relativeTime,
    backPathFor,
    restoreMessage,
    authorLabel,
    authorOptions,
    filterByAuthor,
    lastEditedText,
    lastEditedVersion,
    ambiguousCredentialText,
    hiddenNote,
    hiddenSecretText,
    SECRET_PLACEHOLDER
} from './versionHistory'

describe('versionHistory', () => {
    const now = Date.parse('2026-10-08T12:00:00Z')

    it('labels version kinds in plain words', () => {
        expect(kindLabel('create')).toBe('Created')
        expect(kindLabel('restore')).toBe('Restored')
        expect(kindLabel('promote')).toBe('Promoted from Dev')
        expect(kindLabel('something-else')).toBe('Saved')
    })

    it('gives relative times', () => {
        expect(relativeTime('2026-10-08T11:59:40Z', now)).toBe('just now')
        expect(relativeTime('2026-10-08T11:55:00Z', now)).toBe('5 minutes ago')
        expect(relativeTime('2026-10-08T11:00:00Z', now)).toBe('1 hour ago')
        expect(relativeTime('2026-10-07T12:00:00Z', now)).toBe('yesterday')
        expect(relativeTime('2026-10-05T12:00:00Z', now)).toBe('3 days ago')
        expect(relativeTime('not a date', now)).toBe('')
    })

    it('opens each flow type in its own canvas', () => {
        expect(canvasPathFor('AGENTFLOW', 'a')).toBe('/v2/agentcanvas/a')
        expect(canvasPathFor('MULTIAGENT', 'a')).toBe('/agentcanvas/a')
        expect(canvasPathFor('HARNESS', 'a')).toBe('/harnesscanvas/a')
        expect(canvasPathFor('ETL', 'a')).toBe('/etlcanvas/a')
        expect(canvasPathFor('CHATFLOW', 'a b')).toBe('/canvas/a%20b')
    })

    it('outlines added and changed nodes without touching the input', () => {
        const nodes = [
            { id: 'a', data: {} },
            { id: 'b', data: {}, style: { width: 10 } },
            { id: 'c', data: {} }
        ]
        const out = decorateNodes(nodes, { added: [{ id: 'a', label: 'A' }], changed: [{ id: 'b', label: 'B', fields: [] }] })
        expect(out[0].style.outline).toContain('#2e7d32')
        expect(out[0].data.versionChange).toBe('added')
        expect(out[1].style).toMatchObject({ width: 10 })
        expect(out[1].style.outline).toContain('#ed6c02')
        expect(out[2]).toBe(nodes[2])
        expect(nodes[0].style).toBeUndefined()
        expect(decorateNodes(nodes, null)).toBe(nodes)
        expect(decorateNodes(undefined, null)).toEqual([])
    })

    it('names changed fields in plain words', () => {
        expect(fieldLabel('inputs.systemMessage')).toBe('system message')
        expect(fieldLabel('systemMessage')).toBe('system message')
        expect(fieldLabel('max_tokens')).toBe('max tokens')
        expect(fieldLabel('label')).toBe('name')
        expect(fieldLabel('definition')).toBe('component version')
    })

    it('describes a diff against the previous version and against now', () => {
        const diff = {
            added: [{ id: 'n2', label: 'Calculator' }],
            removed: [{ id: 'n3', label: 'Web Search' }],
            changed: [{ id: 'n1', label: 'Harness Prime', fields: ['inputs.instructions'] }],
            moved: [],
            edgesChanged: true,
            renamed: { from: 'Old', to: 'New' }
        }
        expect(describeDiff(diff, 'previous').map((line) => line.text)).toEqual([
            'Name: "Old" to "New"',
            'Added Calculator',
            'Changed Harness Prime: instructions',
            'Removed Web Search',
            'Rewired connections'
        ])
        const now = describeDiff(diff, 'current').map((line) => line.text)
        expect(now).toContain('Calculator is in this version, not now')
        expect(now).toContain('Web Search is there now, not in this version')
        const onlyMoved = { added: [], removed: [], changed: [], moved: ['n1'], edgesChanged: false, renamed: null }
        expect(describeDiff(onlyMoved)).toEqual([{ status: 'moved', text: 'Only node positions changed: 1 node' }])
        const nodes = [
            { id: 'n1', data: { label: 'Buffer Memory' } },
            { id: 'n2', data: { label: 'ChatOpenAI' } }
        ]
        expect(describeDiff(onlyMoved, 'current', nodes)).toEqual([
            { status: 'moved', text: 'Only positions differ from now: Buffer Memory' }
        ])
        // A move is listed next to other changes too.
        const both = { ...onlyMoved, changed: [{ id: 'n2', label: 'ChatOpenAI', fields: ['credential'] }] }
        expect(describeDiff(both, 'current', nodes).map((line) => line.text)).toEqual([
            'ChatOpenAI differs from now: credential',
            'In a different place now: Buffer Memory'
        ])
        expect(describeDiff(both, 'previous', nodes).map((line) => line.text)).toEqual([
            'Changed ChatOpenAI: credential',
            'Moved Buffer Memory'
        ])
        expect(describeDiff(null)).toEqual([])
    })
})

describe('backPathFor', () => {
    test('uses the first known type: the version, then the type passed from the drawer, then the flow', () => {
        expect(backPathFor('id-1', 'HARNESS', 'CHATFLOW')).toBe('/harnesscanvas/id-1')
        expect(backPathFor('id-1', undefined, 'AGENTFLOW', 'CHATFLOW')).toBe('/v2/agentcanvas/id-1')
        expect(backPathFor('id-1', undefined, undefined, 'ETL')).toBe('/etlcanvas/id-1')
    })

    test('is null until a type is known, so the button waits instead of opening the wrong editor', () => {
        expect(backPathFor('id-1', undefined, null, '')).toBeNull()
    })
})

describe('restoreMessage', () => {
    test('names each outcome of a restore', () => {
        expect(restoreMessage({ unchanged: true })).toEqual({ message: 'The flow already matches this version.', variant: 'info' })
        expect(restoreMessage({ unchanged: false, recorded: true, missingCredentials: [] }).variant).toBe('success')
        expect(restoreMessage({ unchanged: false, recorded: true, missingCredentials: [{ name: 'OpenAI main' }] }).message).toBe(
            'Restored. Add these credentials before running it: OpenAI main.'
        )
        expect(restoreMessage({ unchanged: false, recorded: false, historyError: 'git was not found on PATH.' })).toEqual({
            message: 'Restored, but history could not record it. git was not found on PATH.',
            variant: 'warning'
        })
    })
})

describe('version authors', () => {
    const dana1 = { sha: 'a', author: 'Dana Lee', authorId: 'u-1', authorKind: 'user', date: '2026-10-08T08:00:00Z' }
    const system = { sha: 'b', author: 'Cuttlely', authorId: null, authorKind: 'system', date: '2026-10-08T07:00:00Z' }
    const pat = { sha: 'c', author: 'Pat', authorId: 'u-2', authorKind: 'user', date: '2026-10-08T06:00:00Z' }
    const dana2 = { ...dana1, sha: 'd' }
    const versions = [dana1, system, pat, dana2]

    test('names a user, and labels API key and system saves', () => {
        expect(authorLabel(dana1)).toBe('Dana Lee')
        expect(authorLabel(system)).toBe('Cuttlely (API key or system)')
        // History written before authors were recorded reads as Cuttlely.
        expect(authorLabel({ author: 'Cuttlely' })).toBe('Cuttlely (API key or system)')
    })

    test('lists each person once, newest first, and filters by person', () => {
        expect(authorOptions(versions)).toEqual([
            { key: 'user:u-1', label: 'Dana Lee' },
            { key: 'system', label: 'Cuttlely (API key or system)' },
            { key: 'user:u-2', label: 'Pat' }
        ])
        expect(filterByAuthor(versions, 'user:u-1').map((v) => v.sha)).toEqual(['a', 'd'])
        expect(filterByAuthor(versions, 'system').map((v) => v.sha)).toEqual(['b'])
        expect(filterByAuthor(versions, 'all')).toBe(versions)
    })

    test('says who edited last and when', () => {
        expect(lastEditedText(dana1, new Date('2026-10-08T08:05:00Z').getTime())).toBe(
            `Last edited by Dana Lee, ${relativeTime(dana1.date, new Date('2026-10-08T08:05:00Z').getTime())}`
        )
        expect(lastEditedText(null)).toBe('')
        expect(lastEditedVersion({ versions })).toBe(dana1)
        // A failed history write means the newest version is not the latest edit.
        expect(lastEditedVersion({ versions, lastError: 'Not saved to history: secret-shaped text' })).toBeNull()
        expect(lastEditedVersion({ versions: [] })).toBeNull()
    })
})

describe('ambiguousCredentialText', () => {
    test('says which credential is used when several share a name', () => {
        expect(ambiguousCredentialText([{ name: 'OpenAI main', credentialName: 'openAIApi', count: 2, using: 'current' }])).toBe(
            '2 credentials are named OpenAI main. This version uses the one the flow uses now.'
        )
        expect(ambiguousCredentialText([{ name: 'OpenAI main', credentialName: 'openAIApi', count: 3, using: 'oldest' }])).toBe(
            '3 credentials are named OpenAI main. None is in use, so this version uses the oldest one.'
        )
        expect(ambiguousCredentialText([])).toBe('')
        expect(ambiguousCredentialText(undefined)).toBe('')
    })
})

describe('hidden secrets', () => {
    const one = { node: 'n1', label: 'Conversation Chain', input: 'systemMessagePrompt', inputLabel: 'System Message', count: 1 }
    test('the history note counts hidden values', () => {
        expect(hiddenNote({ hiddenSecrets: 1 })).toBe('1 secret-looking value was hidden from history')
        expect(hiddenNote({ hiddenSecrets: 3 })).toBe('3 secret-looking values were hidden from history')
        expect(hiddenNote({ hiddenSecrets: 0 })).toBe('')
        expect(hiddenNote({})).toBe('')
    })
    test('the version warning says where and what is there instead', () => {
        expect(hiddenSecretText([one])).toBe(
            `1 secret-looking value was hidden from history: Conversation Chain (System Message). This version has ${SECRET_PLACEHOLDER} there instead. Replace it before you run this version, and keep keys in a credential.`
        )
        expect(hiddenSecretText([])).toBe('')
    })
    test('a restore of such a version warns, alone or with missing credentials', () => {
        expect(restoreMessage({ recorded: true, hiddenSecrets: [one] })).toEqual({
            message: `Restored. Replace ${SECRET_PLACEHOLDER} in Conversation Chain (System Message) before running it.`,
            variant: 'warning'
        })
        expect(restoreMessage({ recorded: true, missingCredentials: [{ name: 'OpenAI trial' }], hiddenSecrets: [one] }).message).toBe(
            `Restored. Add these credentials before running it: OpenAI trial. Replace ${SECRET_PLACEHOLDER} in Conversation Chain (System Message) before running it.`
        )
    })
})
