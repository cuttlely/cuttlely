import { functionLines, pinnedQueriesEnabled, sameSpec, scanParamNames, stampAllowedFunctions, statementLimit, uncastCompiled } from './sql'

describe('pinned query request checks', () => {
    it('leaves ($10) whole when substitutions are parenthesised', () => {
        const casts = Array.from({ length: 10 }, (_item, index) => `($${index + 1}::pg_catalog.text)`).join(', ')
        const run = `SELECT ${casts}, note || '$1' AS label FROM demo_sales LIMIT 5`
        const { uncast, check } = uncastCompiled(
            run,
            Array.from({ length: 10 }, (_item, index) => `p${index + 1}`)
        )
        expect(uncast).toBe(
            "SELECT ($1), ($2), ($3), ($4), ($5), ($6), ($7), ($8), ($9), ($10), note || '$1' AS label FROM demo_sales LIMIT 5"
        )
        expect(check).toBe(
            "SELECT (NULL::pg_catalog.text), (NULL::pg_catalog.text), (NULL::pg_catalog.text), (NULL::pg_catalog.text), (NULL::pg_catalog.text), (NULL::pg_catalog.text), (NULL::pg_catalog.text), (NULL::pg_catalog.text), (NULL::pg_catalog.text), (NULL::pg_catalog.text), note || '$1' AS label FROM demo_sales LIMIT 5"
        )
        expect(uncast).toContain('($10)')
        expect(uncast).not.toContain('$10::')
    })

    it('reads names outside quotes, comments, casts and dollar quotes', () => {
        const sql = [
            "SELECT ':hidden' AS label, amount::numeric, $tag$ :also $tag$,",
            '/* :nope */ -- :nope',
            ':region',
            'FROM demo_sales WHERE month = :month LIMIT 10'
        ].join('\n')
        expect(scanParamNames(sql)).toEqual(['region', 'month'])
    })

    it('treats a missing required flag as required', () => {
        const entry = {
            sql: 'SELECT 1 FROM demo_sales LIMIT 1',
            params: [{ name: 'region', type: 'text', required: true }]
        }
        expect(sameSpec({ sql: entry.sql, params: [{ name: 'region', type: 'text' }] }, entry as any)).toBe(true)
        expect(sameSpec({ sql: entry.sql, params: [{ name: 'region', type: 'text', required: false }] }, entry as any)).toBe(false)
    })

    it('reads a trailing LIMIT and drops a templated function list', () => {
        expect(statementLimit('SELECT 1 FROM demo_sales LIMIT 100')).toBe(100)
        expect(statementLimit('SELECT 1 FROM demo_sales LIMIT 100 OFFSET 20')).toBe(100)
        expect(statementLimit('SELECT 1 FROM demo_sales')).toBeNull()
        expect(functionLines('public.lower(text)\n# note')).toEqual(['public.lower(text)'])
        expect(functionLines('public.lower(text)\n{{secret}}')).toEqual([])
        expect(functionLines('public.lower($vars.fn)')).toEqual([])
        expect(stampAllowedFunctions('public.lower(text)\n# note')).toEqual(['public.lower(text)', '# note'])
        expect(stampAllowedFunctions('public.lower(text)\n{{secret}}')).toEqual([])
        expect(stampAllowedFunctions('public.lower($vars.fn)')).toEqual([])
    })

    it('enables the flag only for 1 and true', () => {
        expect(pinnedQueriesEnabled({} as NodeJS.ProcessEnv)).toBe(false)
        expect(pinnedQueriesEnabled({ CUTTLELY_PINNED_QUERIES: 'TRUE' } as NodeJS.ProcessEnv)).toBe(false)
        expect(pinnedQueriesEnabled({ CUTTLELY_PINNED_QUERIES: 'yes' } as NodeJS.ProcessEnv)).toBe(false)
        expect(pinnedQueriesEnabled({ CUTTLELY_PINNED_QUERIES: '1' } as NodeJS.ProcessEnv)).toBe(true)
        expect(pinnedQueriesEnabled({ CUTTLELY_PINNED_QUERIES: 'true' } as NodeJS.ProcessEnv)).toBe(true)
    })
})
