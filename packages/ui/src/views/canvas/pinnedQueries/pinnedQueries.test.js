import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import { FreeSqlNote, PinnedQueriesView } from './PinnedQueriesView'
import {
    FREE_SQL_LABEL,
    FREE_SQL_NUDGE,
    addLimit100,
    applySuggestions,
    canvasFor,
    clearTest,
    editorFromPin,
    entryFromEditor,
    mergeTestedPin,
    messageFrom,
    needsRetestMark,
    pinWarning,
    readPins,
    removeTrailingSemicolon,
    showFreeSql,
    slugFromPurpose,
    specialistPinTotal,
    syncParams,
    toolName,
    uniqueSlug
} from './model'

const noop = () => {}
const render = (props) =>
    renderToStaticMarkup(
        createElement(ThemeProvider, { theme: createTheme() }, createElement(PinnedQueriesView, { onAdd: noop, ...props }))
    )

const openingTag = (html, testId) => {
    const marker = `data-testid="${testId}"`
    const at = html.indexOf(marker)
    if (at < 0) return ''
    const start = html.lastIndexOf('<', at)
    const end = html.indexOf('>', at)
    return html.slice(start, end + 1)
}

const editor = {
    id: 'pin-1',
    slug: 'revenue_by_region',
    purpose: 'Revenue by region',
    description: 'Revenue by region for demo_sales',
    sql: 'SELECT region FROM demo_sales WHERE region = :region LIMIT 100;',
    params: [{ name: 'region', type: '', required: true }],
    samples: { region: '' },
    rowCap: '',
    version: 1,
    needsRetest: true
}

const result = {
    rowCount: 2,
    timeMs: 12,
    possiblyTruncated: true,
    columns: [{ name: 'region', type: 'text' }],
    rows: [{ region: 'east' }, { region: 'west' }],
    guard: ['The read-only check passed.', 'The row count equals the statement LIMIT, so the result is possibly truncated.'],
    tool: { name: 'pq_revenue_by_region', description: 'Revenue by region', inputSchema: { type: 'object' } }
}

describe('pinned query dialog', () => {
    test('stays hidden when the server flag is off', () => {
        expect(render({ enabled: false, pins: [{ id: 'pin-1', name: 'pq_revenue_by_region' }] })).toBe('')
    })

    test('shows Add, a fixed pq_ prefix, a blank type, and collapsed advanced', () => {
        const html = render({ enabled: true, pins: [], editor })
        expect(html).toContain('Add')
        expect(html).toContain('>pq_<')
        expect(html).toContain('value="revenue_by_region"')
        expect(html).not.toContain('value="pq_revenue_by_region"')
        expect(html).toContain('Choose a type')
        const typeAt = html.indexOf('data-testid="type-region"')
        const typeHtml = html.slice(typeAt, html.indexOf('</select>', typeAt))
        const selected = typeHtml.match(/<option[^>]*selected[^>]*>/)
        expect(selected).not.toBeNull()
        expect(selected[0]).toContain('value=""')
        expect(typeHtml.match(/selected/g)).toHaveLength(1)
        expect(openingTag(html, 'required-region')).toContain('checked')
        expect(html).toContain('Remove trailing semicolon')
        expect(html).toContain('Add LIMIT 100')
        expect(html).toContain('Test &amp; save')
        expect(openingTag(html, 'advanced')).not.toContain(' open')
        expect(html).toContain('data-testid="editor-needs-retest"')
    })

    test('shows rows, columns, the guard, and a collapsed tool preview', () => {
        const html = render({
            enabled: true,
            pins: [
                { id: 'pin-1', name: 'pq_revenue_by_region', needsRetest: true },
                { id: 'pin-2', name: 'pq_top_products', columnsChanged: true }
            ],
            editor,
            warning: pinWarning(9),
            result
        })
        expect(html).toContain('2 rows in 12 ms')
        expect(html).toContain('region text')
        expect(html).toContain('possibly truncated')
        expect(html).toContain('The read-only check passed.')
        expect(html).toContain('east')
        expect(openingTag(html, 'tool-preview')).not.toContain(' open')
        expect(html).toContain('pq_revenue_by_region')
        expect(html.split('Needs re-test').length - 1).toBe(3)
        expect(html).toContain('This specialist has 9 pinned queries')
    })

    test('uses the free SQL label and nudge for the existing query tick', () => {
        const html = renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, createElement(FreeSqlNote)))
        expect(html).toContain(FREE_SQL_NUDGE)
        expect(FREE_SQL_LABEL).toBe('Allow free SQL (query + describe)')
        const data = {
            name: 'postgreSQLMCP',
            inputs: { pinnedQueries: [{ id: 'pin-1', name: 'pq_revenue_by_region' }] }
        }
        expect(showFreeSql(data, 'mcpActions', true)).toBe(true)
        expect(showFreeSql(data, 'mcpActions', false)).toBe(false)
        expect(showFreeSql(data, 'analystRowCap', true)).toBe(false)
        expect(showFreeSql({ ...data, inputs: {} }, 'mcpActions', true)).toBe(false)
    })
})

