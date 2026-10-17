import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import {
    SCOPE_NONE_LEFT,
    SCOPE_ONLY_SELECT,
    ambiguousRelations,
    columnErrorHint,
    columnList,
    deniedFunction,
    describeRefusal,
    resetRiskyDomainCacheForTests,
    SAMPLE_TIMEOUT_MS,
    findRelation,
    parseRelationSelection,
    relationLine,
    relationToolNote,
    treeObjectIds
} from '../packages/harness/runtime/analyst-relations.mjs'
import {
    analystDescribeToolSpec,
    analystUrlRelations,
    analystUrlToolSpec,
    describeAnalystUrlRelation,
    listAnalystUrlRelations,
    queryAnalystUrl
} from '../packages/harness/runtime/analyst-store.mjs'

const { Client } = pg
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BAKERY_SQL = path.join(ROOT, 'samples', 'demo', 'bakery', 'bakery-postgres.sql')
const NODE_SOURCE = path.join(ROOT, 'packages', 'components', 'nodes', 'tools', 'MCP', 'PostgreSQL', 'PostgreSQLMCP.ts')
const NODE_BUILD = path.join(ROOT, 'packages', 'components', 'dist', 'nodes', 'tools', 'MCP', 'PostgreSQL', 'PostgreSQLMCP.js')

// The routing a builder would pick for the bakery: views first, plus the account table to look codes up.
const SELECTION = [
    'public.monthly_sales',
    'public.top_products',
    'public.account_balances',
    'public.weekly_store_revenue',
    'public.wholesale_accounts',
    'public.stores'
]

const sample = [
    {
        name: 'public.monthly_sales',
        kind: 'materialized view',
        oid: 1,
        columns: 6,
        columnNames: ['month', 'store', 'product', 'category', 'units', 'revenue'],
        comment: 'Shop sales per month, shop and product.'
    },
    { name: 'public.stores', kind: 'table', oid: 2, columns: 4, columnNames: ['id', 'name', 'town', 'opened_on'], comment: '' },
    { name: '"Odd Name".daily', kind: 'view', oid: 3, columns: 1, columnNames: ['"Day"'], comment: 'x'.repeat(300) }
]
const wide = {
    name: 'public.wide',
    kind: 'table',
    oid: 4,
    columns: 14,
    columnNames: Array.from({ length: 14 }, (_, i) => `c${i + 1}`),
    comment: ''
}

// The project's prompt estimate: ceil(characters / 4).
const tokens = (text) => Math.ceil(String(text).length / 4)

