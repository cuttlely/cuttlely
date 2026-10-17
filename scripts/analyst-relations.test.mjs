import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import {
    SCOPE_MASKED,
    SCOPE_NONE_LEFT,
    SCOPE_ONLY_SELECT,
    ambiguousRelations,
    deniedFunction,
    describeRefusal,
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
    { name: 'public.monthly_sales', kind: 'materialized view', oid: 1, columns: 6, comment: 'Shop sales per month, shop and product.' },
    { name: 'public.stores', kind: 'table', oid: 2, columns: 4, comment: '' },
    { name: '"Odd Name".daily', kind: 'view', oid: 3, columns: 1, comment: 'x'.repeat(300) }
]

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

    it('writes one short line per relation with name, kind, column count and comment', () => {
        assert.equal(
            relationLine(sample[0]),
            'public.monthly_sales (materialized view, 6 columns): Shop sales per month, shop and product.'
        )
        assert.equal(relationLine(sample[1]), 'public.stores (table, 4 columns)')
        assert.equal(relationLine({ name: 'public.one', kind: 'view', columns: 1, comment: '' }), 'public.one (view, 1 column)')
        assert.ok(relationLine(sample[2]).length < 160, 'a long comment is cut')
        assert.equal(relationLine({ name: 'public.unknown', kind: '', columns: 0, comment: '' }), 'public.unknown')
    })

    it('puts the lines, and nothing about columns, into the query tool', () => {
        const spec = analystUrlToolSpec(100, sample)
        const note = spec.description.slice(spec.description.indexOf(' Only these relations'))
        assert.equal(note.split('\n').length, 1 + sample.length)
        assert.match(spec.description, /Call describe/)
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

    it('rejects a call cleanly when its backend is terminated mid-query', async (t) => {
        if (skipped(t)) return
        const running = queryAnalystUrl(url, 'SELECT pg_sleep(10) AS slept', { statementTimeoutMs: 20000 })
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
        for (const name of ['credit_limit', 'balance_due', 'week_start']) assert.equal(scoped.includes(name), false, name)
        assert.ok(added * 5 < tokens(wholeSchema), `${added} tokens added, whole schema ${tokens(wholeSchema)}`)
        const allLines = analystUrlToolSpec(100, everything).description
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
        assert.match(scoped[0].description, /public\.account_balances \(view, 6 columns\)/)
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

describe('analyst relations: domain checks and types', () => {
    const suffix = randomBytes(4).toString('hex')
    const dbName = `bakery_types_${suffix}`
    const reader = `bakery_types_reader_${suffix}`
    const password = randomBytes(18).toString('base64url')
    let admin = null
    let url = ''
    let citext = false
    const options = { relations: ['public.stores'] }

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
        await owner.query(`
            CREATE TABLE public.stores (id integer PRIMARY KEY, name text NOT NULL);
            INSERT INTO public.stores VALUES (1, 'Riverside'), (2, 'Old Town');
            CREATE TABLE public.payroll_notes (note text);
            INSERT INTO public.payroll_notes VALUES ('Made-up payroll note');
            -- The check raises with a row from a table that is not selected in its message.
            CREATE FUNCTION public.leak_check(v integer) RETURNS boolean LANGUAGE plpgsql AS $f$
                BEGIN RAISE EXCEPTION 'leak: %', (SELECT note FROM public.payroll_notes LIMIT 1); END $f$;
            CREATE DOMAIN public.store_ref AS integer CHECK (public.leak_check(VALUE));
            CREATE DOMAIN public.outer_ref AS public.store_ref;
            CREATE TYPE public.store_pair AS (a integer, b public.store_ref);
            CREATE DOMAIN public.builtin_leak AS text CHECK (length(query_to_xml('SELECT 1', true, true, '')::text) > 0);
            CREATE DOMAIN public.safe_qty AS integer CHECK (VALUE >= 0);
        `)
        try {
            await owner.query('CREATE EXTENSION IF NOT EXISTS citext')
            citext = true
        } catch {
            citext = false
        }
        await owner.query(`GRANT USAGE ON SCHEMA public TO "${reader}"`)
        await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${reader}"`)
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

    const noLeak = async (sql, pattern) => {
        await assert.rejects(queryAnalystUrl(url, sql, options), (error) => {
            assert.equal(error.cuttlelyOutcome, 'expected', error.message)
            assert.equal(error.message.includes('payroll note'), false, `${sql} leaked: ${error.message}`)
            assert.match(error.message, pattern, sql)
            return true
        })
    }

    it('refuses a cast to a domain whose check calls a user function, directly or through another domain or an array', async (t) => {
        if (skipped(t)) return
        const domain = /domain store_ref checks its values with public\.leak_check, which is not built in/
        await noLeak('SELECT 1::store_ref', domain)
        await noLeak('SELECT 1::outer_ref', domain)
        await noLeak('SELECT ARRAY[1]::store_ref[]', domain)
        await noLeak('SELECT CAST(id AS store_ref) FROM stores', domain)
        await noLeak('SELECT ROW(1, 2)::store_pair', domain)
    })

    it('does not show the database error when a literal runs such a check while it is parsed', async (t) => {
        if (skipped(t)) return
        await noLeak("SELECT '(1,2)'::store_pair", new RegExp(SCOPE_MASKED.slice(0, 60).replace(/[.()]/g, '\\$&')))
        await noLeak("SELECT '{1}'::store_ref[]", /database error is not shown/)
        await refusal(queryAnalystUrl(url, 'SELECT nme FROM stores', options), /column "nme" does not exist/)
    })

    it('refuses type-input probes and a domain whose check calls a denied built-in', async (t) => {
        if (skipped(t)) return
        // Postgres 16 added both functions. Before that the call fails as an unknown function.
        const version = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num)
        const probe = (name) => (version >= 160000 ? new RegExp(`${name} is not allowed`) : /does not exist/)
        await noLeak("SELECT pg_input_is_valid('1', 'store_ref')", probe('pg_input_is_valid'))
        await noLeak("SELECT * FROM pg_input_error_info('1', 'store_ref')", probe('pg_input_error_info'))
        await noLeak(
            "SELECT 'x'::builtin_leak",
            /domain builtin_leak checks its values with something refused here\. query_to_xml is not allowed/
        )
    })

    it('refuses a type whose input or output function is outside pg_catalog', async (t) => {
        if (skipped(t)) return
        if (!citext) {
            t.skip('the citext extension is not available on this server')
            return
        }
        await noLeak("SELECT 'Riverside'::citext", /type citext is not built in/)
    })

    it('still runs domains with built-in checks and ordinary types', async (t) => {
        if (skipped(t)) return
        const result = await queryAnalystUrl(
            url,
            'SELECT 3::safe_qty AS qty, name::text, ARRAY[id], ROW(id, name) FROM stores ORDER BY id',
            options
        )
        assert.equal(result.rows.length, 2)
        assert.equal(result.rows[0].qty, 3)
    })
})
