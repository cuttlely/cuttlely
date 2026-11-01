import { POSTGRES_GROUPS, displayParam, isPostgresPanel, postgresGroups, setCount } from './postgresPanel'

// Field names as the Postgres (MCP) node defines them. Labels and values are made up.
const params = () => [
    { name: 'credential', label: 'Connect Credential', type: 'credential' },
    { name: 'mcpActions', label: 'Available Actions', type: 'asyncMultiOptions' },
    { name: 'analystRelations', label: 'Tables and views', type: 'asyncMultiOptions' },
    { name: 'analystRules', label: 'Rules', type: 'string' },
    { name: 'analystAllowedFunctions', label: 'Allowed functions', type: 'string', additionalParams: true },
    { name: 'analystRowCap', label: 'Row cap', type: 'number', additionalParams: true },
    { name: 'analystTimeoutSeconds', label: 'Query timeout (seconds)', type: 'number', additionalParams: true },
    { name: 'allowPinDefinitions', label: 'Expose pinned SQL definitions', type: 'boolean', additionalParams: true },
    { name: 'pinnedQueries', label: 'Pinned queries', type: 'json', additionalParams: true },
    { name: 'zzFutureField', label: 'Future field', type: 'string' }
]

describe('Postgres (MCP) panel groups', () => {
    it('applies only to the Postgres tool', () => {
        expect(isPostgresPanel({ name: 'postgreSQLMCP' })).toBe(true)
        expect(isPostgresPanel({ name: 'githubMCP' })).toBe(false)
    })

    it('groups every field once, folds Limits and Advanced, and puts unknown fields under Advanced', () => {
        const data = { name: 'postgreSQLMCP', inputParams: params(), inputs: {} }
        const groups = postgresGroups(data)
        expect(groups.map((group) => group.title)).toEqual(['Data source', 'What it can see', 'Model', 'Limits', 'Advanced'])
        expect(POSTGRES_GROUPS.filter((group) => group.collapsed).map((group) => group.title)).toEqual(['Limits', 'Advanced'])
        const names = groups.flatMap((group) => group.fields.map((field) => field.name))
        expect(names.sort()).toEqual(
            params()
                .map((param) => param.name)
                .filter((name) => name !== 'pinnedQueries')
                .sort()
        )
        expect(groups[4].fields.map((field) => field.name)).toContain('zzFutureField')
    })

    it('shows friendlier labels and placeholders on copies, never on the saved fields', () => {
        const data = { name: 'postgreSQLMCP', inputParams: params(), inputs: {} }
        const before = JSON.stringify(data)
        const groups = postgresGroups(data)
        const all = Object.fromEntries(groups.flatMap((group) => group.fields).map((field) => [field.name, field]))
        expect(all.credential.label).toBe('Database connection')
        expect(all.mcpActions.label).toBe('Tools it can use')
        expect(all.analystRules.label).toBe('Notes for the analyst')
        expect(all.analystRowCap.label).toBe('Most rows per query')
        expect(all.analystRowCap.placeholder).toBe('Server limit (100 by default)')
        expect(all.analystTimeoutSeconds.placeholder).toBe('Server limit (15 by default)')
        expect(all.allowPinDefinitions.label).toBe('Let the analyst read saved query SQL')
        expect(all.analystRowCap.description).toContain('Saved as "Row cap".')
        expect(JSON.stringify(data)).toBe(before)
        expect(displayParam(data.inputParams[9])).toBe(data.inputParams[9])
    })

    it('hides the table picker only when asked, as in sandbox mode', () => {
        const data = { name: 'postgreSQLMCP', inputParams: params(), inputs: {} }
        const see = (opts) => postgresGroups(data, opts)[1].fields.map((field) => field.name)
        expect(see()).toContain('analystRelations')
        expect(see({ hide: ['analystRelations'] })).not.toContain('analystRelations')
    })

    it('counts the fields set in a folded group', () => {
        const data = { name: 'postgreSQLMCP', inputParams: params(), inputs: { analystRowCap: 50, analystTimeoutSeconds: '' } }
        expect(setCount(postgresGroups(data)[3], data.inputs)).toBe(1)
    })
})