describe('analyst relations: pure helpers', () => {
    it('reads a saved selection from JSON, an array, or nothing', () => {
        assert.deepEqual(parseRelationSelection('["public.a","public.b","public.a"]'), ['public.a', 'public.b'])
        assert.deepEqual(parseRelationSelection(['public.a', '', 3]), ['public.a'])
        assert.deepEqual(parseRelationSelection(''), [])
        assert.deepEqual(parseRelationSelection('choose an option'), [])
        assert.deepEqual(parseRelationSelection(undefined), [])
    })

    it('writes one short line per relation with name, kind, column names and comment', () => {
        assert.equal(
            relationLine(sample[0]),
            'public.monthly_sales (materialized view): month, store, product, category, units, revenue — Shop sales per month, shop and product.'
        )
        assert.equal(relationLine(sample[1]), 'public.stores (table): id, name, town, opened_on')
        assert.equal(
            relationLine({ name: 'public.empty', kind: 'view', columns: 0, comment: 'No columns' }),
            'public.empty (view): No columns'
        )
        assert.ok(relationLine(sample[2]).length < 160, 'a long comment is cut')
        assert.equal(relationLine({ name: 'public.unknown', kind: '', columns: 0, comment: '' }), 'public.unknown')
    })

    it('lists at most 12 column names in a line, then an ellipsis', () => {
        assert.equal(relationLine(wide), `public.wide (table): ${wide.columnNames.slice(0, 12).join(', ')}, …`)
        assert.equal(columnList(wide, 60), wide.columnNames.join(', '))
    })

    it('puts the lines, with column names but not types, into the query tool', () => {
        const spec = analystUrlToolSpec(100, sample)
        const note = spec.description.slice(spec.description.indexOf(' Only these relations'))
        assert.equal(note.split('\n').length, 1 + sample.length)
        assert.match(note, /- public\.stores \(table\): id, name, town, opened_on$/m)
        assert.match(spec.description, /Call describe with a name for column types/)
        assert.equal(analystUrlToolSpec(100).description.includes('Only these relations'), false, 'no selection keeps the old text')
        assert.match(relationToolNote([]), /None of the selected/)
        assert.deepEqual(analystDescribeToolSpec().schema.required, ['name'])
    })

    it('matches a describe name with or without the schema, and only within the selection', () => {
        assert.equal(findRelation(sample, 'stores')?.name, 'public.stores')
        assert.equal(findRelation(sample, 'public.STORES')?.name, 'public.stores')
        assert.equal(findRelation(sample, '"Odd Name".daily')?.name, '"Odd Name".daily')
        assert.equal(findRelation(sample, 'payroll_notes'), null)
        assert.equal(findRelation(sample, ''), null)
    })

    it('collects relation, function and operator ids, and ignores ids written inside names', () => {
        const tree =
            '({QUERY :rtable ({RANGETBLENTRY :alias <> :eref {ALIAS :aliasname x\\ :relid\\ 999 :colnames ()} :rtekind 0 :relid 16385 :relkind r}' +
            ' {RANGETBLENTRY :rtekind 1 :relid 0}) :targetList ({TARGETENTRY :expr {FUNCEXPR :funcid 2078} :resname y\\ :funcid\\ 1}' +
            ' {OPEXPR :opno 96 :opfuncid 65} {AGGREF :aggfnoid 2803} {WINDOWFUNC :winfnoid 3100} {ROWCOMPARE :opnos (o 664 666)}' +
            ' {SORTGROUPCLAUSE :eqop 98 :sortop 664})})'
        const ids = treeObjectIds(tree)
        assert.deepEqual([...ids.relations], [16385])
        assert.deepEqual(
            [...ids.functions].sort((a, b) => a - b),
            [65, 2078, 2803, 3100]
        )
        assert.deepEqual(
            [...ids.operators].sort((a, b) => a - b),
            [96, 98, 664, 666]
        )
    })

    it('denies built-ins that run SQL text, read by name, or change settings', () => {
        for (const name of ['query_to_xml', 'table_to_xml', 'set_config', 'lo_get', 'pg_read_file', 'dblink_exec', 'ts_stat']) {
            assert.equal(deniedFunction(name), true, name)
        }
        for (const name of ['count', 'sum', 'date_trunc', 'coalesce', 'lower', 'pg_typeof', 'pg_column_size']) {
            assert.equal(deniedFunction(name), false, name)
        }
    })

    it('denies type-input probes, metadata about other objects, and acting on other sessions', () => {
        const denied = [
            'pg_input_is_valid',
            'pg_input_error_info',
            'obj_description',
            'col_description',
            'shobj_description',
            'pg_stat_get_live_tuples',
            'pg_stat_get_activity',
            'pg_relation_size',
            'pg_total_relation_size',
            'pg_table_size',
            'pg_indexes_size',
            'pg_relation_filepath',
            'pg_get_indexdef',
            'has_table_privilege',
            'pg_table_is_visible',
            'to_regclass',
            'pg_terminate_backend',
            'pg_cancel_backend'
        ]
        for (const name of denied) assert.equal(deniedFunction(name), true, name)
    })

    it('collects type ids, including lists, wrapped lines and enum fields that name no type', () => {
        const tree =
            '{CONST :consttype 23 :consttypmod -1} {VAR :vartype\n1043} {RTE :coltypes (o 25 1700)} :jointype 0 :row_typeid 2249 x\\ :consttype\\ 9'
        assert.deepEqual(
            [...treeObjectIds(tree).types].sort((a, b) => a - b),
            [23, 25, 1043, 1700, 2249]
        )
    })

    it('reads a tree in linear time, including long runs of whitespace after a list opener', () => {
        const hostile = `:types\t(o\t${'\t\t'.repeat(100000)}x :coltypes (o 23 ${' '.repeat(100000)}25)`
        const started = process.hrtime.bigint()
        const ids = treeObjectIds(hostile)
        const ms = Number(process.hrtime.bigint() - started) / 1e6
        assert.ok(ms < 500, `${ms} ms`)
        assert.deepEqual(
            [...ids.types].sort((a, b) => a - b),
            [23, 25]
        )
        assert.deepEqual([...treeObjectIds(':coltypes (o) :vartype 1043 :opnos (o 96').types], [1043])
        assert.deepEqual([...treeObjectIds(':opnos (o 96').operators], [96])
    })

    it('names the columns of the selected relations a failed statement mentions, only for column errors', () => {
        const undefinedColumn = { code: '42703' }
        assert.equal(
            columnErrorHint(undefinedColumn, 'SELECT total FROM monthly_sales m JOIN stores s ON s.name = m.store', sample),
            ' Columns of public.monthly_sales: month, store, product, category, units, revenue. Columns of public.stores: id, name, town, opened_on.'
        )
        assert.equal(
            columnErrorHint({ code: '42702' }, 'SELECT name FROM public.STORES', sample),
            ' Columns of public.stores: id, name, town, opened_on.'
        )
        assert.equal(columnErrorHint(undefinedColumn, 'SELECT * FROM "Odd Name".daily', sample), ' Columns of "Odd Name".daily: "Day".')
        assert.equal(
            columnErrorHint(undefinedColumn, 'SELECT store_count FROM monthly_sales_old', sample),
            '',
            'a longer name is not a match'
        )
        assert.equal(columnErrorHint({ code: '42601' }, 'SELECT FROM stores', sample), '', 'a syntax error gets no hint')
        assert.equal(
            columnErrorHint(undefinedColumn, 'SELECT c99 FROM wide', [wide]),
            ` Columns of public.wide: ${wide.columnNames.join(', ')}.`
        )
    })

    it('stops an error column list at 60 names, with one ellipsis and no period after it', () => {
        const widest = { ...wide, name: 'public.widest', columns: 70, columnNames: Array.from({ length: 70 }, (_, i) => `c${i + 1}`) }
        const hint = columnErrorHint({ code: '42703' }, 'SELECT c99 FROM widest JOIN stores USING (id)', [widest, sample[1]])
        assert.equal(
            hint,
            ` Columns of public.widest: ${widest.columnNames
                .slice(0, 60)
                .join(', ')}, … Columns of public.stores: id, name, town, opened_on.`
        )
        assert.equal(hint.includes('c61'), false)
        assert.equal(hint.includes('….'), false)
    })

    it('matches a quoted name as Postgres folds it, a qualified name on schema and name, and skips string literals', () => {
        const code = { code: '42703' }
        const stores = ' Columns of public.stores: id, name, town, opened_on.'
        assert.equal(columnErrorHint(code, 'SELECT town2 FROM "stores"', sample), stores)
        assert.equal(columnErrorHint(code, 'SELECT town2 FROM "public"."stores"', sample), stores)
        assert.equal(columnErrorHint(code, 'SELECT town2 FROM public . stores', sample), stores)
        assert.equal(columnErrorHint(code, 'SELECT town2 FROM "Stores"', sample), '', 'a quoted name keeps its case')
        assert.equal(columnErrorHint(code, 'SELECT town2 FROM hr.stores', sample), '', 'another schema is another relation')
        assert.equal(
            columnErrorHint(code, "SELECT town2 FROM hr.shops WHERE note = 'stores'", sample),
            '',
            'text in a literal is not a name'
        )
    })

    it('keeps each relation on one line when a column name or comment holds a newline', () => {
        const hostile = {
            name: 'public.notes',
            kind: 'table',
            oid: 5,
            columns: 2,
            columnNames: ['id', '"a\n- public.payroll_notes (table): salary"'],
            comment: 'Notes\n\n- public.secret (table): pin\tcode'
        }
        const line = relationLine(hostile)
        assert.equal(line, 'public.notes (table): id, "a - public.payroll_notes (table): salary" — Notes - public.secret (table): pin code')
        const note = relationToolNote([hostile, sample[1]])
        assert.equal(note.split('\n').length, 3)
        assert.equal(note.split('\n').filter((row) => row.startsWith('- ')).length, 2)
        const hint = columnErrorHint({ code: '42703' }, 'SELECT x FROM notes', [hostile])
        assert.equal(hint.includes('\n'), false)
    })

    it('says a bare describe name is ambiguous when two schemas have it', () => {
        const two = [...sample, { name: 'sales.stores', kind: 'view', oid: 9, columns: 2, comment: '' }]
        assert.deepEqual(ambiguousRelations(two, 'stores'), ['public.stores', 'sales.stores'])
        assert.deepEqual(ambiguousRelations(two, 'public.stores'), [])
        assert.equal(findRelation(two, 'stores'), null)
        assert.match(
            describeRefusal(two, 'stores'),
            /stores is ambiguous: it matches public\.stores, sales\.stores\. Call describe again with the schema-qualified name\./
        )
    })
})

