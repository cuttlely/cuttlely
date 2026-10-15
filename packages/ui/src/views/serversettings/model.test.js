import {
    cleanDrafts,
    describeValue,
    effectiveValues,
    fromDisplay,
    groupSettings,
    historyLine,
    isShown,
    matchesQuery,
    limitedByLabel,
    reviewApplyNote,
    reviewRows,
    sectionCounts,
    toDisplay,
    visibleProblems
} from './model'

const settings = [
    {
        key: 'CUTTLELY_VERSIONS',
        section: 'advanced',
        label: 'Version history',
        help: 'Keep versions',
        type: 'switch',
        on: 'on',
        off: 'off',
        defaultLabel: 'On',
        defaultValue: 'on',
        value: '',
        effective: 'on'
    },
    {
        key: 'DATABASE_TYPE',
        section: 'database',
        label: 'Database',
        help: '',
        type: 'select',
        options: [
            { value: 'sqlite', label: 'SQLite' },
            { value: 'postgres', label: 'Postgres' }
        ],
        defaultLabel: 'SQLite',
        defaultValue: 'sqlite',
        value: '',
        effective: 'sqlite'
    },
    {
        key: 'DATABASE_HOST',
        section: 'database',
        group: 'Postgres',
        label: 'Host',
        help: '',
        type: 'text',
        defaultLabel: 'none',
        value: '',
        effective: '',
        showWhen: { key: 'DATABASE_TYPE', equals: ['postgres'] }
    },
    {
        key: 'CUTTLELY_HARNESS_TURN_BUDGET_MS',
        section: 'runtime',
        label: 'Turn budget',
        help: '',
        type: 'number',
        unit: 'ms-as-seconds',
        defaultLabel: '5 minutes',
        value: '90000',
        effective: '90000',
        changed: true
    },
    {
        key: 'WORKOS_API_KEY',
        section: 'signin',
        label: 'API key',
        help: '',
        type: 'secret',
        defaultLabel: 'Not set',
        secret: { set: true, unreadable: false }
    },
    {
        key: 'LOG_LEVEL',
        section: 'advanced',
        label: 'Log level',
        help: '',
        type: 'select',
        options: [],
        defaultLabel: 'info',
        value: 'warn',
        locked: true
    }
]

describe('server settings page logic', () => {
    it('shows milliseconds as seconds and saves them back as milliseconds', () => {
        expect(toDisplay(settings[3], '90000')).toBe('90')
        expect(fromDisplay(settings[3], '1.5')).toBe('1500')
        expect(fromDisplay(settings[3], ' ')).toBe('')
    })

    it('applies drafts to conditions', () => {
        expect(isShown(settings[2], effectiveValues(settings, {}))).toBe(false)
        expect(isShown(settings[2], effectiveValues(settings, { DATABASE_TYPE: 'postgres' }))).toBe(true)
    })

    it('drops drafts that change nothing or touch locked settings', () => {
        expect(cleanDrafts(settings, { CUTTLELY_VERSIONS: '', LOG_LEVEL: 'debug', DATABASE_TYPE: 'postgres' })).toEqual({
            DATABASE_TYPE: 'postgres'
        })
    })

    it('describes values in words and secrets without values', () => {
        expect(describeValue(settings[0], 'off')).toBe('Off')
        expect(describeValue(settings[0], '')).toBe('Default (On)')
        expect(describeValue(settings[1], 'postgres')).toBe('Postgres')
        expect(describeValue(settings[3], '90000')).toBe('90 seconds')
        const rows = reviewRows(settings, { WORKOS_API_KEY: 'sk_test_fake_value', CUTTLELY_VERSIONS: 'off' })
        expect(rows).toEqual([
            { key: 'WORKOS_API_KEY', label: 'API key', section: 'signin', secret: 'replaced', runtime: false },
            { key: 'CUTTLELY_VERSIONS', label: 'Version history', section: 'advanced', from: 'Default (On)', to: 'Off', runtime: false }
        ])
        const limit = {
            key: 'CUTTLELY_CHECK_CONCURRENCY',
            section: 'integrations',
            label: 'Questions at once',
            type: 'number',
            unit: 'count',
            defaultLabel: '2',
            defaultValue: '2',
            value: '2',
            runtime: true
        }
        const mixed = reviewRows([...settings, limit], { CUTTLELY_CHECK_CONCURRENCY: '4', CUTTLELY_VERSIONS: 'off' })
        expect(mixed.find((row) => row.key === 'CUTTLELY_CHECK_CONCURRENCY')).toMatchObject({ runtime: true, from: '2', to: '4' })
        expect(mixed.find((row) => row.key === 'CUTTLELY_VERSIONS').runtime).toBe(false)
        expect(reviewApplyNote(mixed.filter((row) => row.runtime))).toBe('These limits apply on the next use.')
        expect(reviewApplyNote(mixed)).toBe('Limits apply now. The rest apply at restart.')
        expect(reviewApplyNote(mixed.filter((row) => !row.runtime))).toMatch(/next start/)
        expect(limitedByLabel({ source: 'bounded', boundedBy: 'CUTTLELY_CHECK_COUNT_MAX' })).toBe('Limited by CUTTLELY_CHECK_COUNT_MAX')
        expect(limitedByLabel({ source: 'host' })).toBe('')
        expect(limitedByLabel({ source: 'bounded' })).toBe('')
        expect(JSON.stringify(rows)).not.toContain('sk_test_fake_value')
        expect(reviewRows(settings, { WORKOS_API_KEY: '' })[0].secret).toBe('removed')
    })

    it('searches labels, help, names and option labels', () => {
        expect(settings.filter((s) => matchesQuery(s, 'postgres')).map((s) => s.key)).toEqual(['DATABASE_TYPE', 'DATABASE_HOST'])
        expect(settings.filter((s) => matchesQuery(s, 'workos')).map((s) => s.key)).toEqual(['WORKOS_API_KEY'])
    })

    it('counts edits and changes waiting for a restart per section', () => {
        const counts = sectionCounts(settings, { CUTTLELY_VERSIONS: 'off' })
        expect(counts.advanced).toEqual({ edited: 1, pending: 0, total: 2 })
        expect(counts.runtime.pending).toBe(1)
    })

    it('groups settings and words history entries', () => {
        expect(groupSettings(settings.slice(1, 3)).map((g) => g.name)).toEqual(['', 'Postgres'])
        expect(historyLine({ kind: 'save', by: 'owner@example.com', changes: [{}, {}] })).toBe('Saved 2 changes by owner@example.com')
        expect(historyLine({ kind: 'rollback' })).toMatch(/Safe boot/)
    })
})