describe('pinned query editor model', () => {
    test('removes one trailing semicolon and adds a top-level LIMIT', () => {
        expect(removeTrailingSemicolon('SELECT 1 FROM demo_sales LIMIT 1;')).toBe('SELECT 1 FROM demo_sales LIMIT 1')
        expect(removeTrailingSemicolon("SELECT ';' FROM demo_sales LIMIT 1")).toBe("SELECT ';' FROM demo_sales LIMIT 1")
        const commented = 'SELECT amount FROM demo_sales -- LIMIT 5\n'
        expect(addLimit100(commented)).toBe('SELECT amount FROM demo_sales -- LIMIT 5\nLIMIT 100')
        expect(addLimit100('SELECT amount FROM demo_sales LIMIT 10;')).toBe('SELECT amount FROM demo_sales LIMIT 10;')
        expect(addLimit100("SELECT 'LIMIT 5' AS label FROM demo_sales;")).toBe("SELECT 'LIMIT 5' AS label FROM demo_sales\nLIMIT 100")
    })

    test('keeps the slug, requires new parameters, and does not invent a text type', () => {
        expect(slugFromPurpose('Revenue by region!')).toBe('revenue_by_region')
        expect(toolName('Revenue')).toBe('pq_revenue')
        expect(uniqueSlug('query', [{ name: 'pq_query' }])).toBe('query_2')
        expect(syncParams('SELECT $tag$ :hidden $tag$, :region FROM demo_sales', []).map((param) => param.name)).toEqual(['region'])
        const params = syncParams('SELECT :region, :month FROM demo_sales', [{ name: 'region', type: 'text', required: false }])
        expect(params).toEqual([
            { name: 'region', type: 'text', required: false },
            { name: 'month', type: '', required: true }
        ])
        expect(
            applySuggestions(params, [
                { name: 'month', type: null },
                { name: 'region', type: 'date' }
            ])[1]
        ).toEqual({
            name: 'month',
            type: '',
            required: true
        })
        expect(applySuggestions(params, [{ name: 'month', type: 'int8' }])[1].type).toBe('int8')
    })

    test('clears the stamp once when the statement changes and warns per specialist', () => {
        const stamped = clearTest({ testedStamp: 'abc', version: 2, sql: 'SELECT 1' })
        expect(stamped.testedStamp).toBeUndefined()
        expect(stamped.version).toBe(3)
        expect(stamped.needsRetest).toBe(true)
        expect(clearTest(stamped).version).toBe(3)
        expect(needsRetestMark({ columnsChanged: true })).toBe(true)
        const pins = Array.from({ length: 6 }, (_item, index) => ({ id: `p${index}`, name: `pq_${index}` }))
        const nodes = [
            { id: 'pg_0', data: { name: 'postgreSQLMCP', inputs: { pinnedQueries: pins.slice(0, 3) } } },
            { id: 'pg_1', data: { name: 'postgreSQLMCP', inputs: { pinnedQueries: JSON.stringify(pins) } } },
            { id: 'spec_0', data: { name: 'harnessSpecialist' } }
        ]
        const edges = [
            { source: 'pg_0', target: 'spec_0' },
            { source: 'pg_1', target: 'spec_0' }
        ]
        expect(specialistPinTotal(nodes, edges, 'pg_0')).toBe(9)
        expect(pinWarning(8)).toBe('')
        expect(pinWarning(9)).toContain('9 pinned queries')
        expect(readPins(JSON.stringify(pins))).toHaveLength(6)
        const saved = mergeTestedPin(pins, { id: 'p0', name: 'pq_0', testedStamp: 'stamp' })
        expect(saved[0].testedStamp).toBe('stamp')
        expect(saved).toHaveLength(6)
        expect(messageFrom({ response: { data: { message: `refused ${'postgres://demo:secret@127.0.0.1/zz'}` } } })).toBe(
            'refused [hidden]'
        )
    })
})

test('ZZ-TEST- canvasFor sends the unsaved credential and guard inputs only', () => {
    const data = {
        credential: 'cred-zz-test',
        inputs: {
            analystRelations: '["demo_sales"]',
            analystRowCap: '10',
            pinnedQueries: [],
            postgresUrl: 'postgres://zz-test.example/demo_sales',
            mcpActions: ['query']
        }
    }
    expect(canvasFor(data)).toEqual({
        credential: 'cred-zz-test',
        inputs: { analystRelations: '["demo_sales"]', analystRowCap: '10', pinnedQueries: [] }
    })
    expect(canvasFor({ inputs: {} })).toEqual({ credential: '', inputs: {} })
})

test('ZZ-TEST- a bool parameter saves its default and allowed values as booleans', () => {
    const editor = {
        slug: 'zz_test_active',
        purpose: 'ZZ-TEST- active rows',
        sql: 'SELECT id FROM demo_sales WHERE active = :active',
        params: [
            { name: 'active', type: 'bool', required: false, default: 'false', allowedValues: 'true, false' },
            { name: 'region', type: 'text', required: false, default: 'false', allowedValues: 'true, EU' }
        ]
    }
    const entry = entryFromEditor(editor)
    expect(entry.params[0]).toEqual({ name: 'active', type: 'bool', required: false, default: false, allowedValues: [true, false] })
    expect(entry.params[1]).toEqual({ name: 'region', type: 'text', required: false, default: 'false', allowedValues: ['true', 'EU'] })
    expect(entryFromEditor(editorFromPin({ ...entry, id: 'zz-test-1' })).params).toEqual(entry.params)
})