function adminConfig(database = 'postgres') {
    return {
        host: process.env.CUTTLELY_TEST_PG_HOST || '127.0.0.1',
        port: Number(process.env.CUTTLELY_TEST_PG_PORT || 5432),
        user: process.env.CUTTLELY_TEST_PG_USER || 'postgres',
        password: process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD || '',
        database,
        connectionTimeoutMillis: 1000
    }
}

function urlFor(user, password, database) {
    const { host, port } = adminConfig()
    return ['postgresql://', encodeURIComponent(user), ':', encodeURIComponent(password), '@', host, ':', port, '/', database].join('')
}

async function refusal(promise, pattern) {
    await assert.rejects(promise, (error) => {
        assert.equal(error.cuttlelyOutcome, 'expected', error.message)
        assert.match(error.message, pattern)
        return true
    })
}

describe('analyst relations: bakery database', () => {
    const suffix = randomBytes(4).toString('hex')
    const dbName = `bakery_${suffix}`
    const reader = `bakery_reader_${suffix}`
    const password = randomBytes(18).toString('base64url')
    let admin = null
    let url = ''
    let citext = false

    before(async () => {
        const client = new Client(adminConfig())
        try {
            await client.connect()
        } catch (error) {
            await client.end().catch(() => {})
            if (process.env.CUTTLELY_TEST_PG_REQUIRED === '1')
                throw new Error(`CUTTLELY_TEST_PG_REQUIRED is set and Postgres is not reachable: ${error.message}`)
            return
        }
        admin = client
        await admin.query(`CREATE DATABASE "${dbName}"`)
        await admin.query(`CREATE ROLE "${reader}" LOGIN PASSWORD '${password}'`)
        const owner = new Client(adminConfig(dbName))
        await owner.connect()
        await owner.query(fs.readFileSync(BAKERY_SQL, 'utf8'))
        await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${reader}"`)
        await owner.query(`GRANT USAGE ON SCHEMA public TO "${reader}"`)
        // A user function and operator: the scope check refuses both, since either can read any table.
        await owner.query(`CREATE FUNCTION public.note_count() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM payroll_notes'`)
        await owner.query(`CREATE FUNCTION public.bakery_eq(integer, integer) RETURNS boolean LANGUAGE sql AS 'SELECT $1 = $2'`)
        await owner.query(`CREATE OPERATOR public.=== (LEFTARG = integer, RIGHTARG = integer, FUNCTION = public.bakery_eq)`)
        // A second schema with a relation of the same name, and names describe has to quote.
        await owner.query(`CREATE SCHEMA sales`)
        await owner.query(`CREATE VIEW sales.stores AS SELECT id, name FROM public.stores`)
        await owner.query(`CREATE TABLE public."Price List" (id integer PRIMARY KEY, "Unit Price" numeric(8, 2), "select" text)`)
        await owner.query(`GRANT USAGE ON SCHEMA sales TO "${reader}"`)
        await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA sales, public TO "${reader}"`)
        await owner.query(`CREATE TABLE public.not_readable (id integer)`)
        // A domain with a built-in, non-volatile check is not risky, so the database keeps answering.
        await owner.query(`CREATE DOMAIN public.safe_qty AS integer CHECK (VALUE >= 0)`)
        try {
            await owner.query('CREATE EXTENSION IF NOT EXISTS citext')
            citext = true
        } catch {
            citext = false
        }
        await owner.end()
        url = urlFor(reader, password, dbName)
    })

    after(async () => {
        if (!admin) return
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
        await admin.query(`DROP ROLE IF EXISTS "${reader}"`).catch(() => {})
        await admin.end().catch(() => {})
    })

    const skipped = (t) => {
        if (admin) return false
        t.skip('local postgres admin is not reachable')
        return true
    }

    it('lists readable tables, views and materialized views, views first, with column counts and comments', async (t) => {
        if (skipped(t)) return
        const relations = await listAnalystUrlRelations(url)
        const kinds = relations.map((relation) => relation.kind)
        const rank = { 'materialized view': 0, view: 1, table: 2 }
        assert.deepEqual(
            kinds.map((kind) => rank[kind]),
            [...kinds.map((kind) => rank[kind])].sort((a, b) => a - b),
            'materialized views first, then views, then tables'
        )
        assert.deepEqual(kinds.slice(0, 2), ['materialized view', 'materialized view'])
        assert.equal(kinds.filter((kind) => kind === 'view').length, 5)
        const balances = relations.find((relation) => relation.name === 'public.account_balances')
        assert.equal(balances.columns, 6)
        assert.match(balances.comment, /account_code first/)
        assert.equal(
            relations.some((relation) => relation.name === 'public.not_readable'),
            false,
            'a table this login cannot read is not listed'
        )
    })

    it('runs a query over selected relations, including a selected view over unselected tables', async (t) => {
        if (skipped(t)) return
        const balance = await queryAnalystUrl(
            url,
            {
                sql: "SELECT b.balance_due FROM wholesale_accounts a JOIN account_balances b ON b.account_id = a.id WHERE a.account_code = 'WA-1004'"
            },
            { relations: SELECTION }
        )
        assert.equal(balance.rows.length, 1)
        const dup = await queryAnalystUrl(url, 'SELECT * FROM stores s, stores t', { relations: SELECTION })
        assert.equal(dup.rows.length, 4, 'a result with repeated column names still runs')
    })

    it('adds the column list of a mentioned selected relation to an undefined or ambiguous column error', async (t) => {
        if (skipped(t)) return
        const options = { relations: SELECTION }
        const columns = /Columns of public\.top_products: product, units, rank\./
        await refusal(queryAnalystUrl(url, 'SELECT product, revenue FROM top_products ORDER BY rank', options), columns)
        await refusal(
            queryAnalystUrl(
                url,
                'SELECT t.product, m.revenue FROM top_products t JOIN monthly_sales m ON m.product_name = t.product',
                options
            ),
            /column m\.product_name does not exist\. Columns of public\.monthly_sales: month, store, product, category, units, revenue\. Columns of public\.top_products/
        )
        await refusal(
            queryAnalystUrl(url, 'SELECT units FROM top_products JOIN monthly_sales USING (product)', options),
            /ambiguous.*Columns of/
        )
        await assert.rejects(queryAnalystUrl(url, 'SELECT FROM WHERE top_products', options), (error) => {
            assert.equal(error.message.includes('Columns of'), false, 'a syntax error gets no column list')
            return true
        })
    })

    it('refuses a query that reads an unselected relation, however it is written', async (t) => {
        if (skipped(t)) return
        const options = { relations: SELECTION }
        const outside = /does not include/
        await refusal(queryAnalystUrl(url, 'SELECT * FROM payroll_notes', options), /reads public\.payroll_notes/)
        await refusal(queryAnalystUrl(url, 'SELECT * FROM public.invoices', options), outside)
        await refusal(queryAnalystUrl(url, 'WITH x AS (SELECT * FROM staff) SELECT * FROM x', options), outside)
        await refusal(queryAnalystUrl(url, 'SELECT (SELECT count(*) FROM orders) FROM stores', options), outside)
        await refusal(queryAnalystUrl(url, 'SELECT * FROM stores WHERE id IN (SELECT store_id FROM shifts)', options), outside)
        await refusal(queryAnalystUrl(url, 'SELECT count(*) FROM pg_catalog.pg_class', options), /pg_class/)
        await refusal(queryAnalystUrl(url, 'SELECT * FROM information_schema.columns', options), outside)
        await refusal(queryAnalystUrl(url, "SELECT 'payroll_notes'::regclass", options), outside)
        await refusal(queryAnalystUrl(url, 'TABLE payroll_notes', options), outside)
    })

    it('refuses functions and operators that could reach other data, and anything but a read', async (t) => {
        if (skipped(t)) return
        const options = { relations: SELECTION }
        await refusal(queryAnalystUrl(url, "SELECT query_to_xml('SELECT * FROM payroll_notes', true, true, '')", options), /query_to_xml/)
        await refusal(queryAnalystUrl(url, "SELECT set_config('search_path', 'pg_temp', true), * FROM stores", options), /set_config/)
        await refusal(queryAnalystUrl(url, 'SELECT public.note_count()', options), /function public\.note_count is not built in/)
        await refusal(queryAnalystUrl(url, 'SELECT * FROM stores WHERE id === 1', options), /operator public\.=== is not built in/)
        await refusal(queryAnalystUrl(url, 'DELETE FROM stores', options), new RegExp(SCOPE_ONLY_SELECT.slice(0, 40)))
        await refusal(queryAnalystUrl(url, 'SHOW search_path', options), /only SELECT/)
        await refusal(queryAnalystUrl(url, 'WITH d AS (DELETE FROM stores RETURNING *) SELECT * FROM d', options), /data-modifying/)
        await refusal(queryAnalystUrl(url, 'SELECT 1; SELECT * FROM payroll_notes', options), /one statement/)
        await refusal(queryAnalystUrl(url, 'SELECT * FROM stores FOR UPDATE', options), /read-only/)
        const left = await new Client(adminConfig(dbName))
        await left.connect()
        const views = await left.query("SELECT count(*)::int AS n FROM pg_class WHERE relname = 'cuttlely_scope_check'")
        await left.end()
        assert.equal(views.rows[0].n, 0, 'the check view does not outlive its transaction')
    })

    it('pages a capped result under a selection, and checks the cursor replay too', async (t) => {
        if (skipped(t)) return
        const scope = `bakery:${suffix}`
        const first = await queryAnalystUrl(url, 'SELECT month, store, product, units FROM monthly_sales ORDER BY 1, 2, 3', {
            relations: SELECTION,
            rowCap: 10,
            scope
        })
        assert.equal(first.rows.length, 10)
        assert.ok(first.cursor)
        const next = await queryAnalystUrl(url, { cursor: first.cursor }, { relations: SELECTION, rowCap: 10, scope })
        assert.equal(next.rows.length, 10)
        assert.notDeepEqual(next.rows[0], first.rows[0])
        await refusal(
            queryAnalystUrl(url, { cursor: first.cursor }, { relations: ['public.stores'], rowCap: 10, scope }),
            /monthly_sales, which this node's table selection does not include/
        )
    })

    it('keeps today behavior when nothing is selected', async (t) => {
        if (skipped(t)) return
        const notes = await queryAnalystUrl(url, 'SELECT count(*)::int AS n FROM payroll_notes', { relations: [] })
        assert.equal(notes.rows[0].n, 1)
        await refusal(queryAnalystUrl(url, 'DELETE FROM payroll_notes'), /read-only/)
    })

    it('refuses everything when no selected relation exists any more', async (t) => {
        if (skipped(t)) return
        await refusal(
            queryAnalystUrl(url, 'SELECT 1', { relations: ['public.gone', 'not a name'] }),
            new RegExp(SCOPE_NONE_LEFT.slice(0, 30))
        )
        await refusal(describeAnalystUrlRelation(url, { name: 'gone' }, ['public.gone']), /None of the selected/)
    })

    it('describes one selected relation: columns, keys, relationships among selected relations, view definition', async (t) => {
        if (skipped(t)) return
        const view = await describeAnalystUrlRelation(url, { name: 'account_balances' }, SELECTION)
        assert.equal(view.name, 'public.account_balances')
        assert.equal(view.kind, 'view')
        assert.match(view.comment, /account_code first/)
        assert.deepEqual(view.columns.slice(0, 2), ['account_id integer', 'account_code text'])
        assert.match(view.definition, /FROM wholesale_accounts a/)
        assert.deepEqual(view.relationships, ['reads public.wholesale_accounts'], 'invoices is not selected, so it is not named')

        const table = await describeAnalystUrlRelation(url, { name: 'public.wholesale_accounts' }, SELECTION)
        assert.equal(table.columns[1], 'account_code text not null -- Code printed on invoices, such as WA-1004')
        assert.deepEqual(table.primaryKey, ['id'])
        assert.equal(table.definition, undefined)
        assert.deepEqual(table.relationships, ['read by public.account_balances'])

        const keyed = await describeAnalystUrlRelation(url, { name: 'orders' }, [...SELECTION, 'public.orders'])
        assert.deepEqual(keyed.relationships, [
            'public.orders(account_id) -> public.wholesale_accounts(id)',
            'public.orders(store_id) -> public.stores(id)'
        ])
        const matview = await describeAnalystUrlRelation(url, { name: 'monthly_sales' }, SELECTION)
        assert.equal(matview.kind, 'materialized view')
        assert.match(matview.definition, /date_trunc/)
    })

    it('refuses to describe a relation that is not selected', async (t) => {
        if (skipped(t)) return
        await refusal(describeAnalystUrlRelation(url, { name: 'payroll_notes' }, SELECTION), /not one of the selected/)
        await refusal(describeAnalystUrlRelation(url, { name: 'pg_class' }, SELECTION), /not one of the selected/)
    })

    it('asks for the schema when a bare describe name is ambiguous, and quotes column names', async (t) => {
        if (skipped(t)) return
        const both = [...SELECTION, 'sales.stores', 'public."Price List"']
        await refusal(
            describeAnalystUrlRelation(url, { name: 'stores' }, both),
            /stores is ambiguous: it matches sales\.stores, public\.stores\. Call describe again with the schema-qualified name\./
        )
        assert.equal((await describeAnalystUrlRelation(url, { name: 'sales.stores' }, both)).name, 'sales.stores')
        const odd = await describeAnalystUrlRelation(url, { name: 'Price List' }, both)
        assert.equal(odd.name, 'public."Price List"')
        assert.deepEqual(odd.columns, ['id integer not null', '"Unit Price" numeric(8,2)', '"select" text'])
    })

    it('refuses metadata about other relations, object-id types, and acting on other sessions', async (t) => {
        if (skipped(t)) return
        const options = { relations: SELECTION }
        const notAllowed = /is not allowed while a table selection is set/
        const local = new Client(adminConfig(dbName))
        await local.connect()
        const oid = (await local.query(`SELECT 'payroll_notes'::regclass::oid::int8 AS oid`)).rows[0].oid
        await local.end()
        for (const sql of [
            `SELECT obj_description(${oid})`,
            `SELECT col_description(${oid}, 1)`,
            `SELECT shobj_description(1, 'pg_database')`,
            `SELECT pg_stat_get_live_tuples(${oid})`,
            `SELECT * FROM pg_stat_get_activity(NULL)`,
            `SELECT pg_relation_size(${oid})`,
            `SELECT pg_total_relation_size(${oid})`,
            `SELECT pg_table_size(${oid})`,
            `SELECT pg_indexes_size(${oid})`,
            `SELECT has_table_privilege('payroll_notes', 'SELECT')`,
            `SELECT pg_terminate_backend(pg_backend_pid())`,
            `SELECT pg_cancel_backend(pg_backend_pid())`
        ]) {
            await refusal(queryAnalystUrl(url, sql, options), notAllowed)
        }
        await refusal(queryAnalystUrl(url, `SELECT ${oid}::regclass`, options), /type regclass is not allowed/)
        await refusal(queryAnalystUrl(url, `SELECT to_regclass('payroll_notes')`, options), /to_regclass is not allowed|type regclass/)
    })

    it('refuses a type whose input or output function is outside pg_catalog, and runs a domain with a built-in check', async (t) => {
        if (skipped(t)) return
        const options = { relations: SELECTION }
        const result = await queryAnalystUrl(
            url,
            'SELECT 3::safe_qty AS qty, name::text, ARRAY[id], ROW(id, name) FROM stores ORDER BY id',
            options
        )
        assert.equal(result.rows.length, 2)
        assert.equal(result.rows[0].qty, 3)
        if (!citext) {
            t.skip('the citext extension is not available on this server')
            return
        }
        await refusal(queryAnalystUrl(url, "SELECT 'Riverside'::citext", options), /type citext is not built in/)
    })

    it('rejects a call cleanly when its backend is terminated mid-query', async (t) => {
        if (skipped(t)) return
        const running = queryAnalystUrl(url, 'SELECT pg_sleep(10) AS slept', { statementTimeoutMs: 20000 })
        // The kill can land during the first poll, before assert.rejects attaches its handler.
        running.catch(() => {})
        for (let i = 0; i < 50; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100))
            const killed = await admin.query(
                "SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE datname = $1 AND query LIKE '%pg_sleep(10)%' AND pid <> pg_backend_pid()",
                [dbName]
            )
            if (killed.rows.length) break
        }
        await assert.rejects(running, (error) => {
            assert.equal(error.cuttlelyOutcome, 'transport', error.message)
            return true
        })
    })

    it('keeps the prompt to one line per selected relation, far below the whole schema', async (t) => {
        if (skipped(t)) return
        const everything = await listAnalystUrlRelations(url)
        const allNames = everything.map((relation) => relation.name)
        const described = []
        for (const name of allNames) described.push(await describeAnalystUrlRelation(url, { name }, allNames))
        const wholeSchema = JSON.stringify(described)
        const selected = await analystUrlRelations(url, SELECTION)
        const scoped = analystUrlToolSpec(100, selected).description
        const plain = analystUrlToolSpec(100).description
        const describeSpec = JSON.stringify(analystDescribeToolSpec())
        const added = tokens(scoped) - tokens(plain) + tokens(describeSpec)
        assert.equal(scoped.split('\n').length, 1 + SELECTION.length)
        assert.match(
            scoped,
            /- public\.account_balances \(view\): account_id, account_code, name, credit_limit, unpaid_invoices, balance_due — /
        )
        for (const type of ['numeric', 'bigint', 'integer']) assert.equal(scoped.includes(type), false, `${type}: types stay in describe`)
        assert.ok(added * 3 < tokens(wholeSchema), `${added} tokens added, whole schema ${tokens(wholeSchema)}`)
        const allLines = analystUrlToolSpec(100, await analystUrlRelations(url, allNames)).description
        assert.ok(tokens(allLines) - tokens(plain) < tokens(wholeSchema) / 3, 'even every relation as one line stays well under the schema')
    })

    it('the node lists relations and adds describe only when a selection exists', async (t) => {
        if (skipped(t)) return
        if (!fs.existsSync(NODE_BUILD) || fs.statSync(NODE_BUILD).mtimeMs < fs.statSync(NODE_SOURCE).mtimeMs) {
            t.skip('the components build is missing or older than PostgreSQLMCP.ts')
            return
        }
        const { nodeClass } = createRequire(import.meta.url)(NODE_BUILD)
        const node = new nodeClass()
        const input = node.inputs.find((param) => param.name === 'analystRelations')
        assert.equal(input.type, 'asyncMultiOptions')
        assert.equal(input.checkboxList, true)
        assert.equal(input.loadMethod, 'listRelations')

        const plain = await node.urlTools(url, {}, [])
        assert.deepEqual(
            plain.map((tool) => tool.name),
            ['query']
        )
        const scoped = await node.urlTools(url, {}, SELECTION)
        assert.deepEqual(
            scoped.map((tool) => tool.name),
            ['query', 'describe']
        )
        assert.match(scoped[0].description, /public\.account_balances \(view\): account_id, account_code,/)
        const refused = JSON.parse(await scoped[0].invoke({ sql: 'SELECT * FROM payroll_notes' }))
        assert.equal(refused.cuttlelyOutcome, 'expected')
        const described = JSON.parse(await scoped[1].invoke({ name: 'stores' }))
        assert.equal(described.name, 'public.stores')

        const previous = process.env.CUTTLELY_POSTGRES_URL
        process.env.CUTTLELY_POSTGRES_URL = url
        try {
            const options = await node.loadMethods.listRelations({ inputs: {}, credential: '' }, {})
            assert.equal(options[0].label, 'public.monthly_sales')
            assert.match(options[0].description, /^materialized view · 6 columns · /)
        } finally {
            if (previous === undefined) delete process.env.CUTTLELY_POSTGRES_URL
            else process.env.CUTTLELY_POSTGRES_URL = previous
        }
    })
})

// A database whose domains could run code while a statement is parsed refuses every scoped query up front.
function riskyDatabase(label, setupSql) {
    const suffix = randomBytes(4).toString('hex')
    const state = { admin: null, url: '', dbName: `bakery_${label}_${suffix}`, reader: `bakery_${label}_reader_${suffix}` }
    const password = randomBytes(18).toString('base64url')
    before(async () => {
        const client = new Client(adminConfig())
        try {
            await client.connect()
        } catch (error) {
            await client.end().catch(() => {})
            if (process.env.CUTTLELY_TEST_PG_REQUIRED === '1')
                throw new Error(`CUTTLELY_TEST_PG_REQUIRED is set and Postgres is not reachable: ${error.message}`)
            return
        }
        state.admin = client
        await client.query(`CREATE DATABASE "${state.dbName}"`)
        await client.query(`CREATE ROLE "${state.reader}" LOGIN PASSWORD '${password}'`)
        const owner = new Client(adminConfig(state.dbName))
        await owner.connect()
        await owner.query(`
            CREATE TABLE public.stores (id integer PRIMARY KEY, name text NOT NULL);
            INSERT INTO public.stores VALUES (1, 'Riverside'), (2, 'Old Town');
            CREATE TABLE public.payroll_notes (note text);
            INSERT INTO public.payroll_notes VALUES ('Made-up payroll note');
            ${setupSql}
        `)
        await owner.query(`GRANT USAGE ON SCHEMA public TO "${state.reader}"`)
        await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${state.reader}"`)
        await owner.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "${state.reader}"`)
        await owner.end()
        state.url = urlFor(state.reader, password, state.dbName)
        resetRiskyDomainCacheForTests()
    })
    after(async () => {
        if (!state.admin) return
        await state.admin.query(`DROP DATABASE IF EXISTS "${state.dbName}" WITH (FORCE)`).catch(() => {})
        await state.admin.query(`DROP ROLE IF EXISTS "${state.reader}"`).catch(() => {})
        await state.admin.end().catch(() => {})
    })
    state.skipped = (t) => {
        if (state.admin) return false
        t.skip('local postgres admin is not reachable')
        return true
    }
    state.sequence = async (name) => {
        const owner = new Client(adminConfig(state.dbName))
        await owner.connect()
        try {
            const row = (await owner.query(`SELECT last_value::int8 AS value, is_called FROM public.${name}`)).rows[0]
            return `${row.value}:${row.is_called}`
        } finally {
            await owner.end()
        }
    }
    state.refusedText = async (sql) => {
        let text = ''
        await assert.rejects(queryAnalystUrl(state.url, sql, { relations: ['public.stores'] }), (error) => {
            assert.equal(error.cuttlelyOutcome, 'expected', error.message)
            assert.equal(error.message.includes('payroll note'), false, `${sql} leaked: ${error.message}`)
            text = error.message
            return true
        })
        return text
    }
    return state
}

describe('analyst relations: risky domain checks', () => {
    const db = riskyDatabase(
        'domains',
        `
        CREATE SEQUENCE public.bump_seq;
        CREATE SEQUENCE public.builtin_seq;
        -- Raises with a row from a table that is not selected, for any value above 0.
        CREATE FUNCTION public.quiet_check(v integer) RETURNS boolean LANGUAGE plpgsql AS $f$
            BEGIN IF v > 0 THEN RAISE EXCEPTION 'leak: %', (SELECT note FROM public.payroll_notes LIMIT 1); END IF; RETURN true; END $f$;
        CREATE DOMAIN public.quiet_ref AS integer CHECK (public.quiet_check(VALUE));
        -- Advances a sequence, which a rollback does not undo.
        CREATE FUNCTION public.bump_check(v integer) RETURNS boolean LANGUAGE sql AS $f$ SELECT nextval('public.bump_seq') > 0 $f$;
        CREATE DOMAIN public.bump_ref AS integer CHECK (public.bump_check(VALUE));
        CREATE DOMAIN public.builtin_bump AS integer CHECK (nextval('public.builtin_seq') > 0);
        CREATE DOMAIN public.oid_ref AS text CHECK (VALUE::regclass IS NOT NULL);
        CREATE DOMAIN public.safe_qty AS integer CHECK (VALUE >= 0);
    `
    )
    const expected =
        /this database has domains whose CHECK could run other code or change data while a query is checked: public\.builtin_bump, public\.bump_ref, public\.oid_ref, public\.quiet_ref\. Queries are refused while a table selection is set\./

    it('refuses every query, naming the risky domains and not the safe one', async (t) => {
        if (db.skipped(t)) return
        const text = await db.refusedText('SELECT name FROM stores')
        assert.match(text, expected)
        assert.equal(text.includes('safe_qty'), false)
    })

    it('leaves describe values out while a risky domain refuses queries', async (t) => {
        if (db.skipped(t)) return
        const stores = await describeAnalystUrlRelation(db.url, { name: 'stores' }, ['public.stores'])
        assert.equal(stores.values, undefined)
        assert.deepEqual(stores.columns, ['id integer not null', 'name text not null'])
        assert.equal(await db.sequence('bump_seq'), '1:false', 'the sample check did not run a domain check')
    })

    it('answers a passing and a failing check value with the same text', async (t) => {
        if (db.skipped(t)) return
        const zero = await db.refusedText("SELECT '{0}'::quiet_ref[]")
        const five = await db.refusedText("SELECT '{5}'::quiet_ref[]")
        assert.equal(zero, five)
        assert.match(five, expected)
        assert.equal(await db.refusedText('SELECT 5::quiet_ref'), five)
        assert.equal(await db.refusedText("SELECT pg_input_is_valid('5', 'quiet_ref')"), five)
    })

    it('does not run a domain check that calls nextval, through a user function or directly', async (t) => {
        if (db.skipped(t)) return
        const before = [await db.sequence('bump_seq'), await db.sequence('builtin_seq')]
        resetRiskyDomainCacheForTests()
        for (const sql of ["SELECT '{1}'::bump_ref[]", 'SELECT 1::bump_ref', "SELECT '{1}'::builtin_bump[]", 'SELECT 1::builtin_bump']) {
            assert.match(await db.refusedText(sql), expected)
        }
        assert.deepEqual([await db.sequence('bump_seq'), await db.sequence('builtin_seq')], before)
    })
})

describe('analyst relations: describe sample values on a made-up household budget', () => {
    const db = riskyDatabase(
        'budget',
        `
        CREATE TYPE public.spend_kind AS ENUM ('Fixed', 'Variable');
        CREATE TABLE public.categories (id integer PRIMARY KEY, name text NOT NULL);
        INSERT INTO public.categories VALUES (1, 'Hidden Category A'), (2, 'Hidden Category B');
        CREATE TABLE public.budget_lines (
            id integer PRIMARY KEY, category text, kind public.spend_kind, payee varchar(40), code character(3),
            note text, amount numeric(8, 2)
        );
        INSERT INTO public.budget_lines
        SELECT n,
               (ARRAY['Groceries', 'Rent', '  Utilities ', 'Utilities'])[1 + n % 4],
               (ARRAY['Fixed', 'Variable'])[1 + n % 2]::public.spend_kind,
               'Payee ' || n,
               (ARRAY['GRO', 'RNT'])[1 + n % 2],
               'A long made-up note that is well past the forty character sample limit ' || (n % 2),
               n * 1.25
        FROM generate_series(1, 30) AS n;
        CREATE VIEW public.monthly_spend AS
            SELECT c.name AS category_name, b.category, sum(b.amount) AS total
            FROM public.budget_lines b JOIN public.categories c ON c.id = 1 + b.id % 2 GROUP BY 1, 2;
        -- slow_total runs far past the sample timeout. It comes first, so a timeout that dropped the rest would show.
        CREATE VIEW public.slow_mix AS
            SELECT (SELECT count(*)::text FROM generate_series(1, 100000) a, generate_series(1, 100000) b) AS slow_total,
                   category AS fast_category
            FROM public.budget_lines;
    `
    )

    it('returns capped samples, exactly as stored, for short low-cardinality text columns only', async (t) => {
        if (db.skipped(t)) return
        const lines = await describeAnalystUrlRelation(db.url, { name: 'budget_lines' }, ['public.budget_lines'])
        assert.deepEqual(lines.values, {
            category: ['  Utilities ', 'Groceries', 'Rent', 'Utilities'],
            kind: ['Fixed', 'Variable'],
            code: ['GRO', 'RNT']
        })
        assert.equal('payee' in lines.values, false, 'thirty distinct payees is not low cardinality')
        assert.equal('note' in lines.values, false, 'a long value leaves the column out')
        assert.equal('amount' in lines.values, false, 'numbers are not sampled')
        assert.equal(JSON.stringify(lines).includes('Hidden Category'), false)
    })

    it('never samples a relation that is not ticked', async (t) => {
        if (db.skipped(t)) return
        await refusal(describeAnalystUrlRelation(db.url, { name: 'categories' }, ['public.budget_lines']), /not one of the selected/)
        const lines = await describeAnalystUrlRelation(db.url, { name: 'public.budget_lines' }, [
            'public.budget_lines',
            'public.monthly_spend'
        ])
        assert.equal(JSON.stringify(lines).includes('Hidden Category'), false, 'a ticked view next to it adds no values')
    })

    it('samples the output of a ticked view the way the query tool could read it', async (t) => {
        if (db.skipped(t)) return
        const view = await describeAnalystUrlRelation(db.url, { name: 'monthly_spend' }, ['public.monthly_spend'])
        assert.deepEqual(view.values.category_name, ['Hidden Category A', 'Hidden Category B'])
        const rows = await queryAnalystUrl(db.url, 'SELECT DISTINCT category_name FROM monthly_spend ORDER BY 1', {
            relations: ['public.monthly_spend']
        })
        assert.deepEqual(
            rows.rows.map((row) => row.category_name),
            view.values.category_name
        )
    })

    it('samples a short name column on a small table', async (t) => {
        if (db.skipped(t)) return
        const stores = await describeAnalystUrlRelation(db.url, { name: 'stores' }, ['public.stores'])
        assert.deepEqual(stores.values, { name: ['Old Town', 'Riverside'] })
    })

    it('skips only the column whose sample times out', async (t) => {
        if (db.skipped(t)) return
        const started = Date.now()
        const mix = await describeAnalystUrlRelation(db.url, { name: 'slow_mix' }, ['public.slow_mix'])
        assert.ok(Date.now() - started >= SAMPLE_TIMEOUT_MS - 50, 'the slow column ran into its timeout')
        assert.deepEqual(mix.values, { fast_category: ['  Utilities ', 'Groceries', 'Rent', 'Utilities'] })
        assert.deepEqual(mix.columns, ['slow_total text', 'fast_category text'])
    })
})

describe('analyst relations: describe samples on a login without TEMP', () => {
    const db = riskyDatabase(
        'notemp',
        `
        DO $d$ BEGIN EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()); END $d$;
    `
    )

    it('leaves values out, the same way query refuses, and still describes the columns', async (t) => {
        if (db.skipped(t)) return
        await refusal(queryAnalystUrl(db.url, 'SELECT name FROM stores', { relations: ['public.stores'] }), /could not check this query/)
        const stores = await describeAnalystUrlRelation(db.url, { name: 'stores' }, ['public.stores'])
        assert.equal(stores.values, undefined)
        assert.deepEqual(stores.columns, ['id integer not null', 'name text not null'])
    })
})

describe('analyst relations: a built-in volatile domain check alone', () => {
    const db = riskyDatabase(
        'nextval',
        `
        CREATE SEQUENCE public.only_seq;
        CREATE DOMAIN public.next_ref AS integer CHECK (nextval('public.only_seq') > 0);
    `
    )

    it('counts a domain whose check calls built-in nextval as risky, and leaves the sequence alone', async (t) => {
        if (db.skipped(t)) return
        const before = await db.sequence('only_seq')
        const text = await db.refusedText("SELECT '{1}'::next_ref[]")
        assert.match(text, /could run other code or change data while a query is checked: public\.next_ref\./)
        assert.equal(await db.refusedText('SELECT name FROM stores'), text)
        assert.equal(await db.sequence('only_seq'), before)
    })
})