describe('test connection', () => {
    const { TEST_SECTIONS, testDrafts, testKindFor, testSignature } = jest.requireActual('./model')
    const rows = [
        { key: 'CUTTLELY_POSTGRES_URL', section: 'analyst', type: 'secret', secret: { set: false } },
        { key: 'DATABASE_NAME', section: 'database', type: 'text', value: 'cuttlely' },
        { key: 'S3_STORAGE_REGION', section: 'storage', type: 'text', value: '' },
        { key: 'S3_STORAGE_BUCKET_NAME', section: 'storage', type: 'text', value: '', locked: true }
    ]

    it('offers a test in analyst, storage and models only', () => {
        expect(['signin', 'database', 'analyst', 'storage', 'models', 'security'].map(testKindFor)).toEqual([
            null,
            null,
            'analyst',
            'storage',
            'models',
            null
        ])
        expect(TEST_SECTIONS.analyst).toEqual(['analyst', 'database'])
    })

    it('sends only the changes the test reads, never locked ones', () => {
        const drafts = {
            CUTTLELY_POSTGRES_URL: 'postgres://made-up',
            DATABASE_NAME: 'bakery',
            S3_STORAGE_REGION: 'us-east-2',
            S3_STORAGE_BUCKET_NAME: 'x'
        }
        expect(testDrafts(rows, drafts, 'analyst')).toEqual({ CUTTLELY_POSTGRES_URL: 'postgres://made-up', DATABASE_NAME: 'bakery' })
        expect(testDrafts(rows, drafts, 'storage')).toEqual({ S3_STORAGE_REGION: 'us-east-2' })
    })

    it('marks a result stale when the values change, without keeping secrets', () => {
        const first = testSignature(rows, { CUTTLELY_POSTGRES_URL: 'postgres://made-up-1' }, 'analyst')
        expect(first).not.toContain('made-up')
        expect(testSignature(rows, { CUTTLELY_POSTGRES_URL: 'postgres://made-up-2' }, 'analyst')).not.toBe(first)
        expect(testSignature(rows, { S3_STORAGE_REGION: 'eu-west-1' }, 'analyst')).toBe(testSignature(rows, {}, 'analyst'))
    })
})

describe('visibleProblems', () => {
    const problems = ['Put back the last settings that started (rolled-back file kept).', 'A value in the file was ignored.']
    it('drops the notice the safe boot banner already gives', () => {
        expect(visibleProblems({ rolledBack: true, file: { problems } })).toEqual([problems[1]])
    })
    it('keeps every notice when safe boot did not run', () => {
        expect(visibleProblems({ rolledBack: false, file: { problems } })).toEqual(problems)
        expect(visibleProblems(undefined)).toEqual([])
    })
})
